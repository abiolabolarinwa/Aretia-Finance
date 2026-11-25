#!/usr/bin/env bash
# Pull the latest kit, rebuild, apply any new migration, restart PostgREST so it sees new tables, and recreate Caddy so it
# reads the new Caddyfile: it reads its list of allowed tables only at start, and the single-file mount keeps the old file
# after a pull replaces it, so without this a new table answers 404 through Caddy.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
git -C "$HERE/.." pull --ff-only
"${DC[@]}" build
"${DC[@]}" run --rm migrate
"${DC[@]}" up -d
"${DC[@]}" restart postgrest
"${DC[@]}" up -d --force-recreate caddy
"${DC[@]}" ps
