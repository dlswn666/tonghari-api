export const LAND_AREA_SYNC_DISABLED_CODE = 'LAND_AREA_SYNC_DISABLED';
export const LAND_AREA_SYNC_DISABLED_MESSAGE =
    '적용 토지면적 동기화는 현재 비활성화되어 있습니다.';

export class LandAreaSyncDisabledError extends Error {
    readonly code = LAND_AREA_SYNC_DISABLED_CODE;

    constructor() {
        super(LAND_AREA_SYNC_DISABLED_MESSAGE);
        this.name = 'LandAreaSyncDisabledError';
    }
}

/**
 * 라우트 외 내부 호출도 OFF 상태에서 영속 작업이나 메모리 admission으로 진입하지 못하게 한다.
 */
export function assertLandAreaSyncEnabled(enabled: boolean): void {
    if (!enabled) {
        throw new LandAreaSyncDisabledError();
    }
}
