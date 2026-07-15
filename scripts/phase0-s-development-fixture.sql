-- Phase 0-S 영구 개발 프로젝트용 합성 A/B 공유-PNU fixture.
-- 운영 데이터나 개인정보를 복사하지 않으며 migration/seed 체인에 포함하지 않는다.
-- 반드시 target guard가 있는 실행기에서 tonghari_dev에만 적용한다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
    if exists (
        select 1
          from public.unions
         where (
             id in (
                 '00000000-0000-4000-a000-000000000001'::uuid,
                 '00000000-0000-4000-a000-000000000002'::uuid
             )
             or slug in ('phase0-s-fixture-a', 'phase0-s-fixture-b')
         )
           and description is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ) then
        raise exception 'Phase 0-S fixture union identity가 기존 비-fixture 행과 충돌합니다.';
    end if;

    if exists (
        select 1
          from public.users
         where id in ('phase0-s-fixture-user-a', 'phase0-s-fixture-user-b')
           and notes is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ) then
        raise exception 'Phase 0-S fixture user identity가 기존 비-fixture 행과 충돌합니다.';
    end if;

    if exists (
        select 1
          from public.property_units
         where id in (
             '00000000-0000-4000-a000-000000000101'::uuid,
             '00000000-0000-4000-a000-000000000102'::uuid
         )
           and notes is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ) then
        raise exception 'Phase 0-S fixture property identity가 기존 비-fixture 행과 충돌합니다.';
    end if;

    if exists (
        select 1
          from public.property_ownerships
         where id in (
             '00000000-0000-4000-a000-000000000201'::uuid,
             '00000000-0000-4000-a000-000000000202'::uuid
         )
           and notes is distinct from '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ) then
        raise exception 'Phase 0-S fixture ownership identity가 기존 비-fixture 행과 충돌합니다.';
    end if;

    if exists (
        select 1
          from public.buildings
         where id = '00000000-0000-4000-a000-000000000301'::uuid
           and building_name is distinct from 'Phase 0-S 합성빌라'
    ) then
        raise exception 'Phase 0-S fixture building identity가 기존 비-fixture 행과 충돌합니다.';
    end if;

    if exists (
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
        raise exception 'Phase 0-S fixture building-land-lot identity가 기존 비-fixture 행과 충돌합니다.';
    end if;
end
$$;

-- 정확히 fixture identity만 정리해 반복 실행을 멱등하게 만든다.
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
 where id in ('phase0-s-fixture-user-a', 'phase0-s-fixture-user-b');
delete from public.unions
 where id in (
     '00000000-0000-4000-a000-000000000001'::uuid,
     '00000000-0000-4000-a000-000000000002'::uuid
 );
delete from public.buildings
 where id = '00000000-0000-4000-a000-000000000301'::uuid;

insert into public.unions (
    id,
    name,
    slug,
    description,
    district_name,
    region_code,
    rights_calculation_baseline_date,
    minor_parcel_land_area_threshold_sqm
) values
    (
        '00000000-0000-4000-a000-000000000001'::uuid,
        'Phase 0-S 합성 조합 A',
        'phase0-s-fixture-a',
        '[PHASE0_S_SYNTHETIC_FIXTURE]',
        '합성 A구역',
        '11305',
        date '2026-01-01',
        90
    ),
    (
        '00000000-0000-4000-a000-000000000002'::uuid,
        'Phase 0-S 합성 조합 B',
        'phase0-s-fixture-b',
        '[PHASE0_S_SYNTHETIC_FIXTURE]',
        '합성 B구역',
        '11305',
        date '2026-01-01',
        90
    );

insert into public.users (
    id,
    name,
    role,
    union_id,
    user_status,
    birth_date,
    voting_weight,
    entity_type,
    notes
) values
    (
        'phase0-s-fixture-user-a',
        '합성 조합원 A',
        'USER',
        '00000000-0000-4000-a000-000000000001'::uuid,
        'APPROVED',
        date '1990-01-01',
        1,
        'INDIVIDUAL',
        '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ),
    (
        'phase0-s-fixture-user-b',
        '합성 조합원 B',
        'USER',
        '00000000-0000-4000-a000-000000000002'::uuid,
        'APPROVED',
        date '1991-01-01',
        1,
        'INDIVIDUAL',
        '[PHASE0_S_SYNTHETIC_FIXTURE]'
    );

-- 같은 실제 PNU를 각 조합의 독립 필지 원장으로 유지한다.
insert into public.land_lots (pnu, union_id, address, address_text, area, land_category)
values
    (
        '1130510100107450062',
        '00000000-0000-4000-a000-000000000001'::uuid,
        '서울특별시 강북구 미아동 745-62',
        '합성 조합 A 공유 PNU',
        80,
        '대'
    ),
    (
        '1130510100107450062',
        '00000000-0000-4000-a000-000000000002'::uuid,
        '서울특별시 강북구 미아동 745-62',
        '합성 조합 B 공유 PNU',
        80,
        '대'
    );

-- 물건지는 조합별 독립 행이며 building_unit_id는 Phase F 승인 전까지 NULL이다.
insert into public.property_units (
    id,
    union_id,
    pnu,
    previous_pnu,
    building_unit_id,
    property_address_jibun,
    property_address_road,
    dong,
    ho,
    building_name,
    land_area,
    building_area,
    notes
) values
    (
        '00000000-0000-4000-a000-000000000101'::uuid,
        '00000000-0000-4000-a000-000000000001'::uuid,
        '1130510100107450062',
        null,
        null,
        '서울특별시 강북구 미아동 745-62 A동 101호',
        null,
        'A동',
        '101호',
        'Phase 0-S 합성빌라',
        80,
        55,
        '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ),
    (
        '00000000-0000-4000-a000-000000000102'::uuid,
        '00000000-0000-4000-a000-000000000002'::uuid,
        '1130510100107450062',
        null,
        null,
        '서울특별시 강북구 미아동 745-62 B동 202호',
        null,
        'B동',
        '202호',
        'Phase 0-S 합성빌라',
        80,
        60,
        '[PHASE0_S_SYNTHETIC_FIXTURE]'
    );

insert into public.property_ownerships (
    id,
    property_unit_id,
    user_id,
    union_id,
    ownership_type,
    ownership_ratio,
    land_ownership_ratio,
    building_ownership_ratio,
    is_primary,
    is_active,
    notes
) values
    (
        '00000000-0000-4000-a000-000000000201'::uuid,
        '00000000-0000-4000-a000-000000000101'::uuid,
        'phase0-s-fixture-user-a',
        '00000000-0000-4000-a000-000000000001'::uuid,
        'OWNER',
        100,
        100,
        100,
        true,
        true,
        '[PHASE0_S_SYNTHETIC_FIXTURE]'
    ),
    (
        '00000000-0000-4000-a000-000000000202'::uuid,
        '00000000-0000-4000-a000-000000000102'::uuid,
        'phase0-s-fixture-user-b',
        '00000000-0000-4000-a000-000000000002'::uuid,
        'OWNER',
        100,
        100,
        100,
        true,
        true,
        '[PHASE0_S_SYNTHETIC_FIXTURE]'
    );

-- 한 물리 건물 projection을 공유하지만 소유 물건지 원장은 연결하지 않는다.
insert into public.buildings (
    id,
    building_type,
    building_name,
    main_purpose,
    floor_count,
    total_unit_count
) values (
    '00000000-0000-4000-a000-000000000301'::uuid,
    'VILLA',
    'Phase 0-S 합성빌라',
    '공동주택',
    3,
    2
);

insert into public.building_land_lots (id, building_id, pnu, updated_by, note)
values (
    '00000000-0000-4000-a000-000000000401'::uuid,
    '00000000-0000-4000-a000-000000000301'::uuid,
    '1130510100107450062',
    'phase0-s-fixture',
    '[PHASE0_S_SYNTHETIC_FIXTURE]'
);

do $$
declare
    union_count integer;
    property_count integer;
    ownership_count integer;
    shared_union_count integer;
    linked_property_count integer;
begin
    select count(*) into union_count
      from public.unions
     where id in (
         '00000000-0000-4000-a000-000000000001'::uuid,
         '00000000-0000-4000-a000-000000000002'::uuid
     );
    select count(*), count(*) filter (where building_unit_id is not null)
      into property_count, linked_property_count
      from public.property_units
     where id in (
         '00000000-0000-4000-a000-000000000101'::uuid,
         '00000000-0000-4000-a000-000000000102'::uuid
     );
    select count(*) into ownership_count
      from public.property_ownerships
     where id in (
         '00000000-0000-4000-a000-000000000201'::uuid,
         '00000000-0000-4000-a000-000000000202'::uuid
     );
    select count(distinct union_id) into shared_union_count
      from public.property_units
     where pnu = '1130510100107450062'
       and is_deleted = false;

    if union_count <> 2
       or property_count <> 2
       or ownership_count <> 2
       or shared_union_count <> 2
       or linked_property_count <> 0 then
        raise exception 'Phase 0-S fixture 검증 실패: unions=%, properties=%, ownerships=%, shared_unions=%, linked_properties=%',
            union_count,
            property_count,
            ownership_count,
            shared_union_count,
            linked_property_count;
    end if;
end
$$;

commit;
