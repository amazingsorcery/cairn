#!/usr/bin/env bash
#
# deploy.sh — pull, back up, build, migrate, start, verify, and roll back on failure.
#
#   ./infra/deploy.sh              normal deploy
#   ./infra/deploy.sh --no-pull    deploy the working tree as-is (use after a manual fix)
#   ./infra/deploy.sh --skip-backup   skip the pre-migration dump (NOT recommended)
#
# THREE CONTAINERS: web, db, caddy - plus the profile-gated one-shot `migrate`. There used
# to be a `--allow-degraded-worker` flag whose only purpose was to finish a deploy past a
# `worker` container that could never start. ADR 0031 removed the container, so the flag is
# gone too; passing it now is a named error rather than a silent no-op.
#
# Design contract:
#   * IDEMPOTENT. Running it twice in a row is a no-op deploy that ends healthy. Every
#     step is either naturally repeatable (git pull --ff-only, docker build, compose up)
#     or explicitly guarded (image retagging, migrations).
#   * SAFE AFTER A PARTIAL FAILURE. A run that died between "build" and "migrate" leaves
#     images and containers in a state the next run can reason about: nothing is deleted,
#     the previous image tag is only moved when there is a genuinely new image to replace
#     it, and a lock stops two runs from interleaving.
#   * LOUD. Every step prints a UTC timestamp and what it did, so `deploy.log` is a
#     usable post-mortem.
#
# What it CANNOT do: undo a database migration. Drizzle migrations are forward-only.
# Rollback here restores the previous *image*; if the failed deploy's migration already
# changed the schema in a way the old image cannot read, you must also restore the dump
# this script took immediately before migrating. The script prints that dump's path on
# every failure path for exactly this reason.

set -euo pipefail

# --- Locations -------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

COMPOSE_FILE="${REPO_DIR}/docker-compose.prod.yml"
ENV_FILE="${REPO_DIR}/.env"

# --- Options ---------------------------------------------------------------------------
DO_PULL=1
DO_BACKUP=1
for arg in "$@"; do
	case "${arg}" in
	--no-pull) DO_PULL=0 ;;
	--skip-backup) DO_BACKUP=0 ;;
	--allow-degraded-worker)
		# Named explicitly rather than falling through to "Unknown option", because it was a
		# documented flag and somebody's shell history still has it. ADR 0031.
		echo "--allow-degraded-worker was removed with the worker container (ADR 0031). There is no worker to degrade; drop the flag and re-run." >&2
		exit 2
		;;
	-h | --help)
		sed -n '2,30p' "${BASH_SOURCE[0]}"
		exit 0
		;;
	*)
		echo "Unknown option: ${arg}" >&2
		exit 2
		;;
	esac
done

# --- Logging ---------------------------------------------------------------------------
log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
step() { printf '\n%s  ==> %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
warn() { printf '%s  WARN %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die() {
	printf '%s  FATAL %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
	exit 1
}

# --- Single-instance lock ---------------------------------------------------------------
# Two concurrent deploys would race on the :previous image tag and could leave the rollback
# pointing at the image that is already broken. flock -n fails immediately rather than
# queueing, because a queued deploy of an older commit is worse than no deploy.
LOCK_FILE="/tmp/deploy.$(basename "${REPO_DIR}").lock"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
	die "Another deploy is already running (lock: ${LOCK_FILE}). Wait for it, or investigate with: ps -ef | grep deploy.sh"
fi

# =======================================================================================
# 1. Preflight
# =======================================================================================
step "Preflight"

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
docker compose version >/dev/null 2>&1 ||
	die "The docker compose plugin is missing. Install docker-compose-plugin (see RUNBOOK 'Install Docker')."
docker info >/dev/null 2>&1 ||
	die "Cannot talk to the Docker daemon. Either it is not running (sudo systemctl start docker) or this user is not in the docker group (newgrp docker)."
log "docker: $(docker --version)"
log "compose: $(docker compose version --short)"

[ -f "${COMPOSE_FILE}" ] || die "Missing ${COMPOSE_FILE}"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}. Copy .env.example to .env and fill it in."

