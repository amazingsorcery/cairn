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
# FORMAT — why custom format piped through gzip rather than either alone:
#   pg_dump -Fc produces a compressed archive, so gzipping it again would normally be
#   pointless. We pass -Z 0 to turn pg_dump's internal compression OFF and compress once
#   with gzip -9 instead. Two concrete reasons:
#     1. `gzip -t` gives a cheap, standard, whole-file CRC check. A custom-format archive
#        has no equivalent one-liner.
#     2. gzip -9 on the uncompressed stream beats pg_dump's default level, and the CPU
#        cost is paid at 03:00 on an otherwise idle box.
#   The archive inside is still custom format, so pg_restore keeps selective restore,
#   parallel restore and --list.
#
# WHAT THIS DOES NOT BACK UP: uploaded files (there are none in v1), the Caddy certificate
# volume (regenerable from Let's Encrypt), and .env (it holds secrets and must be backed up
# separately, by hand, into your password manager — not into a nightly tarball that then
# gets copied to a cloud bucket).

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

# All human-readable output goes to stderr so that stdout carries exactly one thing: the
# path of the dump that was produced. deploy.sh depends on that.
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
# The dumps contain every user's notes and every session token hash. Nobody but the owner
# reads this directory.
chmod 700 "${BACKUP_DIR}" "${DAILY_DIR}" "${WEEKLY_DIR}"

# A dump taken while a migration is mid-flight is not useful, and two concurrent pg_dumps
# on a 2 GB box will fight for memory. One at a time.
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

# The credentials never appear on the host command line or in the host process list: the
# single-quoted shell snippet is expanded INSIDE the container, using the environment the
# postgres image already has. `ps` on the host shows only `sh -c ...` with literal
# variable names.
#
# --no-owner / --no-acl: the restore target may use a different role name (a staging box,
# a laptop). Ownership and grants are recreated by the app's migrations, not by the dump.
# -Z 0: see the header — gzip does the compressing.
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

# `set -o pipefail` makes the above catch a pg_dump failure, but an EMPTY successful dump
# is still possible if the database has no tables yet. Guard the obvious floor.
SIZE_BYTES="$(stat -c '%s' "${TMP}")"
if [ "${SIZE_BYTES}" -lt 1024 ]; then
	die "The dump is only ${SIZE_BYTES} bytes, which cannot be a real database. Refusing to keep it."
fi

# =======================================================================================
# Verify — before rotation, so a bad dump never displaces a good one
# =======================================================================================
# This is the step that separates "we have backups" from "we have files".
#
# Check 1: gzip CRC over the whole file. Catches truncation and bit rot on disk.
[ "${QUIET}" -eq 1 ] || log "Verifying gzip integrity ..."
gzip -t "${TMP}" || die "gzip integrity check FAILED. The dump is corrupt and has been discarded."

# Check 2: the decompressed stream is a parseable custom-format archive with a real table
# of contents. Catches a dump that gzipped cleanly but was cut short by an OOM kill or a
# disconnect mid-stream. pg_restore --list reads the TOC without touching any database.
[ "${QUIET}" -eq 1 ] || log "Verifying archive structure (pg_restore --list) ..."
# pg_restore lives in the db container, not on the host, so the decompressed stream is
# piped in and staged to a container-local temp file. It is staged rather than read from
# /dev/stdin because pg_restore's behaviour on a non-seekable input is version-dependent,
# and a verification step that sometimes fails for its own reasons is worse than none.
# Cost: container /tmp needs room for one uncompressed dump. Fine at this data size; if
# the database ever outgrows it, move this check to a host with postgresql-client installed.
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

# NOTE ON THE LIMIT OF THIS CHECK: a valid TOC proves the archive is structurally sound,
# not that the DATA restores into a working application. Only a real restore proves that.
# The RUNBOOK contains a quarterly restore drill; do it. A backup nobody has restored is
# not a backup.

