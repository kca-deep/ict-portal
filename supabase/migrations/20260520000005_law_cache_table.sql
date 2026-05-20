-- 법제처 OpenAPI 응답 캐시 (법령 도구가 사용)
-- 응답 속도 + API 호출 한도 보호
create table if not exists public.law_cache (
  cache_key  text primary key,             -- e.g. 'search_law:근로기준법:제53조'
  tool_name  text not null,                -- 법령 도구명 (lib/law/tools.ts)
  payload    jsonb not null,
  ttl_at     timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists law_cache_ttl_idx on public.law_cache (ttl_at);

alter table public.law_cache enable row level security;
-- 캐시는 백엔드 전용 → 사용자 직접 접근 정책 없음 (service_role 만 RLS 우회)
