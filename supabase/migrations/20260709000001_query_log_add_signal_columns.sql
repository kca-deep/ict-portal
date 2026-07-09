-- query_log 신호 컬럼 정합화.
-- 라이브 DB 에는 이미 추가돼 있으나 리포 마이그레이션(20260520000004)에는 빠져 있던
-- 컬럼들을 소스오브트루스로 복구한다. 관리자 대시보드(lib/db/query-log.ts)와 chat
-- 파이프라인(app/api/chat)이 실제로 쓰는/읽는 컬럼셋과 일치시킨다.
-- 모두 `add column if not exists` 라 라이브에는 no-op(안전), 새 환경 db:reset 재현성 확보.

alter table public.query_log add column if not exists ip                       text;
alter table public.query_log add column if not exists message_count            int;
alter table public.query_log add column if not exists answer_truncated         boolean;
alter table public.query_log add column if not exists route                    text;      -- 'regulation' | 'law' | 'out_of_scope'
alter table public.query_log add column if not exists top_score                double precision;  -- rerank 최상위 relevanceScore
alter table public.query_log add column if not exists below_threshold          boolean;
alter table public.query_log add column if not exists gate_sufficient          boolean;   -- 회색지대 적합성 게이트 결과(미호출 시 null)
alter table public.query_log add column if not exists out_of_scope             boolean;
alter table public.query_log add column if not exists retrieved                jsonb;     -- [{id, score}] 재정렬 상위 후보
alter table public.query_log add column if not exists law_refs                 jsonb;     -- [{name, lawId}] 라우팅 표시 법령
alter table public.query_log add column if not exists citation_count           int;
alter table public.query_log add column if not exists citation_verified_count  int;
alter table public.query_log add column if not exists has_hallucination        boolean;
alter table public.query_log add column if not exists ttft_ms                  int;       -- 첫 토큰까지 지연
alter table public.query_log add column if not exists error_code               text;
