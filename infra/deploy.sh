#!/usr/bin/env bash
#
# deploy.sh — pull, back up, build, migrate, start, verify, and roll back on failure.
#
#   ./infra/deploy.sh              normal deploy
#   ./infra/deploy.sh --no-pull    deploy the working tree as-is (use after a manual fix)
#   ./infra/deploy.sh --skip-backup   skip the pre-migration dump (NOT recommended)
#
# Containers: web, db, caddy, plus the profile-gated one-shot `migrate`.
#
# Idempotent and safe to re-run after a partial failure; a lock prevents concurrent runs.
# Every step logs a UTC timestamp.
#
# Rollback restores the previous image only. Migrations are forward-only, so if a failed
# deploy already changed the schema, also restore the pre-deploy dump (its path is printed
# on failure).

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
		# Removed flag; give a specific error instead of "Unknown option".
		echo "--allow-degraded-worker was removed with the worker container. There is no worker to degrade; drop the flag and re-run." >&2
		exit 2
		;;
	-h | --help)
		sed -n '2,16p' "${BASH_SOURCE[0]}"
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
# Concurrent deploys would race on the :previous tag. Fail fast rather than queue.
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
	die "The docker compose plugin is missing. Install it: sudo apt-get install -y docker-compose-plugin"
docker info >/dev/null 2>&1 ||
	die "Cannot talk to the Docker daemon. Either it is not running (sudo systemctl start docker) or this user is not in the docker group (newgrp docker)."
log "docker: $(docker --version)"
log "compose: $(docker compose version --short)"

[ -f "${COMPOSE_FILE}" ] || die "Missing ${COMPOSE_FILE}"
[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}. Copy .env.example to .env and fill it in."

# .env is sourced below, so refuse command substitution in values. Comment lines are
# skipped (the example's docs use backticks).
if grep -vE '^[[:space:]]*(#|$)' "${ENV_FILE}" | grep -Eq '(\$\(|`)'; then
	die ".env has command substitution (\$( or a backtick) in a value. Remove it — .env must be literal values only."
fi

# .env holds secrets.
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

# Check required variables by name for a clearer error than compose would give.
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

# Older .env files may still have these; warn only.
for stale_var in REDIS_URL REDIS_PASSWORD REDIS_MAXMEMORY WORKER_HEALTH_PORT; do
	if [ -n "${!stale_var:-}" ]; then
		warn "${stale_var} is set in .env and nothing reads it. The redis and worker containers were removed. The line is safe to delete."
	fi
done

IMAGE_NAME="${IMAGE_NAME:-app-web}"
IMAGE_TAG="${IMAGE_TAG:-current}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}" # seconds to wait for /api/health after start
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

# The build needs room for the pnpm store, node_modules, .next and two image copies.
AVAIL_KB="$(df -Pk "${REPO_DIR}" | awk 'NR==2 {print $4}')"
AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
log "Free disk on $(df -Ph "${REPO_DIR}" | awk 'NR==2 {print $6}'): ${AVAIL_GB} GB"
if [ "${AVAIL_GB}" -lt 3 ]; then
	die "Only ${AVAIL_GB} GB free. A build needs ~3 GB of headroom. Reclaim space first: docker system prune -af --filter 'until=168h'"
fi

# `next build` is the usual cause of an OOM kill (exit 137).
TOTAL_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
SWAP_MB="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
log "Memory: ${TOTAL_MB} MB RAM, ${SWAP_MB} MB swap"
if [ "${TOTAL_MB}" -lt 2400 ] && [ "${SWAP_MB}" -lt 1024 ]; then
	warn "Under 2.4 GB RAM and less than 1 GB of swap. 'next build' is likely to be OOM-killed (exit 137)."
	warn "Create swap before continuing: fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
fi

# Validate the compose file against the loaded environment before anything mutates state.
"${COMPOSE[@]}" config --quiet ||
	die "docker-compose.prod.yml failed validation with the current .env. Nothing has been changed."
log "Compose configuration validates."

# =======================================================================================
# 2. Record the rollback point
# =======================================================================================
# Before pull and build, so :previous is the image that was actually serving. Idempotent.
step "Recording rollback point"

ROLLBACK_AVAILABLE=0
WEB_CID="$("${COMPOSE[@]}" ps -q web 2>/dev/null || true)"
if [ -n "${WEB_CID}" ]; then
	PREV_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${WEB_CID}")"
	docker image tag "${PREV_IMAGE_ID}" "${IMAGE_NAME}:previous"
	ROLLBACK_AVAILABLE=1
	log "Running image ${PREV_IMAGE_ID} tagged as ${IMAGE_NAME}:previous"
elif docker image inspect "${IMAGE_NAME}:previous" >/dev/null 2>&1; then
	# web isn't running, but an earlier rollback tag exists; keep it.
	ROLLBACK_AVAILABLE=1
	log "web is not running; keeping the existing ${IMAGE_NAME}:previous as the rollback point."
