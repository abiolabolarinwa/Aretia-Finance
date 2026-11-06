#!/usr/bin/env bash
# Disk-space alert. Run every 15 minutes (systemd/aretia-disk.timer). It pings DISK_PING_URL only while the disk is fine, so a
# dead-man's-switch service (e.g. healthchecks.io, free) alerts you both when the disk fills AND when the whole server goes quiet.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_env
limit="${DISK_ALERT_PERCENT:-80}"
used="$(df --output=pcent / | tail -n1 | tr -dc '0-9')"
if [ "$used" -ge "$limit" ]; then
  echo "DISK ${used}% used (limit ${limit}%)" >&2
  ping_url "${DISK_PING_URL:-}" /fail
  exit 1
fi
echo "disk ${used}% used"
ping_url "${DISK_PING_URL:-}"