mv "${TMP}" "${TARGET}"
chmod 600 "${TARGET}"
trap - EXIT
[ "${QUIET}" -eq 1 ] || log "Wrote ${TARGET} ($(du -h "${TARGET}" | cut -f1))"

# =======================================================================================
# Weekly promotion
# =======================================================================================
# Sunday's daily is hard-linked into weekly/. A hard link costs no extra disk while both
# copies exist, and the weekly copy survives when the daily is pruned — the inode is only
# freed when the last link goes. Falls back to a real copy across filesystems.
if [ "$(date -u '+%u')" = "7" ] && [ "${LABEL}" = "daily" ]; then
	WEEKLY_TARGET="${WEEKLY_DIR}/$(basename "${TARGET}" | sed 's/-daily-/-weekly-/')"
	ln "${TARGET}" "${WEEKLY_TARGET}" 2>/dev/null || cp -p "${TARGET}" "${WEEKLY_TARGET}"
	[ "${QUIET}" -eq 1 ] || log "Promoted to weekly: ${WEEKLY_TARGET}"
fi

# =======================================================================================
# Retention
# =======================================================================================
# Newest-first listing, skip the first N, delete the rest. Only files this script's naming
# convention produced are ever considered, so an unrelated file dropped in the directory
# is never deleted.
prune() {
	local dir="$1" keep="$2" kind="$3" f count=0
	# shellcheck disable=SC2012  # filenames here are script-generated and contain no
	# newlines or spaces, and `ls -1t` is the simplest correct mtime sort.
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

# Pre-deploy dumps are not part of the daily rotation and would otherwise accumulate for
# ever. Keep the most recent 5 — enough to cover a bad week of deploys.
find "${DAILY_DIR}" -name "*-pre-deploy-*.dump.gz" -type f -printf '%T@ %p\n' 2>/dev/null |
	sort -rn | tail -n +6 | cut -d' ' -f2- | while IFS= read -r old; do
	rm -f "${old}"
	[ "${QUIET}" -eq 1 ] || log "Pruned old pre-deploy dump: $(basename "${old}")"
done

# =======================================================================================
# Offsite copy
# =======================================================================================
# A backup stored only on the machine it backs up does not survive the events it exists
# for: the provider suspending the account, the VPS being deleted, or the disk being
# encrypted by someone else. This step is what makes it a backup rather than a snapshot.
#
# NO CREDENTIALS APPEAR IN THIS REPOSITORY. rclone keeps its own config in
# ~/.config/rclone/rclone.conf, created interactively by `rclone config`. Set only the
# remote NAME in .env as BACKUP_RCLONE_REMOTE.
if [ "${DO_OFFSITE}" -eq 1 ] && [ -n "${RCLONE_REMOTE}" ]; then
	if command -v rclone >/dev/null 2>&1; then
		[ "${QUIET}" -eq 1 ] || log "Copying offsite to ${RCLONE_REMOTE} ..."
		# `copy`, not `sync`: sync would mirror local deletions to the remote, which means
		# a local rm -rf (accidental or hostile) propagates to the offsite copy within a
		# day. Remote retention is configured on the bucket, with object-lock or versioning
		# if the provider supports it.
		if rclone copy --checksum "${DAILY_DIR}" "${RCLONE_REMOTE}/daily" &&
			rclone copy --checksum "${WEEKLY_DIR}" "${RCLONE_REMOTE}/weekly"; then
			[ "${QUIET}" -eq 1 ] || log "Offsite copy complete."
		else
			# Not fatal: the local dump is verified and on disk. But it must be noticed,
			# so it is a loud stderr warning that the systemd unit will surface in
			# `systemctl status` and in the journal.
			log "WARN offsite copy FAILED. The local dump is fine. Check: rclone about ${RCLONE_REMOTE%%:*}:"
		fi
	else
		log "WARN BACKUP_RCLONE_REMOTE is set but rclone is not installed: sudo apt-get install -y rclone"
	fi
elif [ "${DO_OFFSITE}" -eq 1 ]; then
	# Printed every run until offsite is configured. The nagging is the point.
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
