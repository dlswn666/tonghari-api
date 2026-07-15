import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExistingPropertyImportPatches } from '../src/services/member.pre-register-existing-property';

const existingProperty = {
    propertyAddressJibun: '서울특별시 강북구 미아동 745-62',
    propertyAddressRoad: null,
    buildingName: '합성빌라',
    landArea: '80.00',
    buildingArea: 55,
};

const existingOwnership = {
    landOwnershipRatio: '100.00',
    buildingOwnershipRatio: 100,
    ownershipRatio: '100',
    ownershipType: 'OWNER',
    notes: '기존 메모',
};

test('동일 물건 재업로드는 updated_at을 포함한 불필요한 patch를 만들지 않는다', () => {
    assert.deepEqual(
        buildExistingPropertyImportPatches({
            existingProperty,
            existingOwnership,
            incoming: {
                propertyAddressJibun: existingProperty.propertyAddressJibun,
                buildingName: existingProperty.buildingName,
                landArea: 80,
                buildingArea: 55,
                landOwnershipRatio: 100,
                buildingOwnershipRatio: 100,
                ownershipRatio: 100,
                ownershipType: 'OWNER',
            },
        }),
        { propertyUnitPatch: {}, ownershipPatch: {} }
    );
});

test('실제 달라진 property-owned 값만 patch에 포함한다', () => {
    assert.deepEqual(
        buildExistingPropertyImportPatches({
            existingProperty,
            existingOwnership,
            incoming: {
                propertyAddressJibun: existingProperty.propertyAddressJibun,
                propertyAddressRoad: '서울특별시 강북구 새 도로 1',
                buildingName: existingProperty.buildingName,
                landArea: 81,
                buildingArea: 55,
                landOwnershipRatio: 50,
                buildingOwnershipRatio: 100,
                ownershipRatio: 50,
                ownershipType: 'CO_OWNER',
                notes: '변경 메모',
            },
        }),
        {
            propertyUnitPatch: {
                property_address_road: '서울특별시 강북구 새 도로 1',
                land_area: 81,
            },
            ownershipPatch: {
                land_ownership_ratio: 50,
                ownership_ratio: 50,
                ownership_type: 'CO_OWNER',
                notes: '변경 메모',
            },
        }
    );
});

test('입력에 없는 선택값은 기존 값을 null로 지우지 않는다', () => {
    const result = buildExistingPropertyImportPatches({
        existingProperty: { ...existingProperty, propertyAddressRoad: '기존 도로', buildingName: '기존 건물' },
        existingOwnership,
        incoming: {
            landArea: null,
            buildingArea: null,
            landOwnershipRatio: 100,
            buildingOwnershipRatio: 100,
            ownershipRatio: 100,
            ownershipType: 'OWNER',
        },
    });
    assert.deepEqual(result, { propertyUnitPatch: {}, ownershipPatch: {} });
});
