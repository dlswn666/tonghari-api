import { isLandAreaUnchanged } from './member.land-area-canonical';

export interface ExistingPropertyUnitValues {
    propertyAddressJibun: string | null;
    propertyAddressRoad: string | null;
    buildingName: string | null;
    landArea: number | string | null;
    buildingArea: number | string | null;
}

export interface ExistingOwnershipValues {
    landOwnershipRatio: number | string | null;
    buildingOwnershipRatio: number | string | null;
    ownershipRatio: number | string | null;
    ownershipType: string | null;
    notes: string | null;
}

export interface ExistingPropertyImportValues {
    propertyAddressJibun?: string;
    propertyAddressRoad?: string;
    buildingName?: string;
    landArea: number | null;
    buildingArea: number | null;
    landOwnershipRatio: number;
    buildingOwnershipRatio: number;
    ownershipRatio: number;
    ownershipType: 'OWNER' | 'CO_OWNER' | 'FAMILY';
    notes?: string;
}

function sameNumeric(left: number | string | null, right: number): boolean {
    return left !== null && Number(left) === right;
}

/** 동일 물건 재업로드에서 실제 입력값이 달라진 컬럼만 반환한다. */
export function buildExistingPropertyImportPatches(input: {
    existingProperty: ExistingPropertyUnitValues;
    existingOwnership: ExistingOwnershipValues;
    incoming: ExistingPropertyImportValues;
}): {
    propertyUnitPatch: Record<string, unknown>;
    ownershipPatch: Record<string, unknown>;
} {
    const { existingProperty, existingOwnership, incoming } = input;
    const propertyUnitPatch: Record<string, unknown> = {};
    const ownershipPatch: Record<string, unknown> = {};

    if (
        incoming.propertyAddressJibun &&
        existingProperty.propertyAddressJibun !== incoming.propertyAddressJibun
    ) {
        propertyUnitPatch.property_address_jibun = incoming.propertyAddressJibun;
    }
    if (
        incoming.propertyAddressRoad &&
        existingProperty.propertyAddressRoad !== incoming.propertyAddressRoad
    ) {
        propertyUnitPatch.property_address_road = incoming.propertyAddressRoad;
    }
    if (incoming.buildingName && existingProperty.buildingName !== incoming.buildingName) {
        propertyUnitPatch.building_name = incoming.buildingName;
    }
    // land_area는 canonical(소수 4자리) 비교로 실제 변경 여부를 판정한다(DESIGN §16).
    // '19.70'과 '19.7'처럼 표현만 다른 값은 dirty로 취급하지 않는다.
    if (incoming.landArea !== null && !isLandAreaUnchanged(existingProperty.landArea, incoming.landArea)) {
        propertyUnitPatch.land_area = incoming.landArea;
    }
    if (incoming.buildingArea !== null && !sameNumeric(existingProperty.buildingArea, incoming.buildingArea)) {
        propertyUnitPatch.building_area = incoming.buildingArea;
    }

    if (!sameNumeric(existingOwnership.landOwnershipRatio, incoming.landOwnershipRatio)) {
        ownershipPatch.land_ownership_ratio = incoming.landOwnershipRatio;
    }
    if (!sameNumeric(existingOwnership.buildingOwnershipRatio, incoming.buildingOwnershipRatio)) {
        ownershipPatch.building_ownership_ratio = incoming.buildingOwnershipRatio;
    }
    if (!sameNumeric(existingOwnership.ownershipRatio, incoming.ownershipRatio)) {
        ownershipPatch.ownership_ratio = incoming.ownershipRatio;
    }
    if (existingOwnership.ownershipType !== incoming.ownershipType) {
        ownershipPatch.ownership_type = incoming.ownershipType;
    }
    if (incoming.notes && existingOwnership.notes !== incoming.notes) {
        ownershipPatch.notes = incoming.notes;
    }

    return { propertyUnitPatch, ownershipPatch };
}
