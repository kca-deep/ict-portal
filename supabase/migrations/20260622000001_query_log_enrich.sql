-- query_log 보강: no-login(IP 기반) 정리 + 파이프라인 신호 컬럼/인덱스 추가.
-- 기존 20260520000004_query_log_table.sql 은 수정하지 않고(PoC 원칙) 신규로 더한다.
-- 전 구문이 IF (NOT) EXISTS 라 재실행 안전(멱등). ※ 운영 DB에는 이미 적용되어 있어
-- 본 파일은 repo 스키마 진실원 기록용이며, 재적용 시 no-op 이다.

-- 1) no-login 정리: 로그인이 없어 무의미해진 user_id 기반 self 정책·인덱스·컬럼 제거.
--    (관리자 조회는 service_role 서버 전용 — RLS 우회. 7장에서 비밀번호로 보호.)
drop policy if exists "query_log_select_self" on public.query_log;
drop index  if exists public.query_log_user_idx;
alter table public.query_log drop column if exists user_id;

-- 2) 파이프라인 신호 컬럼 — 대부분 route.ts 가 이미 산출하는 값.
alter table public.query_log
  add column if not exists ip                       text,      -- user_id 대체(no-login)
  add column if not exists message_count            int,       -- 대화 턴 깊이
  add column if not exists answer_truncated         boolean,
  add column if not exists route                    text,      -- regulation | law | out_of_scope
  add column if not exists top_score                real,      -- rerank 최상위 관련도(maxScore)
  add column if not exists below_threshold          boolean,
  add column if not exists gate_sufficient          boolean,   -- 회색지대 적합성 게이트 결과
  add column if not exists out_of_scope             boolean,
  add column if not exists retrieved                jsonb,     -- [{id,score}] 재정렬 상위
  add column if not exists law_refs                 jsonb,     -- [{name,lawId}] 법령 분기 시
  add column if not exists citation_count           int,
  add column if not exists citation_verified_count  int,
  add column if not exists has_hallucination        boolean,
  add column if not exists ttft_ms                  int,       -- 첫 토큰 지연
  add column if not exists error_code               text;

-- route 값 제약(정의된 세 분기만 허용).
alter table public.query_log drop constraint if exists query_log_route_check;
alter table public.query_log
  add constraint query_log_route_check
  check (route is null or route in ('regulation', 'law', 'out_of_scope'));

-- 3) 인덱스: IP별 사용량 / 분기 비율 / 환각 추적(부분).
create index if not exists query_log_ip_idx     on public.query_log (ip, created_at desc);
create index if not exists query_log_route_idx  on public.query_log (route, created_at desc);
create index if not exists query_log_halluc_idx on public.query_log (created_at desc)
  where has_hallucination is true;

-- 4) RLS: enable 유지. authenticated/anon 조회 정책 없음(공개 키로 조회 불가).
--    적재·관리자 조회는 service_role(RLS 우회) 전용.
alter table public.query_log enable row level security;
