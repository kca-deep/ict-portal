-- regulation 테이블용 Hybrid Search (documents 용 hybrid_search 와 동일 패턴)
-- tsvector(BM25 유사) + pgvector(내적) → RRF 결합

create or replace function public.regulation_search(
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
    from public.regulation d
    where query_text is not null
      and length(query_text) > 0
      and d.fts @@ websearch_to_tsquery('simple', query_text)
    order by rank_ix
    limit least(match_count, 50) * 2
  ),
  semantic as (
    select
      d.id,
      row_number() over (order by d.embedding <#> query_embedding) as rank_ix
    from public.regulation d
    where d.embedding is not null
    order by rank_ix
    limit least(match_count, 50) * 2
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
  join public.regulation d on d.id = coalesce(full_text.id, semantic.id)
  order by rrf_score desc
  limit least(match_count, 50);
$$;

comment on function public.regulation_search is
  'regulation 전용 Hybrid search (BM25 + vector RRF). documents 의 hybrid_search 와 동일 패턴.';
