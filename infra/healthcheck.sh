#!/usr/bin/env bash
#
# healthcheck.sh — one command that answers "is this server all right?".
#
#   ./infra/healthcheck.sh          full report, exit 0 if everything passes
#   ./infra/healthcheck.sh --quiet  print nothing unless something FAILS (for cron)
#
# Exit code: 0 all checks passed, 1 at least one FAIL, 2 warnings only.
#
# Catches slow failures (disk filling, cert renewal failing, crash loops); run from a timer.

set -uo pipefail # no -e: every check must run even after one fails.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_DIR}/docker-compose.prod.yml"
ENV_FILE="${REPO_DIR}/.env"

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

FAILURES=0
WARNINGS=0
REPORT=""

emit() { REPORT+="$1"$'\n'; }
ok() { emit "  OK    $1"; }
warn() {
	emit "  WARN  $1"
	WARNINGS=$((WARNINGS + 1))
}
fail() {
	emit "  FAIL  $1"
	FAILURES=$((FAILURES + 1))
}

if [ -f "${ENV_FILE}" ]; then
	set -a
	# shellcheck disable=SC1090
	. "${ENV_FILE}"
	set +a
fi
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

emit "Health report — $(date -u '+%Y-%m-%dT%H:%M:%SZ') — $(hostname)"
emit ""

# --- Containers -------------------------------------------------------------------------
emit "Containers"
# Dependency order, so the cause is listed before its symptoms. `migrate` is one-shot and
# normally not running, so it's skipped.
for svc in db web caddy; do
	cid="$("${COMPOSE[@]}" ps -q "${svc}" 2>/dev/null)"
	if [ -z "${cid}" ]; then
		fail "${svc} is not running"
		continue
	fi
	state="$(docker inspect -f '{{.State.Status}}' "${cid}" 2>/dev/null)"
	health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null)"
	restarts="$(docker inspect -f '{{.RestartCount}}' "${cid}" 2>/dev/null)"

	if [ "${state}" != "running" ]; then
		fail "${svc} state=${state}"
	elif [ "${health}" = "unhealthy" ]; then
		fail "${svc} is running but UNHEALTHY"
	elif [ "${health}" = "starting" ]; then
		warn "${svc} health is still starting"
	else
		ok "${svc} running (health=${health}, restarts=${restarts})"
	fi

	# Up now but crash-looping.
	if [ "${restarts:-0}" -gt 5 ]; then
		warn "${svc} has restarted ${restarts} times — it is crash-looping. docker compose -f ${COMPOSE_FILE} logs --tail=100 ${svc}"
	fi
done

# --- Live sources -----------------------------------------------------------------------
# 1. Is anything switched on? Connectors ship disabled, so zero live is OK on a fresh deploy.
# 2. For live ones, what happened in the last 24 h (from `connector_requests`)?
# Same data as /admin/connectors, but usable over SSH when the app is down.
emit ""
emit "Live sources"

# SQL on stdin, single-quoted sh script: $POSTGRES_* expand inside the db container from its
# own environment and never reach this host's process list.
psql_q() {
	printf '%s\n' "$1" | "${COMPOSE[@]}" exec -T db sh -c \
		'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -v ON_ERROR_STOP=1 -f -' 2>/dev/null
}

live_count="$(psql_q "select count(*) from connectors
                       where enabled and status = 'published'
                         and terms_url is not null and legal_basis is not null;")"

if [ -z "${live_count}" ]; then
	fail "could not read the connectors table. Is db up, and has the seed been run? (docker compose -f ${COMPOSE_FILE} --profile tools run --rm migrate pnpm db:seed)"
elif [ "${live_count}" -eq 0 ]; then
	total="$(psql_q 'select count(*) from connectors;')"
	ok "no source is switched on (0 of ${total:-?} connectors are live). This is the SHIPPED STATE."
	emit "        Nothing is calling any upstream. The map and the Toolbench render an honest"
	emit "        'an operator switched this source off' on every live surface, by design."
	emit "        To turn one on, read its legal_basis, then set connectors.enabled = true."
