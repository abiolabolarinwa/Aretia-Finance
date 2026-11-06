#!/usr/bin/env bash
# Restores a backup made by backup.sh.
#   ./bin/restore.sh FILE --identity /path/to/age-key.txt                    TEST: restores into a scratch database, prints row counts, drops it
#   ./bin/restore.sh FILE --identity /path/to/age-key.txt --into-production  replaces the live database (asks you to type RESTORE)
# FILE is a local .age file or a remote path such as daily/aretia-20261107T020000Z.dump.age (downloaded with rclone).
# The private key (age-keygen output) lives on your own computer; copy it here only for the restore and delete it afterwards.
set -euo pipefail
umask 077
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_env
AGE="${AGE:-age}"; RCLONE="${RCLONE:-rclone}"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/aretia}"
file="${1:-}"; shift || true
identity=""; prod=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) identity="${2:-}"; shift 2;;
    --into-production) prod=1; shift;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
if [ -z "$file" ] || [ -z "$identity" ] || [ ! -r "$identity" ]; then sed -n '2,6p' "$0" >&2; exit 2; fi
mkdir -p "$BACKUP_DIR"
work="$(mktemp -d "$BACKUP_DIR/restore.XXXXXX")"
trap 'rm -rf "$work"' EXIT
if [ -f "$file" ]; then enc="$file"; else enc="$work/in.age"; "$RCLONE" copyto "$RCLONE_REMOTE/$file" "$enc"; fi
"$AGE" -d -i "$identity" -o "$work/db.dump" "$enc"
"${DC[@]}" exec -T postgres pg_restore --list < "$work/db.dump" > /dev/null

if [ "$prod" = 1 ]; then
  echo "This REPLACES the live database 'aretia' with the backup. Type RESTORE to continue:"
  read -r answer
  [ "$answer" = RESTORE ] || { echo "cancelled"; exit 1; }
  "${DC[@]}" stop postgrest
  "${DC[@]}" exec -T postgres pg_restore -U postgres -d aretia --clean --if-exists --no-owner < "$work/db.dump"
  "${DC[@]}" start postgrest
  echo "restored into production"
else
  target=aretia_restore_test
  "${DC[@]}" exec -T postgres psql -U postgres -X -q -c "drop database if exists $target" -c "create database $target"
  "${DC[@]}" exec -T postgres pg_restore -U postgres -d "$target" --no-owner < "$work/db.dump"
  echo "Row counts in the restored copy:"
  "${DC[@]}" exec -T postgres psql -U postgres -d "$target" -X -At -c \
    "select format('%-28s %s', relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) c from public.%I', relname), false, true, '')))[1]) from pg_class where relkind='r' and relnamespace='public'::regnamespace order by 1"
  "${DC[@]}" exec -T postgres psql -U postgres -X -q -c "drop database $target"
  echo "test restore ok (scratch database dropped)"
fi
