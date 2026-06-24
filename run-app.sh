#!/usr/bin/env bash
#
# Production startup script for the ICT Portal (Next.js) app on macOS/Linux.
#
# Runs the full production flow from the project root:
#   1. Verifies Node.js and pnpm are available.
#   2. Verifies the .env.local file exists.
#   3. Installs dependencies (pnpm install --frozen-lockfile).
#   4. Builds the production bundle (pnpm build).
#   5. Starts the Next.js production server (pnpm start).
#
# Options:
#   -p, --port <port>   TCP port the production server listens on. Default: 3000.
#       --skip-install  Skip the dependency install step.
#       --skip-build    Skip the build step and reuse the existing .next output.
#       --no-start      Run install/build only and exit without starting the server.
#   -h, --help          Show this help and exit.
#
# Examples:
#   ./run-app.sh
#   ./run-app.sh --port 8080 --skip-install
#   ./run-app.sh --no-start

set -euo pipefail

PORT=3000
SKIP_INSTALL=0
SKIP_BUILD=0
NO_START=0

# --- pretty logging (colors only when stdout is a TTY) ---
if [ -t 1 ]; then
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_RST=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_ERR=''; C_RST=''
fi
write_step() { printf '%s==> %s%s\n' "$C_STEP" "$1" "$C_RST"; }
write_ok()   { printf '%s[OK]  %s%s\n' "$C_OK"  "$1" "$C_RST"; }
write_fail() { printf '%s[ERR] %s%s\n' "$C_ERR" "$1" "$C_RST" >&2; }

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# --- parse args ---
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)
      [ $# -ge 2 ] || { write_fail "--port requires a value."; exit 1; }
      PORT="$2"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    --no-start)     NO_START=1; shift ;;
    -h|--help)      usage 0 ;;
    *) write_fail "Unknown argument: $1"; usage 1 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) write_fail "--port must be a number (got '$PORT')."; exit 1 ;;
esac

# Always operate from this script's folder (the project root).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

trap 'write_fail "Script aborted."' ERR

write_step "Project root: $ROOT"

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  write_fail "Node.js was not found on PATH. Install Node.js 20+ and retry."
  exit 1
fi
write_ok "Node.js $(node -v)"

# 2. pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  write_fail "pnpm was not found on PATH. Run 'npm install -g pnpm' and retry."
  exit 1
fi
write_ok "pnpm $(pnpm -v)"

# 3. Environment file
if [ ! -f "$ROOT/.env.local" ]; then
  write_fail ".env.local was not found. Copy .env.example to .env.local and fill in the values."
  exit 1
fi
write_ok ".env.local found"

# 4. Install dependencies
if [ "$SKIP_INSTALL" -eq 1 ]; then
  write_step "Skipping dependency install (--skip-install)"
else
  write_step "Installing dependencies (pnpm install --frozen-lockfile)"
  pnpm install --frozen-lockfile
  write_ok "Dependencies installed"
fi

# 5. Build
if [ "$SKIP_BUILD" -eq 1 ]; then
  write_step "Skipping build (--skip-build)"
  if [ ! -d "$ROOT/.next" ]; then
    write_fail "No existing .next build output found. Run without --skip-build first."
    exit 1
  fi
else
  write_step "Building production bundle (pnpm build)"
  pnpm build
  write_ok "Build complete"
fi

# 6. Start
if [ "$NO_START" -eq 1 ]; then
  write_ok "Install/build finished. Server start skipped (--no-start)."
  exit 0
fi

export NODE_ENV=production
export PORT="$PORT"
write_step "Starting production server on http://localhost:$PORT  (press Ctrl+C to stop)"
exec pnpm start --port "$PORT"
