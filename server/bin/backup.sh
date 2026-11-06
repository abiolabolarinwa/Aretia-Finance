#!/usr/bin/env bash
# Nightly backup: pg_dump -> check it is readable -> encrypt with age (public key only) -> upload with rclone -> prune.
# Keeps KEEP_DAILY (14) daily files and KEEP_WEEKLY (8) Sunday files at the remote, and the last 3 here.
# Run by systemd (systemd/aretia-backup.timer) or by hand:  ./bin/backup.sh
set -euo pipefail
umask 077
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_env
: "${AGE_RECIPIENT:?AGE_RECIPIENT is empty in .env (the public key that starts with age1)}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE is empty in .env}"
KEEP_DAILY="${KEEP_DAILY:-14}"; KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aretia}"
AGE="${AGE:-age}"; RCLONE="${RCLONE:-rclone}"
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
plain="$BACKUP_DIR/.aretia-$stamp.dump"
out="$BACKUP_DIR/aretia-$stamp.dump.age"
cleanup() { rm -f "$plain"; }
fail() { echo "backup FAILED at line $1" >&2; ping_url "${BACKUP_PING_URL:-}" /fail; exit 1; }
trap cleanup EXIT
trap 'fail $LINENO' ERR

# 1. Dump. Custom format is already compressed and lets pg_restore pick tables later.
"${DC[@]}" exec -T postgres pg_dump -U postgres -d aretia -Fc -Z 6 > "$plain"
# 2. A dump that cannot be listed is not a backup: stop here.
size="$(wc -c < "$plain")"
[ "$size" -gt 1000 ] || { echo "dump is only $size bytes" >&2; false; }
"${DC[@]}" exec -T postgres pg_restore --list < "$plain" > /dev/null
# 3. Encrypt with the PUBLIC key; the private key is never on this server. Then the plain copy goes.
"$AGE" -r "$AGE_RECIPIENT" -o "$out" "$plain"
rm -f "$plain"
# 4. Upload; Sundays also go to weekly/.
name="$(basename "$out")"
"$RCLONE" copyto "$out" "$RCLONE_REMOTE/daily/$name"
if [ "${FORCE_WEEKLY:-0}" = 1 ] || [ "$(date -u +%u)" = 7 ]; then "$RCLONE" copyto "$out" "$RCLONE_REMOTE/weekly/$name"; fi
# 5. Keep the newest N of each folder (the names sort by date).
prune_remote() { # folder keep
  local list
  list="$("$RCLONE" lsf "$RCLONE_REMOTE/$1" --files-only 2>/dev/null | sort || true)"
  [ -n "$list" ] || return 0
  printf '%s\n' "$list" | head -n "-$2" | while read -r f; do
    [ -n "$f" ] && "$RCLONE" deletefile "$RCLONE_REMOTE/$1/$f"
  done
  return 0
}
prune_remote daily "$KEEP_DAILY"
prune_remote weekly "$KEEP_WEEKLY"
# Local copies: the last 3.
ls -1 "$BACKUP_DIR"/aretia-*.dump.age 2>/dev/null | sort | head -n -3 | while read -r f; do rm -f "$f"; done || true

echo "backup ok: $name ($(wc -c < "$out") bytes encrypted)"
ping_url "${BACKUP_PING_URL:-}"