else
	ok "${live_count} connector(s) are live"
	# One line per live source over 24 h. `disabled` isn't counted as bad.
	board="$(psql_q "select
	    rpad(c.slug, 26)
	    || ' attempts=' || lpad(count(*)::text, 5)
	    || ' out=' || lpad(coalesce(sum(r.upstream_requests), 0)::text, 5)
	    || ' ok=' || lpad(count(*) filter (where r.outcome = 'ok')::text, 5)
	    || ' bad=' || lpad(count(*) filter (where r.outcome not in ('ok', 'disabled'))::text, 4)
	    || ' last=' || coalesce(to_char(max(r.requested_at) at time zone 'UTC', 'MM-DD HH24:MI'), 'never')
	  from connectors c
	  left join connector_requests r
	    on r.connector_id = c.id and r.requested_at > now() - interval '24 hours'
	  where c.enabled and c.status = 'published'
	  group by c.slug
	  order by c.slug;")"
	if [ -n "${board}" ]; then
		# Process substitution, not a pipe: a piped loop runs in a subshell and loses REPORT.
		while IFS= read -r line; do
			[ -n "${line}" ] && emit "        ${line}"
		done < <(printf '%s\n' "${board}")
		emit "        bad = anything that is not 'ok' and not 'disabled': upstreamError, timeout,"
		emit "        schemaChanged, rateLimited, quotaDenied."
	fi

	# No attempts in 24 h may just mean nobody opened the page, so WARN only.
	silent="$(psql_q "select string_agg(c.slug, ', ' order by c.slug)
	  from connectors c
	  where c.enabled and c.status = 'published'
	    and not exists (
	      select 1 from connector_requests r
	       where r.connector_id = c.id and r.requested_at > now() - interval '24 hours'
	    );")"
	if [ -n "${silent}" ]; then
		warn "live but not attempted in 24 h: ${silent}. Either nobody opened the surface that uses it (normal on a quiet site), or that surface is broken. Open it and re-run."
	fi
fi

# --- Application ---------------------------------------------------------------------------
emit ""
emit "Application"
if "${COMPOSE[@]}" exec -T web node -e \
	"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
	ok "/api/health returns 200 from inside the container"
else
	fail "/api/health did not return 200 inside the container — the app cannot reach Postgres, or it is not up"
fi

if [ -n "${DOMAIN:-}" ] && command -v curl >/dev/null 2>&1; then
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/api/health" 2>/dev/null)"
	case "${code}" in
	200) ok "https://${DOMAIN}/api/health returns 200 from the public edge" ;;
	000) fail "https://${DOMAIN}/api/health is unreachable (DNS, firewall, or TLS). Check: dig +short ${DOMAIN}; sudo ufw status; docker compose -f ${COMPOSE_FILE} logs --tail=100 caddy" ;;
	*) fail "https://${DOMAIN}/api/health returned HTTP ${code}" ;;
	esac
fi

# --- TLS certificate -----------------------------------------------------------------------
# Caddy renews at 2/3 lifetime; under 30 days left means renewal is failing.
if [ -n "${DOMAIN:-}" ] && command -v openssl >/dev/null 2>&1; then
	emit ""
	emit "TLS"
	not_after="$(echo | openssl s_client -servername "${DOMAIN}" -connect "${DOMAIN}:443" 2>/dev/null |
		openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
	if [ -n "${not_after}" ]; then
		days=$((($(date -d "${not_after}" +%s) - $(date +%s)) / 86400))
		if [ "${days}" -lt 10 ]; then
			fail "certificate expires in ${days} days — renewal is failing. docker compose -f ${COMPOSE_FILE} logs caddy | grep -i acme"
		elif [ "${days}" -lt 30 ]; then
			warn "certificate expires in ${days} days; Caddy should have renewed by now. Check the caddy log."
		else
			ok "certificate valid for ${days} more days"
		fi
	else
		warn "could not read the certificate (the host may be unreachable from itself)"
	fi
