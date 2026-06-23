-- query_log 보강 — 챗봇 파이프라인이 실제로 산출하는 신호를 적재할 수 있게 컬럼·인덱스를 추가한다.
-- 기존 20260520000004_query_log_table.sql 은 수정하지 않는다(PoC 원칙: 기존 마이그레이션 불변, 신규 추가).
--
-- 운영 전제 변경: 이 서비스는 "로그인 없이" 운영한다.
--   → 로그인이 없으므로 user_id(auth.users FK)와 본인/관리자 RLS 정책은 무의미하다.
--   → 사용자 식별은 요청 IP 로 대체한다(레이트리밋과 동일 소스).
--   → 관리자 페이지는 service_role(RLS 우회)로 서버에서 읽고, 별도 관리자 비밀번호로 보호한다.
--
-- 아래 컬럼은 app/api/chat/route.ts 가 한 요청 동안 만들어내는 변수와 1:1로 대응한다.

-- ── 로그인 제거에 따른 정리: user_id·관련 정책·인덱스 삭제 ──
-- (정책이 컬럼을 참조하므로 정책 → 인덱스 → 컬럼 순으로 제거)
drop policy if exists "query_log_select_self"  on public.query_log;
drop policy if exists "query_log_select_admin" on public.query_log;
drop index  if exists public.query_log_user_idx;
alter table public.query_log drop column if exists user_id;

-- ── 사용자 식별: 요청 IP ────────────────────────────────────
alter table public.query_log
  add column if not exists ip               text;       -- 요청 IP(x-forwarded-for 첫 주소). 레이트리밋과 동일 소스

-- ── 세션·응답 상태 ──────────────────────────────────────────
alter table public.query_log
  add column if not exists message_count    int,        -- 요청 시점 대화 메시지 수(턴 깊이) = messages.length
  add column if not exists answer_truncated boolean default false;  -- 생성 중단/오류로 답변 미완 여부

-- ── 라우팅(분기) — 파이프라인 핵심 신호 ─────────────────────
alter table public.query_log
  add column if not exists route            text,       -- 'regulation' | 'law' | 'out_of_scope'
  add column if not exists top_score        real,       -- 재정렬 최상위 관련도(0~1) = maxScore
  add column if not exists below_threshold  boolean,    -- maxScore < RELEVANCE_THRESHOLD
  add column if not exists gate_sufficient  boolean,    -- 적합성 게이트 결과(null = 미실행)
  add column if not exists out_of_scope     boolean;    -- 범위 게이트 결과

-- route 는 정해진 세 값만 허용(NULL 은 통과 — 적재 실패/구버전 행 대비).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'query_log_route_chk'
  ) then
    alter table public.query_log
      add constraint query_log_route_chk
      check (route is null or route in ('regulation', 'law', 'out_of_scope'));
  end if;
end $$;

-- ── 검색 근거 ───────────────────────────────────────────────
alter table public.query_log
  add column if not exists retrieved        jsonb,      -- [{id,score}] 재정렬 상위 근거(오프라인 Recall 평가용)
  add column if not exists law_refs         jsonb;      -- [{name,lawId,score}] 법령 분기 시 검색된 법령

-- ── 인용 검증(환각 차단) ────────────────────────────────────
-- 기존 cited_law_refs(jsonb) 에 CitationVerdict[](body 제외)를, citation_verified(boolean)에
-- "환각 없음(= !hasHallucination)"을 적재한다. 아래는 집계·필터링용 보강 컬럼.
alter table public.query_log
  add column if not exists citation_count          int default 0,
  add column if not exists citation_verified_count int default 0,
  add column if not exists has_hallucination       boolean default false;  -- not_found 가 하나라도 있으면 true

-- ── 성능 ────────────────────────────────────────────────────
-- retrieval_ms·rerank_ms·llm_ms·total_ms 는 기존 컬럼 재사용. ttft 만 추가.
alter table public.query_log
  add column if not exists ttft_ms          int;        -- 첫 토큰까지(ms) — 목표 ≤ 3000

-- ── 진단 ────────────────────────────────────────────────────
alter table public.query_log
  add column if not exists error_code       text;       -- 오류 분류 코드(원문 금지 — 에러 일반화 정책과 일관)

-- ── 인덱스 ──────────────────────────────────────────────────
create index if not exists query_log_ip_idx
  on public.query_log (ip, created_at desc);             -- IP별 사용량·이상 호출 추적

create index if not exists query_log_route_idx
  on public.query_log (route);                           -- 분기 비율 집계

create index if not exists query_log_halluc_idx
  on public.query_log (created_at desc) where has_hallucination;  -- 환각 발생 추적

-- ── RLS ─────────────────────────────────────────────────────
-- RLS 는 enable 상태 유지(20260520000004 에서 활성). 로그인이 없으므로 authenticated/anon
-- 직접 조회 정책은 두지 않는다(= 익명/공개 키로는 조회 불가). 관리자 페이지는 service_role
-- 키로 서버에서만 읽으며 RLS 를 우회한다. insert(적재) 도 service_role 전용.