# .env must be shell-sourceable, because we source it below. Command substitution in a
# VALUE would execute as this user during deploy, so refuse it outright rather than
# discover it the interesting way.
#
# Comment lines are stripped first. .env.example documents several commands in prose and
# uses backticks for inline code, so scanning the raw file would reject a perfectly good
# .env for its own documentation.
if grep -vE '^[[:space:]]*(#|$)' "${ENV_FILE}" | grep -Eq '(\$\(|`)'; then
	die ".env has command substitution (\$( or a backtick) in a value. Remove it — .env must be literal values only."
fi

# Permissions. .env holds AUTH_SECRET, the database password and SMTP credentials.
ENV_PERMS="$(stat -c '%a' "${ENV_FILE}")"
if [ "${ENV_PERMS}" != "600" ] && [ "${ENV_PERMS}" != "400" ]; then
	warn ".env is mode ${ENV_PERMS}; it holds secrets. Fixing to 600."
	chmod 600 "${ENV_FILE}"
fi

# Load it. `set -a` exports everything defined while it is on.
set -a
# shellcheck disable=SC1090  # path is computed, and the file is validated above.
. "${ENV_FILE}"
set +a

# Required variables. Checked by name so the error says which one, rather than compose
# failing later with a substitution error.
for var in DOMAIN ACME_EMAIL POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL AUTH_SECRET APP_URL; do
	if [ -z "${!var:-}" ]; then
		die "Required variable ${var} is empty in .env"
	fi
	case "${!var}" in
	*CHANGEME* | *REPLACE_ME* | *example.invalid*)
		die "${var} still holds a placeholder value (${!var}). Set a real value; see .env.example."
		;;
	esac
done
log "Environment: DOMAIN=${DOMAIN}  APP_URL=${APP_URL}"

# A .env carried over from a v2 deploy will still carry REDIS_URL and WORKER_HEALTH_PORT.
# They are harmless - nothing reads them - but saying so here is cheaper than an operator
# wondering whether their cache is silently broken. A warning, not a refusal: declining to
# deploy over a stale line in a .env would be the wrong severity.
for stale_var in REDIS_URL REDIS_PASSWORD REDIS_MAXMEMORY WORKER_HEALTH_PORT; do
	if [ -n "${!stale_var:-}" ]; then
		warn "${stale_var} is set in .env and nothing reads it. The redis and worker containers were removed (ADR 0031). The line is safe to delete."
	fi
done

IMAGE_NAME="${IMAGE_NAME:-app-web}"
IMAGE_TAG="${IMAGE_TAG:-current}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}" # seconds to wait for /api/health after start
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

# Disk. A build needs room for the pnpm store, node_modules, the .next output and two
# copies of the image. Running out mid-build leaves dangling layers and a confusing error,
# and running out later stops Postgres accepting writes.
AVAIL_KB="$(df -Pk "${REPO_DIR}" | awk 'NR==2 {print $4}')"
AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
log "Free disk on $(df -Ph "${REPO_DIR}" | awk 'NR==2 {print $6}'): ${AVAIL_GB} GB"
if [ "${AVAIL_GB}" -lt 3 ]; then
	die "Only ${AVAIL_GB} GB free. A build needs ~3 GB of headroom. Reclaim space first: docker system prune -af --filter 'until=168h'"
fi

# Memory. `next build` is the single biggest consumer on this box and is the usual cause
# of a deploy that dies with an unhelpful exit 137 (OOM-killed).
TOTAL_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
SWAP_MB="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
log "Memory: ${TOTAL_MB} MB RAM, ${SWAP_MB} MB swap"
if [ "${TOTAL_MB}" -lt 2400 ] && [ "${SWAP_MB}" -lt 1024 ]; then
	warn "Under 2.4 GB RAM and less than 1 GB of swap. 'next build' is likely to be OOM-killed (exit 137)."
	warn "Create swap before continuing — see RUNBOOK 'Swap file'."
fi

# Validate the compose file against the loaded environment before anything mutates state.
"${COMPOSE[@]}" config --quiet ||
	die "docker-compose.prod.yml failed validation with the current .env. Nothing has been changed."
