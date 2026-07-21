#!/usr/bin/env bash
# ============================================================================
# Supabase 계정 이전(구→신) 데이터 마이그레이션 — regulation·query_log·documents
#
# 사전 조건:
#   1. 신규(운영) Supabase 프로젝트 생성 완료
#   2. 스키마 적용 완료:  supabase link --project-ref <신규ref>  →  pnpm db:push
#      (migrations 가 테이블·HNSW 인덱스·RLS·검색 RPC 까지 전부 재현)
#   3. .env.migration 에 OLD_DB_URL / NEW_DB_URL 채움
#
# 사용법:
#   bash scripts/migrate-supabase.sh preflight   # 연결·스키마·행수 사전 점검(무해)
#   bash scripts/migrate-supabase.sh copy        # 데이터 복사(신규 테이블 비어있을 때만)
#   bash scripts/migrate-supabase.sh copy --force-truncate  # 신규측 3개 테이블 비우고 재복사
#   bash scripts/migrate-supabase.sh verify      # 행수·임베딩 차원 대조
#   bash scripts/migrate-supabase.sh all         # preflight → 확인 → copy → verify
#
# 임베딩(vector 1024d)은 pg_dump 텍스트 직렬화로 무손실 복사되며 재색인 불필요.
# 완료 후: .env.local·Vercel 의 SUPABASE URL/ANON/SERVICE_ROLE 키 교체 → 스모크 테스트
# → 구 프로젝트는 며칠 유지 후 정리. 이 파일과 .env.migration 은 이전 후 삭제.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

# pg 클라이언트: PATH 우선, 없으면 Homebrew libpq(keg-only) 폴백.
if ! command -v pg_dump >/dev/null 2>&1; then
  export PATH="/opt/homebrew/opt/libpq/bin:/usr/local/opt/libpq/bin:$PATH"
fi
command -v pg_dump >/dev/null || { echo "❌ pg_dump 없음 — brew install libpq"; exit 1; }
command -v psql >/dev/null || { echo "❌ psql 없음 — brew install libpq"; exit 1; }

[ -f .env.migration ] || { echo "❌ .env.migration 없음"; exit 1; }
set -a; source .env.migration; set +a
[ -n "${OLD_DB_URL:-}" ] || { echo "❌ OLD_DB_URL 미설정"; exit 1; }
[ -n "${NEW_DB_URL:-}" ] || { echo "❌ NEW_DB_URL 미설정 — 신규 프로젝트 생성 후 채우세요"; exit 1; }

TABLES=(regulation query_log documents)

q() { psql "$1" -X -A -t -c "$2"; }  # 단일 값 질의

counts() { # $1=DB_URL $2=라벨
  echo "  [$2]"
  for t in "${TABLES[@]}"; do
    printf "    %-12s %s행\n" "$t" "$(q "$1" "select count(*) from public.$t")"
  done
}

preflight() {
  echo "── 사전 점검 ──────────────────────────────"
  echo "  구(OLD) 연결: $(q "$OLD_DB_URL" 'select 1' >/dev/null && echo OK)"
  echo "  신(NEW) 연결: $(q "$NEW_DB_URL" 'select 1' >/dev/null && echo OK)"
  # 신규측 스키마(테이블 + vector 확장) 존재 확인 — db:push 선행 여부 검증
  for t in "${TABLES[@]}"; do
    ok=$(q "$NEW_DB_URL" "select count(*) from information_schema.tables where table_schema='public' and table_name='$t'")
    [ "$ok" = "1" ] || { echo "❌ 신규 DB 에 public.$t 없음 — pnpm db:push 먼저 실행"; exit 1; }
  done
  vec=$(q "$NEW_DB_URL" "select count(*) from pg_extension where extname='vector'")
  [ "$vec" = "1" ] || { echo "❌ 신규 DB 에 vector 확장 없음 — pnpm db:push 먼저 실행"; exit 1; }
  echo "  신규 스키마: OK (테이블 3종 + vector 확장)"
  counts "$OLD_DB_URL" "구(OLD) 행수"
  counts "$NEW_DB_URL" "신(NEW) 행수"
  echo "───────────────────────────────────────────"
}

