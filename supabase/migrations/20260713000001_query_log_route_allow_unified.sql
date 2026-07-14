-- 통합 검색 개편(2026-07): route 에 'unified' 허용.
--
-- 배경: query_log.route 는 마이그레이션상 평문 text 였으나, 원격 DB 에
-- query_log_route_check ('regulation'|'law'|'out_of_scope') 제약이 직접(드리프트)
-- 걸려 있어 통합 파이프라인의 route='unified' 적재가 실패했다. 제약을 마이그레이션
-- 관리로 편입하면서 'unified' 를 추가한다. 과거 값 3종은 레거시 행 조회용으로 유지.
alter table public.query_log drop constraint if exists query_log_route_check;
alter table public.query_log add constraint query_log_route_check
  check (route is null or route in ('unified', 'regulation', 'law', 'out_of_scope'));
