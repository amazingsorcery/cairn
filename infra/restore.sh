#!/usr/bin/env bash
#
# restore.sh — replace the production database with the contents of a dump.
#
#   ./infra/restore.sh --list
#   ./infra/restore.sh /var/backups/app-db/daily/app-daily-20260830T030000Z.dump.gz --yes-i-am-sure
#
# THIS IS DESTRUCTIVE. It drops the existing database and recreates it from the dump.
# Everything written since that dump is gone.
#
# Safety measures, in order:
#   1. Nothing happens without the literal flag --yes-i-am-sure. There is no --force, no
#      -y, and no prompt that Enter can answer.
#   2. On a terminal you must additionally type the database name. There is no way to
#      pipe `yes` into this and have it work.
#   3. The CURRENT database is dumped first, unconditionally, before anything is dropped.
#      If you restore the wrong file, that dump is your way back — its path is printed
#      before the destructive step and again at the end.
#   4. The web container is stopped first, so nothing writes into a half-restored schema.
#   5. The result is verified before web is started again.
#
# RECOVERY TIME: on a database of this size (a directory catalogue plus user notes,
# realistically tens of MB for a long time) expect 1-3 minutes of downtime end to end,
# most of it the safety dump. Budget 15 minutes for the whole procedure including finding
# the right file and reading the output. It is not an operation to rush.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_DIR}/docker-compose.prod.yml"
ENV_FILE="${REPO_DIR}/.env"

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
warn() { printf '%s  WARN %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die() {
	printf '%s  FATAL %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
	exit 1
}

[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a
: "${POSTGRES_DB:?POSTGRES_DB must be set in .env}"
: "${POSTGRES_USER:?POSTGRES_USER must be set in .env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/app-db}"
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

# --- Arguments --------------------------------------------------------------------------
DUMP=""
CONFIRMED=0
LIST=0
for arg in "$@"; do
	case "${arg}" in
	--yes-i-am-sure) CONFIRMED=1 ;;
	--list) LIST=1 ;;
	-h | --help)
		sed -n '2,32p' "${BASH_SOURCE[0]}"
		exit 0
		;;
	-*) die "Unknown option: ${arg}" ;;
	*) DUMP="${arg}" ;;
	esac
done

if [ "${LIST}" -eq 1 ]; then
	echo "Available dumps under ${BACKUP_DIR}:"
	echo
	find "${BACKUP_DIR}" -name '*.dump.gz' -type f -printf '%TY-%Tm-%Td %TH:%TM  %10s  %p\n' 2>/dev/null |
		sort -r || echo "  (none)"
	echo
	echo "Restore with:"
	echo "  ${BASH_SOURCE[0]} <path> --yes-i-am-sure"
	exit 0
fi

[ -n "${DUMP}" ] || die "No dump specified. See what you have with: ${BASH_SOURCE[0]} --list"
[ -f "${DUMP}" ] || die "No such file: ${DUMP}"

# --- Pre-flight: prove the dump is readable BEFORE dropping anything ---------------------
log "Checking the dump before touching the database ..."
gzip -t "${DUMP}" || die "gzip integrity check failed on ${DUMP}. This file is corrupt. Pick another; the database has not been touched."
log "  gzip CRC OK ($(du -h "${DUMP}" | cut -f1), written $(date -u -r "${DUMP}" '+%Y-%m-%d %H:%M:%SZ'))"

DB_CID="$("${COMPOSE[@]}" ps -q db 2>/dev/null || true)"
[ -n "${DB_CID}" ] || die "The db container is not running: docker compose -f ${COMPOSE_FILE} up -d db"

# --- Confirmation ------------------------------------------------------------------------
cat <<BANNER

  ---------------------------------------------------------------------------
   DESTRUCTIVE OPERATION

   Target database : ${POSTGRES_DB}   (on container ${DB_CID:0:12})
   Restoring from  : ${DUMP}
   Dump written    : $(date -u -r "${DUMP}" '+%Y-%m-%d %H:%M:%SZ')

   The database "${POSTGRES_DB}" will be DROPPED and recreated from this file.
   Every change made since that dump was taken will be lost.
  ---------------------------------------------------------------------------

BANNER

if [ "${CONFIRMED}" -ne 1 ]; then
	die "Refusing to continue. Re-run with the literal flag --yes-i-am-sure if that is really what you want."
fi

# A second gate that only exists on a terminal. A script or a cron job that somehow gets
# here still has to have passed --yes-i-am-sure deliberately; a human at a keyboard has to
# type the name as well, because --yes-i-am-sure is easy to recall from shell history and
# run against the wrong file.
if [ -t 0 ]; then
	printf 'Type the database name (%s) to proceed: ' "${POSTGRES_DB}"
	read -r TYPED
	[ "${TYPED}" = "${POSTGRES_DB}" ] || die "Input did not match. Nothing has been changed."
fi

# --- Step 1: safety dump of what is there NOW --------------------------------------------
log "Taking a safety dump of the CURRENT database before dropping it ..."
SAFETY=""
if SAFETY="$("${SCRIPT_DIR}/backup.sh" --quiet --label pre-restore --no-offsite)"; then
	log "  Safety dump: ${SAFETY}"
	log "  If this restore turns out to be a mistake, that file is the way back."