log "Compose configuration validates."

# =======================================================================================
# 2. Record the rollback point
# =======================================================================================
# Done BEFORE the pull and the build, so the recorded image is genuinely the one that was
# serving traffic. Retagging is idempotent: re-running on an unchanged deployment simply
# points :previous at the same image again.
step "Recording rollback point"

ROLLBACK_AVAILABLE=0
WEB_CID="$("${COMPOSE[@]}" ps -q web 2>/dev/null || true)"
if [ -n "${WEB_CID}" ]; then
	PREV_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${WEB_CID}")"
	docker image tag "${PREV_IMAGE_ID}" "${IMAGE_NAME}:previous"
	ROLLBACK_AVAILABLE=1
	log "Running image ${PREV_IMAGE_ID} tagged as ${IMAGE_NAME}:previous"
elif docker image inspect "${IMAGE_NAME}:previous" >/dev/null 2>&1; then
	# The web container is not running (first deploy, or a previous deploy left it down)
	# but a rollback tag survives from an earlier run. Keep it.
	ROLLBACK_AVAILABLE=1
	log "web is not running; keeping the existing ${IMAGE_NAME}:previous as the rollback point."
else
	log "No previously running image. This looks like a first deploy — rollback will not be available."
fi

# ONE rollback tag, because one long-running image ships. v2 kept a second for the worker
# and rolled both together; ADR 0031 removed the worker, and with it the dual-image rollback
# - which HANDOFF register 37 correctly called the least-exercised new code in this script,
# running only when everything else had already gone wrong.

GIT_BEFORE="$(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
log "Current commit: ${GIT_BEFORE}"

# =======================================================================================
# 3. Update the source
# =======================================================================================
if [ "${DO_PULL}" -eq 1 ]; then
	step "Pulling source"
	if [ -n "$(git -C "${REPO_DIR}" status --porcelain)" ]; then
		git -C "${REPO_DIR}" status --short >&2
		die "The working tree has uncommitted changes (above). Commit, stash, or run with --no-pull."
	fi
	BRANCH="$(git -C "${REPO_DIR}" rev-parse --abbrev-ref HEAD)"
	# --ff-only: refuse to create a merge commit on the server. If this fails, the server
	# has diverged from origin and a human needs to look, not a script.
	git -C "${REPO_DIR}" pull --ff-only origin "${BRANCH}"
	GIT_AFTER="$(git -C "${REPO_DIR}" rev-parse --short HEAD)"
	if [ "${GIT_BEFORE}" = "${GIT_AFTER}" ]; then
		log "Already up to date at ${GIT_AFTER}."
	else
		log "Updated ${GIT_BEFORE} -> ${GIT_AFTER} on ${BRANCH}."
	fi
else
	step "Skipping git pull (--no-pull)"
fi

# =======================================================================================
# 4. Back up the database BEFORE migrating
# =======================================================================================
# This is the only thing standing between a bad migration and permanent data loss, because
# migrations cannot be rolled back. It runs before the build so that a build failure does
# not leave you without a fresh dump.
BACKUP_PATH=""
if [ "${DO_BACKUP}" -eq 1 ]; then
	step "Backing up the database"
	if [ -n "$("${COMPOSE[@]}" ps -q db 2>/dev/null || true)" ]; then
		if BACKUP_PATH="$("${SCRIPT_DIR}/backup.sh" --quiet --label pre-deploy)"; then
			log "Backup written to ${BACKUP_PATH}"
		else
			die "Backup failed. Refusing to migrate without one. Fix the backup first, or accept the risk explicitly with --skip-backup."
		fi
	else
		log "db container is not running (first deploy) — nothing to back up yet."
	fi
else
	warn "Skipping the pre-migration backup (--skip-backup). A failed migration will not be recoverable."
fi

# =======================================================================================
# 5. Build
# =======================================================================================
step "Building images"
# Two targets. `migrate` is behind the `tools` profile, so it must be named explicitly or
# compose will not build it, and the migration step below would then use a stale image.
"${COMPOSE[@]}" build web
"${COMPOSE[@]}" --profile tools build migrate
log "Build complete: ${IMAGE_NAME}:${IMAGE_TAG}"

