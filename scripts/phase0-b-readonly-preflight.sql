-- Building registry parcel auto-link Phase 0-B read-only preflight.
--
-- This script intentionally returns aggregate evidence only. It must never be
-- extended with DML, DDL, raw owner/member values, or a migration-history
-- repair command. Run it with a role that can inspect the application schema
-- on production or a disposable clone.

begin;
set transaction read only;
set local statement_timeout = '30s';

select
    current_timestamp as observed_at,
    current_database() as database_name,
    current_setting('server_version') as postgres_version;

with metrics as (
    select 'sync_jobs.total'::text as metric, count(*)::bigint as value
      from public.sync_jobs
    union all
    select 'sync_jobs.union_id_null', count(*)
      from public.sync_jobs where union_id is null
    union all
    select 'sync_jobs.duplicate_id_groups', count(*)
      from (select id from public.sync_jobs group by id having count(*) > 1) duplicate_ids
    union all
    select 'building_units.total', count(*) from public.building_units
    union all
    select 'building_units.missing_dong_and_ho', count(*)
      from public.building_units
     where nullif(btrim(dong), '') is null and nullif(btrim(ho), '') is null
    union all
    select 'building_units.missing_ho', count(*)
      from public.building_units where nullif(btrim(ho), '') is null
    union all
    select 'building_units.duplicate_nonempty_ho_identity_groups', count(*)
      from (
        select
            building_id,
            coalesce(nullif(lower(btrim(dong)), ''), '∅') as normalized_dong,
            lower(btrim(ho)) as normalized_ho
          from public.building_units
         where nullif(btrim(ho), '') is not null
         group by 1, 2, 3
        having count(*) > 1
      ) duplicate_units
    union all
    select 'building_units.registry_external_id_null', count(*)
      from public.building_units where nullif(btrim(registry_external_id), '') is null
    union all
    select 'building_units.duplicate_registry_external_id_groups', count(*)
      from (
        select registry_external_id
          from public.building_units
         where nullif(btrim(registry_external_id), '') is not null
         group by registry_external_id
        having count(*) > 1
      ) duplicate_external_ids
    union all
    select 'property_units.total', count(*) from public.property_units
    union all
    select 'property_units.active', count(*)
      from public.property_units where is_deleted = false
    union all
    select 'property_units.building_unit_id_nonnull', count(*)
      from public.property_units where building_unit_id is not null
    union all
    select 'property_units.shared_active_pnu_groups', count(*)
      from (
        select pnu
          from public.property_units
         where is_deleted = false and pnu is not null
         group by pnu
        having count(distinct union_id) > 1
      ) shared_pnus
    union all
    select 'property_units.active_building_link_shared_pnu_rows', count(*)
      from public.property_units property_unit
     where property_unit.is_deleted = false
       and property_unit.building_unit_id is not null
       and property_unit.pnu in (
            select pnu
              from public.property_units
             where is_deleted = false and pnu is not null
             group by pnu
            having count(distinct union_id) > 1
       )
    union all
    select 'building_external_refs.total', count(*) from public.building_external_refs
    union all
    select 'building_external_refs.pnu_null', count(*)
      from public.building_external_refs where pnu is null
    union all
    select 'building_external_refs.conflicting_key_groups', count(*)
      from (
        select source, external_id, pnu
          from public.building_external_refs
         group by source, external_id, pnu
        having count(distinct building_id) > 1
      ) conflicting_external_refs
    union all
    select 'building_land_lots.total', count(*) from public.building_land_lots
    union all
    select 'building_land_lots.orphan_building', count(*)
      from public.building_land_lots mapping
      left join public.buildings building on building.id = mapping.building_id
     where building.id is null
    union all
    select 'buildings.total', count(*) from public.buildings
    union all
    select 'buildings.orphan_without_lot', count(*)
      from public.buildings building
      left join public.building_land_lots mapping on mapping.building_id = building.id
     where mapping.id is null
)
select metric, value from metrics order by metric;

select
    relation.relname as table_name,
    relation.relrowsecurity as rls_enabled,
    relation.relforcerowsecurity as rls_forced,
    count(policy.policyname)::integer as policy_count
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  left join pg_policies policy
    on policy.schemaname = namespace.nspname
   and policy.tablename = relation.relname
 where namespace.nspname = 'public'
   and relation.relkind in ('r', 'p')
   and relation.relname in (
       'sync_jobs',
       'building_units',
       'building_land_lots',
       'building_external_refs',
       'buildings',
       'land_lots',
       'property_units',
       'property_ownerships'
   )
 group by relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
 order by relation.relname;

select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name = 'building_external_refs'
 order by grantee, privilege_type;

select
    count(*)::bigint as history_count,
    min(version) as first_version,
    max(version) as last_version,
    count(*) filter (where statements is null or cardinality(statements) = 0)::bigint
        as entries_without_statements,
    encode(
        digest(
            string_agg(
                version || E'\t' || coalesce(name, '') || E'\t' ||
                encode(digest(array_to_string(statements, E'\n'), 'sha256'), 'hex'),
                E'\n' order by version
            ),
            'sha256'
        ),
        'hex'
    ) as history_manifest_sha256
  from supabase_migrations.schema_migrations;

rollback;