copy() {
  # 신규측이 비어있지 않으면 중복 적재 방지를 위해 중단(--force-truncate 로 재실행 가능)
  local force="${1:-}"
  local nonempty=""
  for t in "${TABLES[@]}"; do
    n=$(q "$NEW_DB_URL" "select count(*) from public.$t")
    [ "$n" != "0" ] && nonempty="$nonempty $t($n)"
  done
  if [ -n "$nonempty" ]; then
    if [ "$force" = "--force-truncate" ]; then
      echo "⚠️  신규측 비우기:$nonempty"
      for t in "${TABLES[@]}"; do
        psql "$NEW_DB_URL" -X -c "truncate public.$t restart identity" >/dev/null
      done
    else
      echo "❌ 신규측 테이블이 비어있지 않음:$nonempty"
      echo "   재복사하려면: bash scripts/migrate-supabase.sh copy --force-truncate"
      exit 1
    fi
  fi
  echo "── 데이터 복사(임베딩 포함) ──"
  pg_dump "$OLD_DB_URL" --data-only --no-owner --no-privileges \
    --table=public.regulation --table=public.query_log --table=public.documents \
    | psql "$NEW_DB_URL" -X -q --single-transaction -v ON_ERROR_STOP=1
  echo "  복사 완료"
}

verify() {
  echo "── 검증 ──────────────────────────────────"
  local fail=0
  for t in "${TABLES[@]}"; do
    o=$(q "$OLD_DB_URL" "select count(*) from public.$t")
    n=$(q "$NEW_DB_URL" "select count(*) from public.$t")
    if [ "$o" = "$n" ]; then
      printf "  %-12s %s = %s ✅\n" "$t" "$o" "$n"
    else
      printf "  %-12s 구 %s ≠ 신 %s ❌\n" "$t" "$o" "$n"; fail=1
    fi
  done
  # 임베딩 무결성: 비-null 임베딩 수 + 차원(1024) 대조
  for t in regulation documents; do
    oe=$(q "$OLD_DB_URL" "select count(*) from public.$t where embedding is not null")
    ne=$(q "$NEW_DB_URL" "select count(*) from public.$t where embedding is not null")
    nd=$(q "$NEW_DB_URL" "select coalesce(max(vector_dims(embedding)),0) from public.$t")
    if [ "$oe" = "$ne" ] && { [ "$nd" = "1024" ] || [ "$nd" = "0" ]; }; then
      printf "  %-12s 임베딩 %s건·%sd ✅\n" "$t" "$ne" "$nd"
    else
      printf "  %-12s 임베딩 구 %s/신 %s·%sd ❌\n" "$t" "$oe" "$ne" "$nd"; fail=1
    fi
  done
  # 검색 RPC 동작 스모크(더미 벡터로 호출 자체가 성공하는지)
  rpc=$(q "$NEW_DB_URL" "select count(*) from public.regulation_search(repeat('0.001,',1023)||'0.001', '기금', 3)" 2>/dev/null || echo "ERR")
  if [ "$rpc" = "ERR" ]; then echo "  regulation_search RPC ❌"; fail=1; else echo "  regulation_search RPC 호출 OK(${rpc}건) ✅"; fi
  echo "───────────────────────────────────────────"
  if [ "$fail" = "0" ]; then
    echo "✅ 검증 통과 — 다음: .env.local·Vercel 의 SUPABASE 3키 교체 후 스모크 테스트"
  else
    echo "❌ 검증 실패 — 구 프로젝트 유지 상태에서 원인 확인"
    exit 1
  fi
}

case "${1:-all}" in
  preflight) preflight ;;
  copy)      copy "${2:-}" ;;
  verify)    verify ;;
  all)
    preflight
    read -r -p "복사를 진행할까요? (yes 입력): " ans
    [ "$ans" = "yes" ] || { echo "중단"; exit 0; }
    copy "${2:-}"
    verify
    ;;
  *) echo "사용법: preflight | copy [--force-truncate] | verify | all"; exit 1 ;;
esac