# From here on, a failure should put the previous image back.
rollback() {
	local stage="$1"
	printf '\n'
	warn "=============================================================="
	warn "DEPLOY FAILED during: ${stage}"
	warn "=============================================================="
	if [ "${ROLLBACK_AVAILABLE}" -eq 1 ]; then
		warn "Rolling back to ${IMAGE_NAME}:previous"
		docker image tag "${IMAGE_NAME}:previous" "${IMAGE_NAME}:${IMAGE_TAG}"
		# --no-build so compose uses the retagged image instead of rebuilding the broken
		# source. --force-recreate so it does not decide the container is already correct.
		# `caddy` is recreated alongside `web` because it holds connections to the container
		# it dialled; leaving it pointed at one that is being replaced is a minute of 502s
		# for no reason.
		if "${COMPOSE[@]}" up -d --no-build --force-recreate web caddy; then
			warn "Previous image restarted. Verify manually:"
			warn "  docker compose -f ${COMPOSE_FILE} ps"
			warn "  curl -fsS https://${DOMAIN}/api/health"
		else
			warn "ROLLBACK ITSELF FAILED. The site is down. Read the logs:"
			warn "  docker compose -f ${COMPOSE_FILE} logs --tail=200 web"
		fi
	else
		warn "No rollback image is available. The site may be down."
		warn "  docker compose -f ${COMPOSE_FILE} logs --tail=200 web"
	fi

	if [ -n "${BACKUP_PATH}" ]; then
		warn ""
		warn "IMPORTANT — migrations are forward-only. If the failed deploy already applied a"
		warn "schema change, the restored image may not be able to read the database. In that"
		warn "case restore the pre-deploy dump as well:"
		warn "  ./infra/restore.sh ${BACKUP_PATH} --yes-i-am-sure"
	fi
	warn ""
	warn "See docs/deploy/RUNBOOK.md -> 'Triage'."
	exit 1
}

# =======================================================================================
# 6. Start the database and wait for it to be genuinely ready
# =======================================================================================
step "Starting the database"
# Before anything that depends on it. `web` declares `condition: service_healthy` on `db`,
# so compose would do this anyway - doing it explicitly means a failure here is reported as
# "the database would not start" rather than as "the stack would not start", which are
# different problems with different fixes.
"${COMPOSE[@]}" up -d db || rollback "starting db"

log "Waiting for Postgres to report healthy (pg_isready)..."
DB_CID="$("${COMPOSE[@]}" ps -q db)"
[ -n "${DB_CID}" ] || rollback "starting db (no container id)"
# docker inspect rather than `compose ps --format`: the Go-template form of compose's
# --format is not portable across compose plugin versions, and this must not break on a
# minor version bump six months from now.
DB_DEADLINE=$(($(date +%s) + 120))
until [ "$(docker inspect -f '{{.State.Health.Status}}' "${DB_CID}" 2>/dev/null || echo unknown)" = "healthy" ]; do
	if [ "$(date +%s)" -ge "${DB_DEADLINE}" ]; then
		"${COMPOSE[@]}" logs --tail=80 db >&2 || true
		rollback "waiting for db to become healthy (120s timeout; logs above)"
	fi
	sleep 3
done
log "Postgres is healthy."


# =======================================================================================
# 7. Migrate
# =======================================================================================
# One-shot container, removed afterwards. Drizzle records applied migrations in its own
# table, so re-running this is a no-op — which is what makes the whole script safe to
# re-run after a partial failure.
step "Running migrations"
if ! "${COMPOSE[@]}" --profile tools run --rm --no-deps migrate; then
	rollback "database migration"
fi
log "Migrations applied."

# =======================================================================================
# 8. Start everything
# =======================================================================================
step "Starting web and caddy"
"${COMPOSE[@]}" up -d --no-build --remove-orphans || rollback "starting the stack"

# =======================================================================================
# 9. Verify
# =======================================================================================
step "Verifying /api/health"

