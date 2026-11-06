#!/usr/bin/env bash
# Copies the data from the Supabase project into this server's Postgres, table by table.
#   export SRC_DB_URL='postgresql://...'   Supabase "Session pooler" connection string (Project settings > Database). Never printed.
#   ./bin/copy-from-supabase.sh            copy every table that is not done yet
#   SKIP_TABLES="mi_trades mi_block_hashes" ./bin/copy-from-supabase.sh     leave some out (the indexer tables can be rebuilt)
#   ./bin/copy-from-supabase.sh --restart  forget what was done and start over
# Resumable: a table is marked done only after its rows are copied; run again after any interruption and finished tables are skipped.
# The migrations must already be applied here (docker compose up -d does it). Rows read from Supabase count as its egress.
set -euo pipefail
set +x
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_env
: "${SRC_DB_URL:?Set SRC_DB_URL first (see the top of this file)}"
export SRC_DB_URL
STATE="$HERE/.copy-state"; mkdir -p "$STATE"
if [ "${1:-}" = "--restart" ]; then rm -f "$STATE/done"; fi
touch "$STATE/done"
# -e SRC_DB_URL without a value passes the variable from this shell into the container; it is never on a command line.
src_psql() { "${DC[@]}" exec -T -e SRC_DB_URL postgres sh -c 'exec psql "$SRC_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"' sh "$@"; }

# Parents before children (notify_inbox points at notify_channels).
tables="$(dst_psql -At -c "select tablename from pg_tables where schemaname='public' and tablename <> 'aretia_schema_migrations' order by (tablename = 'notify_inbox'), tablename")"
fail=0
for t in $tables; do
  case " ${SKIP_TABLES:-} " in *" $t "*) echo "skip   $t (SKIP_TABLES)"; continue;; esac
  if grep -qx "$t" "$STATE/done"; then echo "done   $t (earlier run)"; continue; fi
  if ! src_psql -At -c "select 1 from public.$t limit 1" > /dev/null 2>&1; then echo "absent $t (not in the source; skipped)"; continue; fi
  cols="$(dst_psql -At -c "select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='$t'")"
  # replica role: foreign-key checks are off for this session, so a half-copied table can be emptied and refilled in any order.
  if src_psql -c "\\copy (select $cols from public.$t) to stdout with (format csv)" \
    | dst_psql -c "set session_replication_role = replica" -c "delete from public.$t" -c "\\copy public.$t ($cols) from stdin with (format csv)"; then
    echo "$t" >> "$STATE/done"; echo "copied $t"
  else
    echo "FAILED $t (run again to resume)" >&2; fail=1
  fi
done

echo "Resetting counters of generated ids..."
dst_psql -c "do \$\$ declare r record; begin for r in select table_name t, column_name c from information_schema.columns where table_schema='public' and (is_identity='YES' or column_default like 'nextval(%') loop execute format('select setval(pg_get_serial_sequence(%L,%L), greatest(coalesce((select max(%I) from public.%I),0),1), (select max(%I) from public.%I) is not null)', 'public.'||r.t, r.c, r.c, r.t, r.c, r.t); end loop; end \$\$"

echo "Row counts (source, here):"
bad=0
for t in $tables; do
  case " ${SKIP_TABLES:-} " in *" $t "*) continue;; esac
  s="$(src_psql -At -c "select count(*) from public.$t" 2>/dev/null || echo n/a)"
  d="$(dst_psql -At -c "select count(*) from public.$t")"
  mark=""
  if [ "$s" != n/a ] && [ "$s" != "$d" ]; then mark="  <-- differs (the site may have written since)"; bad=1; fi
  printf '%-28s %10s %10s%s\n' "$t" "$s" "$d" "$mark"
done
[ "$fail" = 0 ] || exit 1
if [ "$bad" = 0 ]; then echo "All counts match."; else echo "Some counts differ: normal if the site kept writing; run again with --restart during the cut-over pause."; fi