else
	log "No previously running image. This looks like a first deploy — rollback will not be available."
fi

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
	# --ff-only: never merge on the server; divergence needs a human.
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
# Migrations can't be rolled back, so dump first (before the build, too).
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
# `migrate` is profile-gated, so build it explicitly or migrations use a stale image.
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
		# --no-build to use the retagged image. Recreate caddy too so it drops connections to
		# the replaced container.
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
	warn "To triage: docker compose -f ${COMPOSE_FILE} ps, then check logs for web, db and caddy."
	exit 1
}

# =======================================================================================
# 6. Start the database and wait for it to be genuinely ready
# =======================================================================================
step "Starting the database"
# Explicitly first, so a db failure is reported as such.
"${COMPOSE[@]}" up -d db || rollback "starting db"

log "Waiting for Postgres to report healthy (pg_isready)..."
DB_CID="$("${COMPOSE[@]}" ps -q db)"
[ -n "${DB_CID}" ] || rollback "starting db (no container id)"
# docker inspect: compose ps --format templates vary across plugin versions.
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
# One-shot container. Re-running is a no-op (Drizzle's journal).
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

# From inside the container, so DNS and TLS don't affect the result.
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
# Shows which sources will actually fetch data. Connectors ship disabled (most also draft),
# so a fresh deploy has every live surface off by design. Report only; never fails the deploy.
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

# SQL on stdin to avoid nested quoting. Single-quoted so credentials expand inside the db
# container and never reach this host's process list or log. stderr is kept.
if printf '%s\n' "${CONNECTOR_BOARD_SQL}" | "${COMPOSE[@]}" exec -T db sh -c \
	'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -P pager=off -v ON_ERROR_STOP=1 -f -'; then
	# `changed_utc` is maintained by a trigger, so psql edits count too.
	log "LIVE = enabled AND published AND has both terms_url and legal_basis (lib/connectors/liveness.ts)."
	log "No LIVE rows on a fresh deploy is the SHIPPED STATE, not a fault. Enable a source with: update connectors set enabled = true where slug = '<slug>'"
else
	warn "Could not read the connector board from the database. The deploy is NOT rolled back:"
	warn "the app is provably healthy, and this is a report rather than a control. Check:"
	warn "  docker compose -f ${COMPOSE_FILE} exec -T db sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"select count(*) from connectors\"'"
	warn "If the table is empty, the seed has not been run: docker compose -f ${COMPOSE_FILE} --profile tools run --rm migrate pnpm db:seed"
fi

# Public path through Caddy. Failure here is DNS/firewall/TLS, not the app: no rollback.
if command -v curl >/dev/null 2>&1; then
	if curl -fsS --max-time 20 -o /dev/null "https://${DOMAIN}/api/health"; then
		log "Public health check passed: https://${DOMAIN}/api/health"
	else
		warn "The app is healthy but https://${DOMAIN}/api/health is not reachable from this host."
		warn "The deploy is NOT rolled back — this is an edge problem, not an app problem. Check:"
		warn "  dig +short ${DOMAIN}            # does it point here?"
		warn "  sudo ufw status                 # are 80 and 443 open?"
		warn "  docker compose -f ${COMPOSE_FILE} logs --tail=100 caddy   # certificate issuance"
	fi
else
	warn "curl is not installed; skipping the public check. Install it: sudo apt-get install -y curl"
fi

# =======================================================================================
# 10. Warm the ISR cache
# =======================================================================================
# The image is built without a database, so ISR pages are prerendered empty. Request each
# page so it regenerates before real visitors arrive. Non-fatal.
step "Warming the ISR cache"
WARM_PATHS="/ /directory /playbooks /live /methodology /about"
for path in ${WARM_PATHS}; do
	# From inside web (no host port). Twice: the first triggers regeneration.
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
# Dangling layers only; `prune -a` would delete :previous.
docker image prune -f >/dev/null
log "Dangling build layers removed. ${IMAGE_NAME}:previous is preserved."

"${COMPOSE[@]}" ps

step "Deploy complete"
log "Commit:  $(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "Image:   ${IMAGE_NAME}:${IMAGE_TAG}"
if [ "${ROLLBACK_AVAILABLE}" -eq 1 ]; then
	log "Rollback available: yes  ->  docker image tag ${IMAGE_NAME}:previous ${IMAGE_NAME}:${IMAGE_TAG} && docker compose -f ${COMPOSE_FILE} up -d --no-build --force-recreate web caddy"
else
	log "Rollback available: no (first deploy)"
fi
# `if`, not `[ ... ] && log`: a false test there would make the script exit non-zero.
if [ -n "${BACKUP_PATH}" ]; then
	log "Pre-deploy backup: ${BACKUP_PATH}"
fi
log "Live at: https://${DOMAIN}"
exit 0
