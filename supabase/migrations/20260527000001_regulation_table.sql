-- ICT 기금 규정 등 별도 색인 대상 문서 저장소
-- documents 테이블과 동일한 스키마 (컬럼/인덱스/트리거/RLS) 유지
create table if not exists public.regulation (
  id              bigint generated always as identity primary key,
  source          text   not null,                       -- 'internal_regulation' | 'guideline' | 'faq' | 'interpretation_case'
  doc_type        text,                                  -- 세부 유형 (예: '운영규정', '시행세칙')
  title           text,
  content         text   not null,
  chunk_index     int    not null default 0,             -- 원문 분할 인덱스
  source_ref      text,                                  -- 출처 식별자 (내부 문서번호 등)
  metadata        jsonb  not null default '{}'::jsonb,
  embedding       extensions.vector(1024),               -- Cohere embed-v4 (1024d)
  fts             tsvector generated always as (
                    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
                  ) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.regulation is 'PIMS 규정 전용 색인 문서. documents 와 동일 스키마, 분리 운영.';
comment on column public.regulation.embedding is 'Cohere embed-v4.0 1024-dim';
comment on column public.regulation.metadata is '예: {"chapter":"제2장","article":"제5조","tags":["사업비","집행"]}';

-- HNSW vector index (Supabase 2026 권장 기본)
create index if not exists regulation_embedding_hnsw_idx
  on public.regulation
  using hnsw (embedding extensions.vector_ip_ops);

-- 전문 검색 GIN
create index if not exists regulation_fts_gin_idx
  on public.regulation
  using gin (fts);

-- 메타데이터 / 출처 필터
create index if not exists regulation_source_idx on public.regulation (source);
create index if not exists regulation_metadata_gin_idx on public.regulation using gin (metadata);

-- updated_at 자동 갱신 (tg_set_updated_at 은 documents 마이그레이션에서 이미 정의됨)
drop trigger if exists set_updated_at on public.regulation;
create trigger set_updated_at
  before update on public.regulation
  for each row execute function public.tg_set_updated_at();

-- RLS: public 스키마 노출 정책 강제 활성화
alter table public.regulation enable row level security;

-- 일반 사용자는 인증된 경우 SELECT만 (RAG 검색용)
-- 쓰기는 service_role 만 (백엔드 API 라우트 전용)
create policy "regulation_select_authenticated"
  on public.regulation for select
  to authenticated
  using (true);

-- service_role 은 RLS 우회하므로 별도 정책 불필요
