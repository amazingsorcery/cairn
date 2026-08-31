#!/usr/bin/env bash
#
# healthcheck.sh — one command that answers "is this server all right?".
#
#   ./infra/healthcheck.sh          full report, exit 0 if everything passes
#   ./infra/healthcheck.sh --quiet  print nothing unless something FAILS (for cron)
#
# Exit code: 0 all checks passed, 1 at least one FAIL, 2 warnings only.
#
# This exists because the failures that actually take a small VPS down are slow ones —
# the disk filling, a certificate quietly failing to renew, a container restart-looping at
# 3 a.m. — and none of them announce themselves. Run it from a timer and you find out on
# the day it starts, not the day it finishes.

set -uo pipefail # deliberately NOT -e: every check must run even after one fails.

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
# Five, up from three (ADR 0019). Ordered by what a reader depends on: if db or redis is
# down, everything above it in this list is going to look broken too, and reading the list
# top-down gives the cause before the symptoms.
for svc in db redis web worker caddy; do
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

	# A container that has restarted many times is up right now and broken anyway: it is
	# crash-looping and each loop drops in-flight requests.
	if [ "${restarts:-0}" -gt 5 ]; then
		warn "${svc} has restarted ${restarts} times — it is crash-looping. docker compose -f ${COMPOSE_FILE} logs --tail=100 ${svc}"
	fi
done

# --- Redis ----------------------------------------------------------------------------------
# What "Redis filling up" looks like, and why none of it is an error in the log.
#
# maxmemory-policy is `allkeys-lru`, so a full Redis does not fail — it evicts. There is no
# error, no restart and no alert: the only visible effect is that cache hits stop happening,
# so the worker re-fetches more often and the map gets slower and closer to its upstream
# ceilings. `evicted_keys` climbing is the single number that says so.
#
# A steady trickle of evictions is NORMAL and expected at a working set near the ceiling.
# The thing to react to is used/max sitting above 90% together with evictions growing between
# two runs of this script, which together mean the ceiling is now the binding constraint
# rather than a safety net.
emit ""
emit "Redis"
redis_cid="$("${COMPOSE[@]}" ps -q redis 2>/dev/null)"
if [ -z "${redis_cid}" ]; then
	fail "redis is not running — every layer will re-fetch on every request and the poll ceilings in ADR 0021 will be exceeded"
else
	# -a is passed only when a password is configured, because `redis-cli -a ""` warns on
	# stderr and is noise on the common path.
	if [ -n "${REDIS_PASSWORD:-}" ]; then
		redis_info="$(docker exec "${redis_cid}" redis-cli -a "${REDIS_PASSWORD}" --no-auth-warning info memory 2>/dev/null)"
		redis_stats="$(docker exec "${redis_cid}" redis-cli -a "${REDIS_PASSWORD}" --no-auth-warning info stats 2>/dev/null)"
	else
		redis_info="$(docker exec "${redis_cid}" redis-cli info memory 2>/dev/null)"
		redis_stats="$(docker exec "${redis_cid}" redis-cli info stats 2>/dev/null)"
	fi

	if [ -z "${redis_info}" ]; then
		fail "redis is running but did not answer INFO. If a password is set, REDIS_PASSWORD must be in .env for this check to work."
	else
		used="$(printf '%s' "${redis_info}" | awk -F: '/^used_memory:/ {gsub(/
/,"",$2); print $2}')"
		maxm="$(printf '%s' "${redis_info}" | awk -F: '/^maxmemory:/ {gsub(/
/,"",$2); print $2}')"
		used_h="$(printf '%s' "${redis_info}" | awk -F: '/^used_memory_human:/ {gsub(/
/,"",$2); print $2}')"
		evicted="$(printf '%s' "${redis_stats}" | awk -F: '/^evicted_keys:/ {gsub(/
