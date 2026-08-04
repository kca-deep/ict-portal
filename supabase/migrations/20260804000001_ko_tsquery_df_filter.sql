-- 렉시컬 검색 recall 붕괴 수정 — 고빈도 토큰이 희귀 토큰을 밀어내는 문제.
--
-- 증상: 별표1·별표3 항목명을 물으면 정답 청크가 후보에서 아예 탈락한다.
--   "피복비"                            → 렉시컬 1위
--   "피복비를 사업비로 집행할 수 있나요?"   → 후보 50건 밖 (사라짐)
--
-- 원인: ko_tsquery 는 토큰을 OR 로 묶는데, regulation_search 의 full_text 절은
--   ts_rank_cd 로 순위를 매긴다. ts_rank_cd 는 어휘 빈도·근접도만 보고 IDF(희귀도)를
--   반영하지 않아, 흔한 토큰이 자주 나오는 문서가 상위를 채우고 희귀 토큰 하나로
--   정답을 특정하는 문서는 limit 밖으로 밀린다.
--   (실측 DF: 집행 94/441=21.3%, 사업비 89/441=20.2% vs 피복비 1/441=0.2%)
--
-- 해결: 질의 토큰 중 문서빈도(DF)가 MAX_DF 를 넘는 것을 렉시컬 절에서 제외한다.
--   하드코딩 불용어 목록은 모든 고빈도 도메인어를 예측할 수 없어(실제로 '집행' 누락)
--   코퍼스 실측 DF 로 대체한다. 벡터 절은 원질의 임베딩을 그대로 쓰므로 영향이 없고,
--   색인·임베딩·스키마 변경이 없어 재색인도 불필요하다.
--
-- 실측 효과 (별표1·별표3 항목명에서 도출한 57개 질의):
--   정답 청크 회수 30/57(53%) → 57/57(100%), 회귀 0건.

-- 시그니처·반환형은 그대로 두고 본문만 교체한다(regulation_search 수정 불필요).
-- volatility 는 immutable → stable (코퍼스 DF 를 조회하므로). fts 생성 컬럼과
-- regulation_fts_gin_idx 는 to_tsvector 기반이라 이 함수에 의존하지 않는다.
create or replace function public.ko_tsquery(query_text text)
returns tsquery
language sql
stable
as $$
  with params as (
    -- 이 비율을 넘는 토큰은 변별력이 없다고 보고 렉시컬 절에서 제외.
    -- 0.12 기준: 집행(21%)·사업비(20%) 제외, 기준(11%)·가능(5%) 유지.
    select 0.12::float as max_df
  ),
  toks as (
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
        '기금','사업','사업비','관한','경우','대한','지급','기준','내용','관련',
        '있니','있나','있는','없나','없는','가능','여부','어떻','무엇','하나','한다'
      )
  ),
  total as (select greatest(count(*), 1)::float as n from public.regulation),
  -- 토큰별 문서빈도. prefix(:*) 기준이라 tsquery 가 실제로 거는 조건과 동일하다.
  scored as (
    select
      k.tok,
      (
        select count(*)
        from public.regulation d
        where d.fts @@ to_tsquery('simple', k.tok || ':*')
      )::float / (select n from total) as df
    from kept k
  ),
  filtered as (
    select tok from scored, params where df <= params.max_df
  ),
  -- 전 토큰이 고빈도라 모두 걸러지는 질의(예: "사업비 집행 절차")에서는 가장 희귀한
  -- 하나를 살려 렉시컬 절이 통째로 비는 것을 막는다.
  final as (
    select tok from filtered
    union
    select tok from (select tok from scored order by df, tok limit 1) s
    where not exists (select 1 from filtered)
  ),
  expr as (select string_agg(tok || ':*', ' | ' order by tok) as e from final)
  select case
           when (select e from expr) is null or (select e from expr) = '' then null
           else to_tsquery('simple', (select e from expr))
         end;
$$;

comment on function public.ko_tsquery is
  '한국어 질의 → OR/prefix tsquery. 조사·어미·불용어 제거 + 코퍼스 문서빈도(DF>12%) 토큰 제외(ts_rank_cd 의 IDF 부재 보정).';
