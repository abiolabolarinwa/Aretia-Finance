# Shared by the other scripts in this folder. Source it; do not run it.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER="${DOCKER:-docker}"
DC=("$DOCKER" compose -f "$HERE/docker-compose.yml")
# Loads .env without printing it. Refuses a .env that other users can read.
load_env() {
  [ -f "$HERE/.env" ] || { echo "No $HERE/.env" >&2; exit 2; }
  if [ "${SKIP_ENV_MODE_CHECK:-0}" != 1 ]; then
    mode="$(stat -c '%a' "$HERE/.env" 2>/dev/null || stat -f '%Lp' "$HERE/.env")"
    case "$mode" in 600|400) ;; *) echo ".env has mode $mode; run: chmod 600 $HERE/.env" >&2; exit 2;; esac
  fi
  set -a; . "$HERE/.env"; set +a
}
# ping_url <url> [suffix]: a failure to ping never fails the job.
ping_url() { [ -n "${1:-}" ] && curl -fsS -m 10 --retry 3 -o /dev/null "${1%/}${2:-}" 2>/dev/null || true; }
dst_psql() { "${DC[@]}" exec -T postgres psql -U postgres -d aretia -X -q -v ON_ERROR_STOP=1 "$@"; }