# Probed from INSIDE the container. This isolates "is the app up" from "is DNS correct"
# and "is the certificate issued", which are different problems with different fixes, and
# it works before DNS has propagated. `node -e` needs no tooling in the image.
HEALTH_DEADLINE=$(($(date +%s) + HEALTH_TIMEOUT))
HEALTH_OK=0
ATTEMPT=0
while [ "$(date +%s)" -lt "${HEALTH_DEADLINE}" ]; do
	ATTEMPT=$((ATTEMPT + 1))
	if "${COMPOSE[@]}" exec -T web node -e \
		"fetch('http://127.0.0.1:3000/api/health').then(async r=>{const b=await r.text();if(!r.ok){console.error(r.status,b);process.exit(1)}console.log(b);process.exit(0)}).catch(e=>{console.error(String(e));process.exit(1)})" 2>/dev/null; then
		HEALTH_OK=1
		break
	fi
	log "  health not ready yet (attempt ${ATTEMPT}); retrying in 5s"
	sleep 5
done

if [ "${HEALTH_OK}" -ne 1 ]; then
	warn "Last 80 lines of the web container log:"
	"${COMPOSE[@]}" logs --tail=80 web >&2 || true
	rollback "health check (no 200 from /api/health within ${HEALTH_TIMEOUT}s)"
fi
log "Internal health check passed."

# =======================================================================================
# 9b. Print the connector board
# =======================================================================================
# This replaced a worker health gate that could never pass (ADR 0031, QV-08). The question
# the gate was trying to answer - "is anything actually going to fetch data?" - still needs
# an answer, and with the poller gone the answer lives in one table.
#
# READ THIS OUTPUT ON EVERY DEPLOY, AND ESPECIALLY ON THE FIRST ONE. Every connector ships
# `enabled = false`, and eleven of the thirteen also ship `status = 'draft'` (ADR 0012 §1,
# fail closed). Both must be true for a source to call anything, so A FRESH DEPLOY HAS EVERY
# LIVE SURFACE SWITCHED OFF BY DESIGN: the map renders its layers as "an operator switched
# this source off", the Toolbench tools render the same, and nothing leaves the building.
# That is correct, not broken. RUNBOOK section 18.5 is the procedure for turning one on
# after reading its recorded legal basis.
#
# This is a report, never a gate. It cannot fail the deploy: an all-off board is the shipped
# state, and a board that refused to deploy would refuse the first deploy.
step "Connector board"

CONNECTOR_BOARD_SQL="
  select
    rpad(slug, 26)                                          as slug,
    case when enabled then 'on ' else 'OFF' end              as enabled,
    rpad(status, 10)                                        as status,
    case
      when enabled and status = 'published'
       and terms_url is not null and legal_basis is not null then 'LIVE'
      else '-'
    end                                                     as live,
    to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as changed_utc
  from connectors
  order by (enabled and status = 'published') desc, slug;
"

# SQL on stdin rather than inside `-c`, so there is one level of shell quoting to get right
# instead of three. The sh script is SINGLE-quoted: $POSTGRES_USER and $POSTGRES_PASSWORD
# are expanded by the shell inside the db container, from that container's own environment,
# and never appear in this host's process list or in deploy.log.
# stderr is NOT suppressed — if psql refuses, its own message is the diagnosis.
if printf '%s\n' "${CONNECTOR_BOARD_SQL}" | "${COMPOSE[@]}" exec -T db sh -c \
	'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -P pager=off -v ON_ERROR_STOP=1 -f -'; then
	# `changed_utc` is trustworthy however the row was written: migration 0007 puts a
	# BEFORE UPDATE trigger on `connectors`, so a kill-switch flipped with psql moves the
	# timestamp exactly as one flipped through the app does. That is the whole reason the
	# column is worth printing here.
	log "LIVE = enabled AND published AND has both terms_url and legal_basis (lib/connectors/liveness.ts)."
	log "No LIVE rows on a fresh deploy is the SHIPPED STATE, not a fault. See RUNBOOK section 18.5."
