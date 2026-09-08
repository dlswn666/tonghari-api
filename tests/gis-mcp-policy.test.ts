import assert from 'node:assert/strict';
import test from 'node:test';
import {
    GIS_MCP_CLIENT_ID,
    GIS_MCP_REQUIRED_SCOPE,
    LookupBuildingRegisterInputV1Schema,
    LookupHousingOfficialPriceInputV1Schema,
    PUBLIC_DATA_MCP_MAX_YEAR,
    PUBLIC_DATA_MCP_POLICY_RESOURCE_URI,
    PUBLIC_DATA_MCP_SERVER_NAME,
    PUBLIC_DATA_MCP_TOOL_NAMES,
    ResolveAddressToPnuInputV1Schema,
} from '../src/services/public-data-mcp/policy';

test('GIS MCP 공개 계약은 기존 5개와 전체 조회·건물 윤곽 도구 및 별도 scope를 고정한다', () => {
    assert.equal(PUBLIC_DATA_MCP_SERVER_NAME, 'tonghari-public-gis');
    assert.equal(GIS_MCP_REQUIRED_SCOPE, 'gis:read');
    assert.equal(GIS_MCP_CLIENT_ID, 'tonghari-gis-mcp');
    assert.equal(PUBLIC_DATA_MCP_POLICY_RESOURCE_URI, 'tonghari-gis://policy/public-data/v1');
    assert.deepEqual(PUBLIC_DATA_MCP_TOOL_NAMES, [
        'resolve_address_to_pnu_v1',
        'lookup_parcel_public_data_v1',
        'lookup_building_register_v1',
        'lookup_housing_official_price_v1',
        'lookup_land_right_registration_v1',
        'lookup_full_gis_public_data_v1',
        'lookup_building_footprints_v1',
    ]);
});

test('입력 schema는 주소/PNU/연도/pagination만 strict하게 허용한다', () => {
    assert.equal(ResolveAddressToPnuInputV1Schema.safeParse({ address: ' ' }).success, false);
    assert.equal(ResolveAddressToPnuInputV1Schema.safeParse({ address: '가'.repeat(301) }).success, false);
    assert.equal(ResolveAddressToPnuInputV1Schema.safeParse({
        address: '서울특별시 강북구 미아동 791-1982',
        endpoint: 'https://attacker.test',
    }).success, false);
    assert.equal(LookupBuildingRegisterInputV1Schema.safeParse({
        pnu: '1130510100107911982', offset: 0, limit: 100,
    }).success, true);
    assert.equal(LookupBuildingRegisterInputV1Schema.safeParse({
        pnu: '113051010010791198', offset: 0, limit: 101,
    }).success, false);
    assert.equal(LookupHousingOfficialPriceInputV1Schema.safeParse({
        pnu: '1130510100107911982', year: 1999, offset: 0, limit: 1,
    }).success, false);
    assert.equal(LookupHousingOfficialPriceInputV1Schema.safeParse({
        pnu: '1130510100107911982', year: PUBLIC_DATA_MCP_MAX_YEAR + 1,
        offset: 0, limit: 1,
    }).success, false);
});
