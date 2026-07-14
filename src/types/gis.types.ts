export interface GisSyncRequest {
    unionId: string;
    addresses: string[];
    actorUserId: string;
}

export interface GisJobInfo {
    jobId: string;
    unionId: string;
    totalCount: number;
    processedCount: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    error?: string;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
}

/**
 * 공동주택공시가격 일괄 재동기화 요청 (2026-04)
 * 한 조합의 공동주택(VILLA / APARTMENT / MIXED) 세대 공시가격만 갱신
 */
export interface ApartmentPriceSyncRequest {
    unionId: string;
    actorUserId: string;
}

/**
 * 공동주택공시가격 재동기화 대상 단위 필지
 * building_land_lots → buildings → building_units 조인 결과의 한 행
 */
export interface ApartmentPriceSyncTarget {
    pnu: string;
    buildingId: string;
    buildingType: string;
}

/**
 * 개별주택가격 일괄 재동기화 요청 (2026-05)
 * 한 조합의 단독주택(DETACHED_HOUSE) 건물 공시가격만 갱신
 */
export interface IndividualHousingPriceSyncRequest {
    unionId: string;
    actorUserId: string;
}

/**
 * 개별주택가격 재동기화 대상 단위 필지
 */
export interface IndividualHousingPriceSyncTarget {
    pnu: string;
    buildingId: string;
    buildingType: string;
}

/**
 * 토지 공시지가 일괄 재동기화 요청 (2026-04)
 * 해당 조합의 land_lots 전체 PNU에 대해 VWorld 개별공시지가를 재조회해
 * land_lots.official_price를 갱신한다.
 */
export interface LandPriceSyncRequest {
    unionId: string;
    actorUserId: string;
}

/**
 * 토지 공시지가 재동기화 대상 필지
 */
export interface LandPriceSyncTarget {
    pnu: string;
}
