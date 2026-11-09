#!/usr/bin/env bash
#
# backup.sh — pg_dump the production database, verify it, rotate old copies, copy offsite.
#
#   ./infra/backup.sh                      normal nightly run
#   ./infra/backup.sh --quiet              log to stderr, print only the dump path to stdout
#   ./infra/backup.sh --label pre-deploy   tag the filename (used by deploy.sh)
#   ./infra/backup.sh --no-offsite         skip the offsite copy
#
# Retention: 7 daily + 4 weekly, so roughly a 5-week window.
#
# Format: pg_dump -Fc -Z 0 piped through gzip -9, so `gzip -t` can CRC-check the file.
#
# Not backed up: Caddy certs (regenerable) and .env (back that up by hand, separately).

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_DIR}/docker-compose.prod.yml"
ENV_FILE="${REPO_DIR}/.env"

QUIET=0
LABEL="daily"
DO_OFFSITE=1
while [ $# -gt 0 ]; do
	case "$1" in
	--quiet)
		QUIET=1
		shift
		;;
	--label)
		LABEL="${2:?--label needs a value}"
		shift 2
		;;
	--no-offsite)
		DO_OFFSITE=0
		shift
		;;
	-h | --help)
		sed -n '2,12p' "${BASH_SOURCE[0]}"
		exit 0
		;;
	*)
		echo "Unknown option: $1" >&2
		exit 2
		;;
	esac
done

# Logs go to stderr; stdout is only the dump path (deploy.sh reads it).
log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die() {
	printf '%s  FATAL %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
	exit 1
}
[ "${QUIET}" -eq 1 ] || log "backup.sh starting (label=${LABEL})"

[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

: "${POSTGRES_DB:?POSTGRES_DB must be set in .env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/app-db}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"

DAILY_DIR="${BACKUP_DIR}/daily"
WEEKLY_DIR="${BACKUP_DIR}/weekly"
mkdir -p "${DAILY_DIR}" "${WEEKLY_DIR}"
# Dumps contain user notes and session token hashes: owner-only.
chmod 700 "${BACKUP_DIR}" "${DAILY_DIR}" "${WEEKLY_DIR}"

# One backup at a time.
LOCK_FILE="/tmp/backup.$(basename "${REPO_DIR}").lock"
exec 9>"${LOCK_FILE}"
flock -w 300 9 || die "Another backup has held the lock for over 5 minutes (${LOCK_FILE})."

COMPOSE=(docker compose -f "${COMPOSE_FILE}")
DB_CID="$("${COMPOSE[@]}" ps -q db 2>/dev/null || true)"
[ -n "${DB_CID}" ] || die "The db container is not running. Start it first: docker compose -f ${COMPOSE_FILE} up -d db"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
TARGET="${DAILY_DIR}/${POSTGRES_DB}-${LABEL}-${STAMP}.dump.gz"
TMP="${TARGET}.partial"

# Never leave a half-written file that looks like a backup.
cleanup_partial() { rm -f "${TMP}"; }
trap cleanup_partial EXIT

# =======================================================================================
# Dump
# =======================================================================================
[ "${QUIET}" -eq 1 ] || log "Dumping ${POSTGRES_DB} ..."

# Single-quoted so credentials expand inside the container, never in the host process list.
# --no-owner/--no-acl: the restore target may use a different role; migrations set grants.
if ! "${COMPOSE[@]}" exec -T db sh -c '
      PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
        -U "$POSTGRES_USER" \
        -d "$POSTGRES_DB" \
        --format=custom \
        --compress=0 \
        --no-owner \
        --no-acl \
        --verbose 2>/dev/null
    ' | gzip -9 >"${TMP}"; then
	die "pg_dump failed. Nothing was written. Check: docker compose -f ${COMPOSE_FILE} logs --tail=50 db"
fi

# pipefail catches pg_dump failures, but not a near-empty successful dump.
SIZE_BYTES="$(stat -c '%s' "${TMP}")"
if [ "${SIZE_BYTES}" -lt 1024 ]; then
	die "The dump is only ${SIZE_BYTES} bytes, which cannot be a real database. Refusing to keep it."
fi

# =======================================================================================
# Verify — before rotation, so a bad dump never displaces a good one
# =======================================================================================
# Check 1: gzip CRC over the whole file (truncation, bit rot).
[ "${QUIET}" -eq 1 ] || log "Verifying gzip integrity ..."
gzip -t "${TMP}" || die "gzip integrity check FAILED. The dump is corrupt and has been discarded."

# Check 2: pg_restore --list can read a table of contents (catches a cut-short dump).
[ "${QUIET}" -eq 1 ] || log "Verifying archive structure (pg_restore --list) ..."
# Staged to a temp file in the db container, since pg_restore on non-seekable stdin is
# unreliable. Needs room in container /tmp for one uncompressed dump.
VERIFY_SCRIPT='
  set -e
  tmp=$(mktemp /tmp/verify.XXXXXXXX.dump)
  trap "rm -f $tmp" EXIT
  cat > "$tmp"
  pg_restore --list "$tmp"
'
TOC_LINES="$(gunzip -c "${TMP}" |
	"${COMPOSE[@]}" exec -T db sh -c "${VERIFY_SCRIPT}" 2>/dev/null |
	grep -cve '^;' -e '^[[:space:]]*$' || true)"