/,"",$2); print $2}')"

		if [ -n "${maxm}" ] && [ "${maxm:-0}" -gt 0 ] 2>/dev/null; then
			pct=$((used * 100 / maxm))
			if [ "${pct}" -ge 95 ]; then
				fail "redis is at ${pct}% of maxmemory (${used_h}). It is evicting continuously; every eviction is a cache miss that becomes an upstream call. Raise REDIS_MAXMEMORY or find the key pattern that is growing."
			elif [ "${pct}" -ge 85 ]; then
				warn "redis is at ${pct}% of maxmemory (${used_h}) — at or near the eviction threshold"
			else
				ok "redis at ${pct}% of maxmemory (${used_h})"
			fi
		else
			# maxmemory 0 means unlimited, which this stack never wants: an unbounded cache
			# on a shared box competes with Postgres for RAM and is eventually OOM-killed.
			fail "redis has no maxmemory set (unbounded). Check the redis `command:` in docker-compose.prod.yml."
		fi
		emit "        evicted_keys=${evicted:-unknown} (a slow climb is normal; a fast one means the ceiling is binding)"
	fi
fi

# --- Live sources ---------------------------------------------------------------------------
# The connector board, read from the worker itself. This is the answer to "has a source gone
# dark", and it is deliberately printed in full rather than reduced to a pass/fail: a source
# that is `notConfigured` because nobody has ever set its key is a completely different
# situation from one that answered fine yesterday, and only the board shows which is which.
# The web-facing version of the same data is /admin/connectors (ADR 0024).
emit ""
emit "Live sources"
worker_cid="$("${COMPOSE[@]}" ps -q worker 2>/dev/null)"
if [ -z "${worker_cid}" ]; then
	fail "worker is not running — nothing is polling, and every layer will go stale as it passes its TTL"
else
	if "${COMPOSE[@]}" exec -T worker node -e \n		"fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||9091)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
		ok "the poll loop is running (worker /healthz returns 200)"
	else
		# 503 here means a poller STOPPED ATTEMPTING, which is our bug, not an upstream's.
		# HANDOFF section 14 is the contract that makes this distinction meaningful.
		fail "worker /healthz is not 200 — at least one poller has stopped attempting. This is a dead poller, NOT a dead upstream. docker compose -f ${COMPOSE_FILE} logs --tail=100 worker"
	fi

	board="$("${COMPOSE[@]}" exec -T worker node -e \n		"fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||9091)+'/status').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null)"
	if [ -n "${board}" ]; then
		# Process substitution, not a pipe: a piped `while read` runs in a subshell, and every
		# `emit` inside it would append to a copy of REPORT that is discarded when the subshell
		# exits. The board would then be collected and silently thrown away.
		while IFS= read -r line; do
			[ -n "${line}" ] && emit "        ${line}"
		done < <(printf '%s
' "${board}")
	else
		warn "the worker did not return a source board on /status"
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
	000) fail "https://${DOMAIN}/api/health is unreachable (DNS, firewall, or TLS). See RUNBOOK 'Certificate troubleshooting'." ;;
	*) fail "https://${DOMAIN}/api/health returned HTTP ${code}" ;;
	esac
fi

# --- TLS certificate -----------------------------------------------------------------------
# Caddy renews at 2/3 of the lifetime, so a 90-day Let's Encrypt certificate should never
# drop below 30 days. If it does, renewal is failing and nothing has told you.
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
	fail "/ is ${disk_pct}% full (${disk_avail} free). Postgres will refuse writes. See RUNBOOK 'Disk full'."
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
	warn "no meaningful swap configured — 'next build' is likely to be OOM-killed. See RUNBOOK 'Swap file'."
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
# In --quiet mode a clean run says nothing at all, so a cron entry mails only on trouble.
if [ "${QUIET}" -eq 0 ] || [ "${WARNINGS}" -gt 0 ]; then
	printf '%s' "${REPORT}"
fi
[ "${WARNINGS}" -gt 0 ] && exit 2
exit 0