fi

# --- Disk ----------------------------------------------------------------------------------
emit ""
emit "Disk"
disk_pct="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
disk_avail="$(df -Ph / | awk 'NR==2 {print $4}')"
if [ "${disk_pct}" -ge 90 ]; then
	fail "/ is ${disk_pct}% full (${disk_avail} free). Postgres will refuse writes. Reclaim space: docker system prune -af --filter 'until=168h'"
elif [ "${disk_pct}" -ge 80 ]; then
	warn "/ is ${disk_pct}% full (${disk_avail} free)"
else
	ok "/ is ${disk_pct}% full (${disk_avail} free)"
fi

docker_usage="$(docker system df --format '{{.Type}}: {{.Size}} (reclaimable {{.Reclaimable}})' 2>/dev/null | tr '\n' '; ')"
[ -n "${docker_usage}" ] && emit "        docker: ${docker_usage}"

# --- Memory ---------------------------------------------------------------------------------
emit ""
emit "Memory"
mem_avail_mb="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
swap_total_mb="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "${mem_avail_mb}" -lt 128 ]; then
	fail "only ${mem_avail_mb} MB available — the next build or backup will be OOM-killed"
elif [ "${mem_avail_mb}" -lt 300 ]; then
	warn "only ${mem_avail_mb} MB available"
else
	ok "${mem_avail_mb} MB available, ${swap_total_mb} MB swap configured"
fi
if [ "${swap_total_mb}" -lt 512 ]; then
	warn "no meaningful swap configured — 'next build' is likely to be OOM-killed. Add a 2 GB /swapfile."
fi

# --- Backups ----------------------------------------------------------------------------------
emit ""
emit "Backups"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/app-db}"
newest="$(find "${BACKUP_DIR}" -name '*.dump.gz' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)"
if [ -z "${newest}" ]; then
	fail "no dumps found under ${BACKUP_DIR} — backups are not running"
else
	newest_path="${newest#* }"
	age_h=$((($(date +%s) - $(stat -c '%Y' "${newest_path}")) / 3600))
	if [ "${age_h}" -gt 48 ]; then
		fail "newest dump is ${age_h}h old (${newest_path##*/}) — the timer is not firing. systemctl status app-backup.timer"
	elif [ "${age_h}" -gt 26 ]; then
		warn "newest dump is ${age_h}h old (${newest_path##*/})"
	else
		ok "newest dump is ${age_h}h old (${newest_path##*/})"
	fi
	count="$(find "${BACKUP_DIR}" -name '*.dump.gz' -type f 2>/dev/null | wc -l)"
	emit "        ${count} dumps retained, $(du -sh "${BACKUP_DIR}" 2>/dev/null | cut -f1) total"
fi
if [ -z "${BACKUP_RCLONE_REMOTE:-}" ]; then
	warn "no offsite copy configured (BACKUP_RCLONE_REMOTE is empty) — backups exist only on this server"
fi

# --- Result --------------------------------------------------------------------------------
emit ""
if [ "${FAILURES}" -gt 0 ]; then
	emit "RESULT: ${FAILURES} failure(s), ${WARNINGS} warning(s)"
	printf '%s' "${REPORT}"
	exit 1
fi
if [ "${WARNINGS}" -gt 0 ]; then
	emit "RESULT: no failures, ${WARNINGS} warning(s)"
else
	emit "RESULT: all checks passed"
fi
# --quiet: silent on a clean run, so cron mails only on trouble.
if [ "${QUIET}" -eq 0 ] || [ "${WARNINGS}" -gt 0 ]; then
	printf '%s' "${REPORT}"
fi
[ "${WARNINGS}" -gt 0 ] && exit 2
exit 0