if [ "${TOC_LINES}" -lt 1 ]; then
	die "pg_restore could not read a table of contents from the dump. It is not restorable; discarded."
fi
[ "${QUIET}" -eq 1 ] || log "Archive contains ${TOC_LINES} restorable objects."

# A valid TOC doesn't prove the data restores; test a real restore periodically.

mv "${TMP}" "${TARGET}"
chmod 600 "${TARGET}"
trap - EXIT
[ "${QUIET}" -eq 1 ] || log "Wrote ${TARGET} ($(du -h "${TARGET}" | cut -f1))"

# =======================================================================================
# Weekly promotion
# =======================================================================================
# Sunday's daily is hard-linked into weekly/ (survives daily pruning, no extra disk);
# falls back to a copy across filesystems.
if [ "$(date -u '+%u')" = "7" ] && [ "${LABEL}" = "daily" ]; then
	WEEKLY_TARGET="${WEEKLY_DIR}/$(basename "${TARGET}" | sed 's/-daily-/-weekly-/')"
	ln "${TARGET}" "${WEEKLY_TARGET}" 2>/dev/null || cp -p "${TARGET}" "${WEEKLY_TARGET}"
	[ "${QUIET}" -eq 1 ] || log "Promoted to weekly: ${WEEKLY_TARGET}"
fi

# =======================================================================================
# Retention
# =======================================================================================
# Keep the newest N; only our own *.dump.gz files are ever deleted.
prune() {
	local dir="$1" keep="$2" kind="$3" f count=0
	# Parsing `ls` is safe here: our generated filenames contain no spaces or newlines.
	while IFS= read -r f; do
		count=$((count + 1))
		if [ "${count}" -gt "${keep}" ]; then
			rm -f "${dir}/${f}"
			[ "${QUIET}" -eq 1 ] || log "Pruned ${kind}: ${f}"
		fi
	done < <(ls -1t "${dir}" 2>/dev/null | grep -E "\.dump\.gz$" || true)
	[ "${QUIET}" -eq 1 ] || log "${kind}: kept $((count > keep ? keep : count)) of ${count}"
}
prune "${DAILY_DIR}" "${KEEP_DAILY}" "daily"
prune "${WEEKLY_DIR}" "${KEEP_WEEKLY}" "weekly"

# Pre-deploy dumps aren't rotated above; keep the latest 5.
find "${DAILY_DIR}" -name "*-pre-deploy-*.dump.gz" -type f -printf '%T@ %p\n' 2>/dev/null |
	sort -rn | tail -n +6 | cut -d' ' -f2- | while IFS= read -r old; do
	rm -f "${old}"
	[ "${QUIET}" -eq 1 ] || log "Pruned old pre-deploy dump: $(basename "${old}")"
done

# =======================================================================================
# Offsite copy
# =======================================================================================
# rclone credentials live in ~/.config/rclone/rclone.conf (via `rclone config`); only the
# remote name goes in .env as BACKUP_RCLONE_REMOTE.
if [ "${DO_OFFSITE}" -eq 1 ] && [ -n "${RCLONE_REMOTE}" ]; then
	if command -v rclone >/dev/null 2>&1; then
		[ "${QUIET}" -eq 1 ] || log "Copying offsite to ${RCLONE_REMOTE} ..."
		# `copy`, not `sync`, so local deletions never propagate offsite. Remote retention
		# is configured on the bucket.
		if rclone copy --checksum "${DAILY_DIR}" "${RCLONE_REMOTE}/daily" &&
			rclone copy --checksum "${WEEKLY_DIR}" "${RCLONE_REMOTE}/weekly"; then
			[ "${QUIET}" -eq 1 ] || log "Offsite copy complete."
		else
			# Not fatal; the local dump is verified. Warn so it shows in the journal.
			log "WARN offsite copy FAILED. The local dump is fine. Check: rclone about ${RCLONE_REMOTE%%:*}:"
		fi
	else
		log "WARN BACKUP_RCLONE_REMOTE is set but rclone is not installed: sudo apt-get install -y rclone"
	fi
elif [ "${DO_OFFSITE}" -eq 1 ]; then
	# Printed every run until offsite is configured.
	log "WARN No offsite copy configured. Backups exist only on this server."
	log "WARN   Option A (recommended) — object storage via rclone:"
	log "WARN     sudo apt-get install -y rclone && rclone config      # add a remote, e.g. 'b2'"
	log "WARN     then set in .env:  BACKUP_RCLONE_REMOTE=b2:my-bucket/db"
	log "WARN   Option B — another machine you control, over SSH:"
	log "WARN     ssh-keygen -t ed25519 -f ~/.ssh/backup_ed25519 -N ''"
	log "WARN     ssh-copy-id -i ~/.ssh/backup_ed25519.pub backup@backup-host"
	log "WARN     scp -i ~/.ssh/backup_ed25519 ${TARGET} backup@backup-host:/srv/backups/"
	log "WARN   Whichever you choose, the remote credential must be write-only or"
	log "WARN   append-only if the provider allows it, so a compromise of this VPS cannot"
	log "WARN   delete the offsite history."
fi

[ "${QUIET}" -eq 1 ] || log "backup.sh finished."

# The one thing on stdout.
printf '%s\n' "${TARGET}"
