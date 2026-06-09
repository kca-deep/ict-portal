-- 규정·내부지침·FAQ·해석사례 등 자체 색인 문서 저장소
-- 외부 법령 원문은 법제처 OpenAPI로 실시간 조회하므로 여기 저장하지 않음
create table if not exists public.documents (
  id              bigint generated always as identity primary key,
  source          text   not null,                       -- 'internal_regulation' | 'guideline' | 'faq' | 'interpretation_case'
  doc_type        text,                                  -- 세부 유형 (예: '운영규정', '시행세칙')
  title           text,
  content         text   not null,
  chunk_index     int    not null default 0,             -- 원문 분할 인덱스
  source_ref      text,                                  -- 출처 식별자 (내부 문서번호 등)
  metadata        jsonb  not null default '{}'::jsonb,
  embedding       extensions.vector(1024),               -- OpenAI text-embedding-3-small (1024d)
  fts             tsvector generated always as (
                    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
                  ) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.documents is 'PIMS 자체 색인 문서 (내부 규정/FAQ/해석사례). 외부 법령은 법제처 OpenAPI로 실시간 조회.';
comment on column public.documents.embedding is 'OpenAI text-embedding-3-small 1024-dim';
comment on column public.documents.metadata is '예: {"chapter":"제2장","article":"제5조","tags":["사업비","집행"]}';

-- HNSW vector index (Supabase 2026 권장 기본)
create index if not exists documents_embedding_hnsw_idx
  on public.documents
  using hnsw (embedding extensions.vector_ip_ops);

-- 전문 검색 GIN
create index if not exists documents_fts_gin_idx
  on public.documents
  using gin (fts);

-- 메타데이터 / 출처 필터
create index if not exists documents_source_idx on public.documents (source);
create index if not exists documents_metadata_gin_idx on public.documents using gin (metadata);

-- updated_at 자동 갱신
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.documents;
create trigger set_updated_at
  before update on public.documents
  for each row execute function public.tg_set_updated_at();

-- RLS: public 스키마 노출 정책 강제 활성화
alter table public.documents enable row level security;

-- 일반 사용자는 인증된 경우 SELECT만 (RAG 검색용)
-- 쓰기는 service_role 만 (백엔드 API 라우트 전용)
create policy "documents_select_authenticated"
  on public.documents for select
  to authenticated
  using (true);

-- service_role 은 RLS 우회하므로 별도 정책 불필요
