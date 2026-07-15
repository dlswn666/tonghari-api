-- Phase 0-S 합성 fixture만 제거한다. 운영 또는 일반 개발 데이터에는 사용하지 않는다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
    if exists (
        select 1
          from public.unions
         where id in (
             '00000000-0000-4000-a000-000000000001'::uuid,
             '00000000-0000-4000-a000-000000000002'::uuid
         )
           and description is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ) or exists (
        select 1
          from public.users
         where id in ('phase0-s-fixture-user-a', 'phase0-s-fixture-user-b')
           and notes is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ) or exists (
        select 1
          from public.property_units
         where id in (
             '00000000-0000-4000-a000-000000000101'::uuid,
             '00000000-0000-4000-a000-000000000102'::uuid
         )
           and notes is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ) or exists (
        select 1
          from public.property_ownerships
         where id in (
             '00000000-0000-4000-a000-000000000201'::uuid,
             '00000000-0000-4000-a000-000000000202'::uuid
         )
           and notes is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ) or exists (
        select 1
          from public.buildings
         where id = '00000000-0000-4000-a000-000000000301'::uuid
           and building_name is distinct from 'Phase 0-S 합성빌라'
    ) or exists (
        select 1
          from public.building_land_lots
         where (
             id = '00000000-0000-4000-a000-000000000401'::uuid
             or pnu = '1130510100107450062'
         )
           and (
             id is distinct from '00000000-0000-4000-a000-000000000401'::uuid
             or building_id is distinct from '00000000-0000-4000-a000-000000000301'::uuid
             or pnu is distinct from '1130510100107450062'
             or note is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
           )
    ) then
        raise exception 'Phase 0-S cleanup 대상에 비-fixture 행이 포함되어 중단합니다.';
    end if;
end
$$;

delete from public.property_ownership_history
 where property_unit_id in (
     '00000000-0000-4000-a000-000000000101'::uuid,
     '00000000-0000-4000-a000-000000000102'::uuid
 )
    or official_property_unit_id in (
     '00000000-0000-4000-a000-000000000101'::uuid,
     '00000000-0000-4000-a000-000000000102'::uuid
 )
    or property_ownership_id in (
     '00000000-0000-4000-a000-000000000201'::uuid,
     '00000000-0000-4000-a000-000000000202'::uuid
 );
delete from public.property_ownerships
 where id in (
     '00000000-0000-4000-a000-000000000201'::uuid,
     '00000000-0000-4000-a000-000000000202'::uuid
 );
delete from public.property_units
 where id in (
     '00000000-0000-4000-a000-000000000101'::uuid,
     '00000000-0000-4000-a000-000000000102'::uuid
 );
delete from public.land_lots
 where pnu = '1130510100107450062'
   and union_id in (
     '00000000-0000-4000-a000-000000000001'::uuid,
     '00000000-0000-4000-a000-000000000002'::uuid
 );
delete from public.users
 where id in ('phase0-s-fixture-user-a', 'phase0-s-fixture-user-b')
   and notes = '[PHASE0_S_SYNTHETIC_FIXTURE]';
delete from public.unions
 where id in (
     '00000000-0000-4000-a000-000000000001'::uuid,
     '00000000-0000-4000-a000-000000000002'::uuid
 )
   and description = '[PHASE0_S_SYNTHETIC_FIXTURE]';
delete from public.buildings
 where id = '00000000-0000-4000-a000-000000000301'::uuid
   and building_name = 'Phase 0-S 합성빌라';

commit;
