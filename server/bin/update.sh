#!/usr/bin/env bash
# Pull the latest kit, rebuild, apply any new migration and restart PostgREST so it sees new tables.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
git -C "$HERE/.." pull --ff-only
"${DC[@]}" build
"${DC[@]}" run --rm migrate
"${DC[@]}" up -d
"${DC[@]}" restart postgrest
"${DC[@]}" ps
