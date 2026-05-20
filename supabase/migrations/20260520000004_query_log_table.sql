-- 사용자 질의/응답 로그 - 사용자 로그 분석 모듈의 데이터 소스
create table if not exists public.query_log (
  id                 bigint generated always as identity primary key,
  session_id         uuid,
  user_id            uuid references auth.users(id) on delete set null,
  query              text   not null,
  answer             text,
  retrieved_doc_ids  bigint[] default '{}',
  cited_law_refs     jsonb,                  -- [{"law":"근로기준법","article":"제53조","date":"2024-05-17"}, ...]
  citation_verified  boolean,                -- verify_citation 도구 통과 여부
  llm_model          text,
  retrieval_ms       int,
  rerank_ms          int,
  llm_ms             int,
  total_ms           int,
  tokens_in          int,
  tokens_out         int,
  feedback           smallint check (feedback between -1 and 1),
  feedback_note      text,
  created_at         timestamptz not null default now()
);

create index if not exists query_log_created_at_idx on public.query_log (created_at desc);
create index if not exists query_log_user_idx       on public.query_log (user_id, created_at desc);
create index if not exists query_log_feedback_idx   on public.query_log (feedback) where feedback is not null;

alter table public.query_log enable row level security;

-- 사용자는 자기 로그만 조회
create policy "query_log_select_self"
  on public.query_log for select
  to authenticated
  using (auth.uid() = user_id);

-- 인서트는 service_role 만 (백엔드)
