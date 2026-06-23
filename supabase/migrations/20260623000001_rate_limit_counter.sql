-- 레이트리밋/일일 비용캡 카운터 (공개 오픈 골격). 임계·정리는 후속 개선.
create table if not exists rate_limit_counter (
  bucket text primary key,          -- 예: "ip:1.2.3.4:202606231012" | "global:20260623"
  count integer not null default 0,
  expires_at timestamptz not null
);

alter table rate_limit_counter enable row level security;
-- 명시 정책 없음 → service_role 만 접근(요청 경로는 admin 클라이언트 사용).

-- 버킷 카운터를 원자적으로 +1 하고 현재값을 반환. 없으면 1로 생성.
create or replace function increment_rate_limit(
  p_bucket text,
  p_expires timestamptz
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into rate_limit_counter (bucket, count, expires_at)
    values (p_bucket, 1, p_expires)
  on conflict (bucket)
    do update set count = rate_limit_counter.count + 1
  returning count into v_count;
  return v_count;
end;
$$;