else
	warn "The safety dump FAILED."
	warn "Continuing would leave you with no route back to the current state."
	die "Aborting. Fix the backup path first, or move the current database aside manually."
fi

# --- Step 2: stop the writers -------------------------------------------------------------
# web is stopped, not killed, so in-flight requests finish. It stays stopped until the
# restore has been verified — serving traffic against a half-restored schema produces
# errors that look like application bugs and, worse, can write rows into it.
log "Stopping web (the site will return 502 until this finishes) ..."
"${COMPOSE[@]}" stop web >/dev/null 2>&1 || true
DOWN_SINCE="$(date +%s)"

# --- Step 3: drop and recreate -------------------------------------------------------------
log "Recreating the database ..."
# Connect to the `postgres` maintenance database: you cannot drop the database you are
# connected to. WITH (FORCE) terminates any remaining backends (PostgreSQL 13+), which
# covers a stray psql session or a connection pool that has not noticed web stopped.
"${COMPOSE[@]}" exec -T db sh -c '
  set -e
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE);"
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"
' || die "Could not recreate the database. It may not exist right now. Your safety dump is ${SAFETY}"

# --- Step 4: restore -----------------------------------------------------------------------
log "Restoring (this is the slow part) ..."
# --single-transaction: all or nothing. A restore that fails halfway leaves an empty
#   database rather than a plausible-looking partial one, which is far easier to recover
#   from and impossible to mistake for success.
# --exit-on-error: without it pg_restore reports errors and carries on to the end,
#   returning 0. That is how people end up with a "successful" restore missing tables.
# --no-owner/--no-acl: match how the dump was taken.
if ! gunzip -c "${DUMP}" | "${COMPOSE[@]}" exec -T db sh -c '
      set -e
      export PGPASSWORD="$POSTGRES_PASSWORD"
      tmp=$(mktemp /tmp/restore.XXXXXXXX.dump)
      trap "rm -f $tmp" EXIT
      cat > "$tmp"
      pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --no-owner --no-acl --exit-on-error --single-transaction "$tmp"
    '; then
	warn "RESTORE FAILED. The database is empty (the transaction rolled back)."
	warn "Your pre-restore safety dump is: ${SAFETY}"
	warn "To get back to where you were:"
	warn "  ${BASH_SOURCE[0]} ${SAFETY} --yes-i-am-sure"
	warn "web is still stopped. Start it only once the database is right:"
	warn "  docker compose -f ${COMPOSE_FILE} up -d web"
	exit 1
fi
log "Restore completed."

# --- Step 5: verify BEFORE letting traffic back in ------------------------------------------
log "Verifying ..."
TABLE_COUNT="$("${COMPOSE[@]}" exec -T db sh -c '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = '"'"'public'"'"';"
' | tr -d '[:space:]')"

if ! [ "${TABLE_COUNT}" -gt 0 ] 2>/dev/null; then
	warn "The restored database has no tables in the public schema."
	warn "Safety dump: ${SAFETY}. web is still stopped."
	die "Verification failed."
fi
log "  public schema contains ${TABLE_COUNT} tables."

# Row counts per table, so a human can eyeball whether this is the data they expected
# rather than an empty schema. This is the check that catches restoring the wrong file.
log "  Row counts:"
"${COMPOSE[@]}" exec -T db sh -c '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAF"  " -c "
    SELECT relname, n_live_tup
    FROM pg_stat_user_tables
    ORDER BY n_live_tup DESC
    LIMIT 25;"
' | sed 's/^/    /'
# n_live_tup is a planner estimate refreshed by ANALYZE, and pg_restore does not run one.
# Run it so the numbers above are meaningful on the next look, and so the planner has
# statistics before the first real query hits.
log "  Running ANALYZE so the planner has fresh statistics ..."
"${COMPOSE[@]}" exec -T db sh -c '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -c "ANALYZE;"
'

# --- Step 6: bring the site back --------------------------------------------------------
log "Starting web ..."
"${COMPOSE[@]}" up -d web

log "Waiting for /api/health ..."
OK=0
DEADLINE=$(($(date +%s) + 120))
while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
	if "${COMPOSE[@]}" exec -T web node -e \
		"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
		OK=1
		break
	fi
	sleep 5
done

DOWNTIME=$(($(date +%s) - DOWN_SINCE))
if [ "${OK}" -eq 1 ]; then
	log "Health check passed. Downtime: ${DOWNTIME}s."
else
	warn "web did not become healthy within 120s. Downtime so far: ${DOWNTIME}s."
	warn "  docker compose -f ${COMPOSE_FILE} logs --tail=100 web"
	warn "A common cause: the dump predates a migration the running image needs. Apply them:"
	warn "  docker compose -f ${COMPOSE_FILE} --profile tools run --rm migrate"
	exit 1
fi

cat <<SUMMARY

  Restore complete.
    Restored from : ${DUMP}
    Safety dump   : ${SAFETY}
    Downtime      : ${DOWNTIME}s

  Now do these two things by hand:
    1. Load https://${DOMAIN:-your-domain} and sign in. A restore that passes /api/health
       can still have restored the wrong day's data.
    2. If the dump predates the currently deployed code, run the migrations:
         docker compose -f ${COMPOSE_FILE} --profile tools run --rm migrate

SUMMARY
