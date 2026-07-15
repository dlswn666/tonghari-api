# Building registry Phase 0-B read-only preflight

Observed at: `2026-07-14T23:45:50Z` (`2026-07-15 08:45 KST`)

Scope: production project `tonghari_prod` (`bpdjashtxqrcgxfequgf`), aggregate/catalog reads only. No DDL, DML, migration repair, deployment, or raw member/owner values were executed or retained.

The repeatable query is `scripts/phase0-b-readonly-preflight.sql`. These results are evidence for planning and do **not** close Phase 0-S, Phase 0-A, O0, or Phase 0-B gates.

## Schema and migration baseline

- PostgreSQL: `17.6.1.054` / engine `17`
- Operating migration history: `393` rows; every row has stored statements
- First/last recorded versions: `145` / `20260714025958`
- Ordered version/name/statement digest: `0e36550a8be4e379ae72d32bcf9c0b11e1cf5ae7a861b39cbc5f17d67071cf7c`
- Repository active migrations: `73` files (recorded separately by the deterministic repository manifest tooling)

The production history and repository migration directory are therefore not interchangeable. An audited full-schema baseline and disposable-clone replay are still required before W1 DDL.

## Aggregate risk inventory

| Metric | Value |
| --- | ---: |
| `sync_jobs.total` | 57 |
| `sync_jobs.union_id_null` | 0 |
| `sync_jobs.duplicate_id_groups` | 0 |
| `building_units.total` | 4,961 |
| `building_units.missing_dong_and_ho` | 1,843 |
| `building_units.missing_ho` | 1,966 |
| `building_units.duplicate_nonempty_ho_identity_groups` | 40 |
| `building_units.registry_external_id_null` | 4,910 |
| `building_units.duplicate_registry_external_id_groups` | 0 |
| `property_units.total` | 4,702 |
| `property_units.active` | 4,698 |
| `property_units.building_unit_id_nonnull` | 4,036 |
| `property_units.shared_active_pnu_groups` | 3 |
| `property_units.active_building_link_shared_pnu_rows` | 2 |
| `building_external_refs.total` | 1,557 |
| `building_external_refs.pnu_null` | 0 |
| `building_external_refs.conflicting_key_groups` | 0 |
| `building_land_lots.total` | 1,765 |
| `building_land_lots.orphan_building` | 0 |
| `buildings.total` | 1,770 |
| `buildings.orphan_without_lot` | 20 |

The `40` duplicate non-empty unit identity groups are preflight candidates, not rows approved for automatic merge. The three shared active-PNU groups and two linked rows are the minimum cross-union regression population that the A/B clone fixture must reproduce.

## Access-control finding

`building_external_refs` has RLS disabled, zero policies, and full table privileges for both `anon` and `authenticated`, including `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, and `TRIGGER`. The API uses this table through its service-role repository; the Web scan found no browser runtime consumer.

This must be locked by the first approved security migration after the audited baseline. The migration must enable RLS and revoke public/anonymous/authenticated access in the same transaction, while preserving the explicitly reviewed service-role path. It must not be applied ahead of Phase 0-A/O0.

## Deployment and route findings

- API SHA `940176d9c4020421a66ec1fa9cdc3932a6bed03c` was merged and pushed, but GitHub Actions run `29342191299` failed at Docker Hub login and skipped deployment. Phase 0-S is not proven deployed.
- `POST /api/member/pre-register` was reachable without the proxy JWT boundary even though it admits service-role writes to `users`, `property_units`, and `property_ownerships`. This invalidates the A/B safety premise until both Web token forwarding and API current-role/blocked/union-scope verification are deployed.
- `sync_member_invites(uuid,varchar,integer,jsonb)` is a destructive `SECURITY DEFINER` function that production currently exposes to `PUBLIC`, `anon`, and `authenticated` without an internal auth/role/blocked check. Route authentication alone is bypassable until the reviewed ACL-only migration is applied and negative direct-RPC evidence passes.
- Existing source-string guards do not replace an actual clone run of the property/ownership/minor-parcel hashes.

## Remaining hard gates

1. Apply and read back the `sync_member_invites` service-role-only ACL hotfix, then deploy and smoke-test the Phase 0-S API/Web security boundary with exact Git SHAs over HTTPS.
2. Run the A/B shared-PNU fixture for GIS, land price, apartment price, individual-housing price, and approved member import.
3. Capture `property_units`, `property_ownerships`, canonical member-property rows, minor-parcel outputs, building mappings, and orphan counts before/after without retaining PII in logs.
4. Generate the audited production application-schema baseline and prove byte-equivalent clean replay on a disposable clone.
5. Only after those gates pass, create W1 additive migrations and relation/projection code.
