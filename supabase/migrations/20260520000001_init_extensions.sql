-- pgvector + 한국어 보조 검색용 확장 활성화
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- 향후 한국어 형태소 검색이 필요하면 pg_bigm 추가 검토
-- (Supabase Pro 이상에서 활성화 가능 여부 사전 확인 필요)
