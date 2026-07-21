-- query_log 에 요청당 외부 API 사용량 집계 컬럼 추가.
-- /api/chat 한 요청이 부르는 유료 API(OpenAI 임베딩 · Cohere 재정렬 · Anthropic 보조
-- LLM(의도 분해·범위 게이트) · 법제처 DRF)의 호출 수·토큰·과금 단위를 lib/usage/ledger 가
-- 요청 스코프로 집계해 그대로 적재한다. 답변 LLM 토큰은 기존 tokens_in/out 유지.
-- 관리자 대시보드의 제공자별 사용량 패널 + 비용가드 합산의 데이터 소스.

alter table public.query_log
  add column if not exists api_usage jsonb;

comment on column public.query_log.api_usage is
  '요청당 외부 API 사용량 — {openai_embed_calls, openai_embed_tokens, cohere_calls, cohere_search_units, anthropic_aux_calls, anthropic_aux_in, anthropic_aux_out, law_api_calls}';
