#!/usr/bin/env bash
#
# Dev startup script for the ICT Portal (Next.js) app on macOS/Linux.
# (run-app.ps1 의 macOS/Linux 판)
#
# 프로젝트 루트에서 개발 서버(HMR)를 실행한다:
#   1. Node.js / pnpm 존재 확인
#   2. .env.local 존재 확인
#   3. 의존성 설치 (pnpm install --frozen-lockfile)
#   4. 개발 서버 시작 (pnpm dev — Hot Reload). ※ 빌드 단계 없음(dev는 온디맨드 컴파일).
#
# 옵션:
#   -p, --port <PORT>   서버 포트 (기본: 3000)
#       --skip-install  의존성 설치 단계 건너뜀
#       --no-start      설치만 하고 서버는 시작하지 않음
#   -h, --help          도움말 출력
#
# 예시:
#   ./run-app.sh
#   ./run-app.sh --port 8080 --skip-install
#   ./run-app.sh --no-start

set -euo pipefail

PORT=3000
SKIP_INSTALL=0
NO_START=0

# ── 컬러 출력 (TTY 일 때만) ──────────────────────────────────
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

# ── 인자 파싱 ───────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)
      if [ $# -lt 2 ]; then fail "--port 에 값이 필요합니다."; exit 1; fi
      PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --no-start)     NO_START=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) fail "알 수 없는 옵션: $1"; usage; exit 1 ;;
  esac
done

if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$'; then
  fail "포트는 숫자여야 합니다: $PORT"; exit 1
fi

# 실패 시 메시지를 빨간색으로 보여 주고 종료.
trap 'fail "스크립트가 실패했습니다 (line $LINENO)."' ERR

# 항상 스크립트 폴더(프로젝트 루트)에서 동작.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

step "Project root: $ROOT"

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 를 PATH 에서 찾지 못했습니다. Node.js 20+ 설치 후 다시 실행하세요."
  exit 1
fi
ok "Node.js $(node -v)"

# 2. pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm 을 PATH 에서 찾지 못했습니다. 'npm install -g pnpm' 후 다시 실행하세요. (또는 'corepack enable')"
  exit 1
fi
ok "pnpm $(pnpm -v)"

# 3. 환경 파일
if [ ! -f "$ROOT/.env.local" ]; then
  fail ".env.local 이 없습니다. .env.local 을 만들고 필요한 키를 채운 뒤 다시 실행하세요."
  exit 1
fi
ok ".env.local found"

# 4. 의존성 설치
if [ "$SKIP_INSTALL" -eq 1 ]; then
  step "의존성 설치 건너뜀 (--skip-install)"
else
  step "의존성 설치 (pnpm install --frozen-lockfile)"
  pnpm install --frozen-lockfile
  ok "Dependencies installed"
fi

# 5. 시작 (dev — 빌드 단계 없음, 온디맨드 컴파일 + HMR)
if [ "$NO_START" -eq 1 ]; then
  ok "설치 완료. 서버 시작은 건너뜀 (--no-start)."
  exit 0
fi

export PORT="$PORT"
step "개발 서버 시작(HMR): http://localhost:$PORT  (중지하려면 Ctrl+C)"
exec pnpm dev --port "$PORT"
