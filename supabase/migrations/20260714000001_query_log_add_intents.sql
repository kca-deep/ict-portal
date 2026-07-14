-- 복합 질의 의도 분해(2026-07 통합 검색 개편 후속): 분해된 하위 의도 목록 기록.
-- 단일 의도 질의는 null. 관리자에서 분해 품질(과분해·미분해)을 관찰하는 용도.
alter table public.query_log add column if not exists intents jsonb;
