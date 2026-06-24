#!/usr/bin/env bash
#
# Dev startup script for the ICT Portal (Next.js) app on macOS/Linux.
# (macOS/Linux counterpart of run-app.ps1)
#
# Runs the dev server (HMR) from the project root:
#   1. Verify Node.js / pnpm are available
#   2. Verify .env.local exists
#   3. Install dependencies (pnpm install --frozen-lockfile)
#   4. Start the dev server (pnpm dev — Hot Reload). No build step (dev compiles on demand).
#
# Options:
#   -p, --port <PORT>   Server port (default: 3000)
#       --skip-install  Skip the dependency install step
#       --no-start      Install only; do not start the server
#   -h, --help          Show this help
#
# Examples:
#   ./run-app.sh
#   ./run-app.sh --port 8080 --skip-install
#   ./run-app.sh --no-start

set -euo pipefail

PORT=3000
SKIP_INSTALL=0
NO_START=0

# -- colored output (only when stdout is a TTY) --
if [ -t 1 ]; then
  C_CYAN='\033[0;36m'; C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
else
  C_CYAN=''; C_GREEN=''; C_RED=''; C_RESET=''
fi
step() { printf "%b==> %s%b\n" "$C_CYAN" "$1" "$C_RESET"; }
ok()   { printf "%b[OK]  %s%b\n" "$C_GREEN" "$1" "$C_RESET"; }
fail() { printf "%b[ERR] %s%b\n" "$C_RED" "$1" "$C_RESET" 1>&2; }

usage() {
  sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'
}

# -- argument parsing --
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)
      if [ $# -lt 2 ]; then fail "--port requires a value."; exit 1; fi
      PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --no-start)     NO_START=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) fail "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$'; then
  fail "Port must be a number: $PORT"; exit 1
fi

# On failure, print a red message and exit.
trap 'fail "Script failed (line $LINENO)."' ERR

# Always operate from this script's folder (the project root).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

step "Project root: $ROOT"

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found on PATH. Install Node.js 20+ and retry."
  exit 1
fi
ok "Node.js $(node -v)"

# 2. pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm was not found on PATH. Run 'npm install -g pnpm' (or 'corepack enable') and retry."
  exit 1
fi
ok "pnpm $(pnpm -v)"

# 3. Environment file
if [ ! -f "$ROOT/.env.local" ]; then
  fail ".env.local was not found. Create .env.local with the required keys and retry."
  exit 1
fi
ok ".env.local found"

# 4. Install dependencies
if [ "$SKIP_INSTALL" -eq 1 ]; then
  step "Skipping dependency install (--skip-install)"
else
  step "Installing dependencies (pnpm install --frozen-lockfile)"
  pnpm install --frozen-lockfile
  ok "Dependencies installed"
fi

# 5. Start (dev — no build step, on-demand compile + HMR)
if [ "$NO_START" -eq 1 ]; then
  ok "Install finished. Server start skipped (--no-start)."
  exit 0
fi

export PORT="$PORT"
step "Starting dev server (HMR) on http://localhost:$PORT  (press Ctrl+C to stop)"
exec pnpm dev --port "$PORT"
