import type { LandAreaSyncRuntimeAction } from './land-area-sync-runtime-allowlist';

export interface LandAreaSyncRuntimeWatermark {
    runNumber: number;
    runAttempt: number;
    action: LandAreaSyncRuntimeAction;
}

export interface LandAreaSyncRuntimeRequest {
    runNumber: number;
    runAttempt: number;
    action: LandAreaSyncRuntimeAction;
}

export type LandAreaSyncRuntimeOrderDecision =
    | {
          kind: 'APPLY';
          nextWatermark: LandAreaSyncRuntimeWatermark;
      }
    | {
          kind: 'VERIFY_ALREADY_APPLIED';
          nextWatermark: LandAreaSyncRuntimeWatermark;
      }
    | {
          kind: 'STALE';
          nextWatermark: LandAreaSyncRuntimeWatermark;
      };

function assertPositiveInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name}는 양의 safe integer여야 합니다.`);
    }
}

/**
 * github.run_number는 workflow 단위 monotonic ordering으로 사용한다.
 * run_attempt는 같은 요청의 재시도 metadata일 뿐 ordering을 앞당기지 않는다.
 *
 * disable은 안전 tombstone이므로 기존 watermark보다 오래된 요청이어도 적용하며
 * watermark sequence를 되감지 않는다. 요청 watermark는 실제 env/container 적용
 * 실패와 별개로 영속되어 이후의 stale enable을 계속 막아야 한다.
 */
export function decideLandAreaSyncRuntimeOrder(
    current: LandAreaSyncRuntimeWatermark | null,
    request: LandAreaSyncRuntimeRequest
): LandAreaSyncRuntimeOrderDecision {
    assertPositiveInteger(request.runNumber, 'runNumber');
    assertPositiveInteger(request.runAttempt, 'runAttempt');
    if (current) {
        assertPositiveInteger(current.runNumber, 'current.runNumber');
        assertPositiveInteger(current.runAttempt, 'current.runAttempt');
    }

    if (!current) {
        return {
            kind: 'APPLY',
            nextWatermark: request,
        };
    }

    if (request.action === 'disable') {
        if (request.runNumber < current.runNumber) {
            return {
                kind: 'APPLY',
                nextWatermark: {
                    ...current,
                    action: 'disable',
                },
            };
        }
        if (request.runNumber === current.runNumber) {
            return {
                kind: 'APPLY',
                nextWatermark: {
                    runNumber: current.runNumber,
                    runAttempt: Math.max(
                        current.runAttempt,
                        request.runAttempt
                    ),
                    action: 'disable',
                },
            };
        }
        return {
            kind: 'APPLY',
            nextWatermark: request,
        };
    }

    if (request.runNumber < current.runNumber) {
        return {
            kind: 'STALE',
            nextWatermark: current,
        };
    }
    if (request.runNumber === current.runNumber) {
        return {
            kind:
                current.action === 'enable'
                    ? 'VERIFY_ALREADY_APPLIED'
                    : 'STALE',
            nextWatermark: current,
        };
    }

    return {
        kind: 'APPLY',
        nextWatermark: request,
    };
}
