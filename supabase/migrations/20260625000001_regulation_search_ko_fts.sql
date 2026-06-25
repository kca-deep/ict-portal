-- 한국어 조사/어미 때문에 simple+websearch_to_tsquery(AND) 매칭이 0건이 되는 문제 수정.
-- 예: 문서 토큰 '초과근무수당' vs 질의 토큰 '초과근무수당을'(조사 '을') → simple config 는
--     정규화를 하지 않아 영원히 불일치. 게다가 websearch 는 전 토큰 AND 라 recall 이 0 에 수렴.
-- 해결: 질의를 변별 토큰만 남겨(조사·어미·불용어 제거) OR + prefix(:*) tsquery 로 변환한다.
--      문서 색인(fts)·임베딩은 그대로 두므로 재색인 불필요.

-- 질의 텍스트 → OR/prefix tsquery 변환기.
--  1) 한글/영숫자 외 문자로 토큰 분리
--  2) 각 토큰의 흔한 조사/어미를 어미 제거(휴리스틱)
--  3) 2글자 미만·불용어 제거
--  4) 남은 토큰을 'tok:* | tok:*' 로 결합 (없으면 NULL → full_text 절 건너뜀)
create or replace function public.ko_tsquery(query_text text)
returns tsquery
language sql
immutable
as $$
  with toks as (
    select regexp_replace(
             t,
             '(에서|에게|으로|까지|부터|이라도|라도|이나|보다|처럼|마다|하는|하여|합니다|되는|에|의|와|과|로|도|만|나|할|한|해|했|될|은|는|이|가|을|를)$',
             ''
           ) as tok
    from unnest(
           regexp_split_to_array(lower(coalesce(query_text, '')), '[^가-힣a-z0-9]+')
         ) as t
  ),
  kept as (
    select distinct tok
    from toks
    where length(tok) >= 2
      and tok not in (
        -- 전 코퍼스에 흔해 변별력이 없는 도메인어 + 의문/보조 어절
        '기금','사업','사업비','관한','경우','대한','지급','기준','내용','관련',
        '있니','있나','있는','없나','없는','가능','여부','어떻','무엇','하나','한다'
      )
  ),
  expr as (select string_agg(tok || ':*', ' | ') as e from kept)
  select case
           when (select e from expr) is null or (select e from expr) = '' then null
           else to_tsquery('simple', (select e from expr))
         end;
$$;

comment on function public.ko_tsquery is
  '한국어 질의 → OR/prefix tsquery (조사·어미·불용어 제거). simple config 의 조사 불일치/AND recall 0 문제 보정.';

-- regulation_search: full_text 절의 tsquery 생성만 ko_tsquery 로 교체. 나머지(semantic·RRF) 동일.
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
  with kq as (
    select public.ko_tsquery(query_text) as tq
  ),
  full_text as (
    select
      d.id,
      row_number() over (order by ts_rank_cd(d.fts, kq.tq) desc) as rank_ix
    from public.regulation d, kq
    where kq.tq is not null
      and d.fts @@ kq.tq
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
  'regulation 전용 Hybrid search (한국어 ko_tsquery OR/prefix + vector RRF).';