else
	warn "Could not read the connector board from the database. The deploy is NOT rolled back:"
	warn "the app is provably healthy, and this is a report rather than a control. Check:"
	warn "  docker compose -f ${COMPOSE_FILE} exec -T db sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"select count(*) from connectors\"'"
	warn "If the table is empty, the seed has not been run: see RUNBOOK section 6."
fi

# Public path: through Caddy, over TLS, from the outside. A failure here is NOT a reason
# to roll back — the application is provably healthy, so the problem is DNS, the firewall,
# or certificate issuance, and rolling the image back would fix none of them and would
# only lose the deploy.
if command -v curl >/dev/null 2>&1; then
	if curl -fsS --max-time 20 -o /dev/null "https://${DOMAIN}/api/health"; then
		log "Public health check passed: https://${DOMAIN}/api/health"
	else
		warn "The app is healthy but https://${DOMAIN}/api/health is not reachable from this host."
		warn "The deploy is NOT rolled back — this is an edge problem, not an app problem. Check:"
		warn "  dig +short ${DOMAIN}            # does it point here?"
		warn "  sudo ufw status                 # are 80 and 443 open?"
		warn "  docker compose -f ${COMPOSE_FILE} logs --tail=100 caddy   # certificate issuance"
		warn "  See RUNBOOK -> 'Certificate troubleshooting'."
	fi
else
	warn "curl is not installed; skipping the public check. Install it: sudo apt-get install -y curl"
fi

# =======================================================================================
# 10. Warm the ISR cache
# =======================================================================================
# The image is built with NO database, by design (ADR 0018) — a build that needs a live
# production database is not reproducible and cannot run on a clean CI runner. The
# consequence is that ISR pages are prerendered EMPTY at build time.
#
# Next serves the stale prerendered page on the first request and regenerates in the
# background, so without this step the first real visitor after every deploy sees an empty
# directory or an empty Live section, and only the second visitor sees the site. Requesting
# each page twice here means that visitor is us, not them.
#
# Deliberately non-fatal: a page that fails to warm is a cosmetic problem for one request,
# and failing a deploy that already passed its health check would be a worse trade.
step "Warming the ISR cache"
WARM_PATHS="/ /directory /playbooks /live /methodology /about"
for path in ${WARM_PATHS}; do
	# Requested from INSIDE the web container, the same way the health check is, because
	# `web` publishes no host port — only Caddy is exposed. Going through Caddy would work
	# too but would depend on DNS and a valid certificate, neither of which has anything to
	# do with warming a cache.
	#
	# Twice: the first request returns the stale empty page and triggers regeneration, the
	# second returns the regenerated one. The body is not parsed — the point is to make the
	# regeneration happen before a user arrives, not to assert on content.
	for _ in 1 2; do
		"${COMPOSE[@]}" exec -T web node -e 			"fetch('http://127.0.0.1:3000${path}').then(()=>process.exit(0)).catch(()=>process.exit(0))" 			>/dev/null 2>&1 || true
	done
	log "  warmed ${path}"
done

# =======================================================================================
# =======================================================================================
# 11. Tidy up
# =======================================================================================
step "Cleaning up"
# Only dangling (untagged, unreferenced) layers from this build. NOT `prune -a`, which
# would delete ${IMAGE_NAME}:previous and destroy the rollback path.
docker image prune -f >/dev/null
log "Dangling build layers removed. ${IMAGE_NAME}:previous is preserved."

"${COMPOSE[@]}" ps

step "Deploy complete"
log "Commit:  $(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "Image:   ${IMAGE_NAME}:${IMAGE_TAG}"
if [ "${ROLLBACK_AVAILABLE}" -eq 1 ]; then
	log "Rollback available: yes  ->  ./infra/deploy.sh is not the way back; see RUNBOOK 'Rolling back'"
else
	log "Rollback available: no (first deploy)"
fi
# `if`, not `[ ... ] && log ...`: under `set -e` a false test as the final command of an
# && list makes the script exit non-zero, turning a successful deploy into a reported
# failure. This exact line has bitten enough deploy scripts to be worth the comment.
if [ -n "${BACKUP_PATH}" ]; then
	log "Pre-deploy backup: ${BACKUP_PATH}"
fi
log "Live at: https://${DOMAIN}"
exit 0
