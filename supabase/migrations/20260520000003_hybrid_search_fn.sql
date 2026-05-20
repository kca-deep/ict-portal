-- Hybrid Search: tsvector(BM25 유사) + pgvector(코사인/내적) → RRF 결합
-- 호출 권한: 백엔드 service_role 또는 authenticated
-- security invoker 기본값으로 두어 호출자의 RLS 정책이 적용되도록 함

create or replace function public.hybrid_search(
  query_text       text,
  query_embedding  extensions.vector(1024),
  match_count      int     default 30,
  full_text_weight float   default 1.0,
  semantic_weight  float   default 1.0,
  rrf_k            int     default 50
)
returns table (
  id          bigint,
  source      text,
  doc_type    text,
  title       text,
  content     text,
  source_ref  text,
  metadata    jsonb,
  rrf_score   float
)
language sql
stable
as $$
  with full_text as (
    select
      d.id,
      row_number() over (order by ts_rank_cd(d.fts, websearch_to_tsquery('simple', query_text)) desc) as rank_ix
    from public.documents d
    where d.fts @@ websearch_to_tsquery('simple', query_text)
    order by rank_ix
    limit least(match_count, 30) * 2
  ),
  semantic as (
    select
      d.id,
      row_number() over (order by d.embedding <#> query_embedding) as rank_ix
    from public.documents d
    where d.embedding is not null
    order by rank_ix
    limit least(match_count, 30) * 2
  )
  select
    d.id,
    d.source,
    d.doc_type,
    d.title,
    d.content,
    d.source_ref,
    d.metadata,
    (
      coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
      coalesce(1.0 / (rrf_k + semantic.rank_ix),  0.0) * semantic_weight
    )::float as rrf_score
  from full_text
  full outer join semantic on full_text.id = semantic.id
  join public.documents d on d.id = coalesce(full_text.id, semantic.id)
  order by rrf_score desc
  limit least(match_count, 30);
$$;

comment on function public.hybrid_search is
  'Hybrid search (BM25 + vector) with Reciprocal Rank Fusion. Returns top match_count documents.';
