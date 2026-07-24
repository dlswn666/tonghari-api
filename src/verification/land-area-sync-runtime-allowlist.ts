import { createLandAreaSyncAllowedTargetsManifest } from '../security/land-area-sync-canary-policy';

export type LandAreaSyncRuntimeAction = 'enable' | 'disable';

export interface LandAreaSyncRuntimeAllowlistInput {
    action: string | undefined;
    rawAllowedTargets: string | undefined;
    expectedCount: string | undefined;
    expectedDigest: string | undefined;
}

export interface LandAreaSyncRuntimeAllowlistAttestation {
    action: LandAreaSyncRuntimeAction;
    count: number;
    digest: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * GitHub Actions가 EC2의 런타임 설정을 바꾸기 전에 실행하는 fail-closed 검증이다.
 *
 * allowlist 원문은 오류 메시지나 결과에 포함하지 않는다. enable은 canonical
 * development target만 허용하고, disable은 빈 allowlist/count=0/digest=empty를
 * 강제한다.
 */
export function validateLandAreaSyncRuntimeAllowlist(
    input: LandAreaSyncRuntimeAllowlistInput
): LandAreaSyncRuntimeAllowlistAttestation {
    if (input.action !== 'enable' && input.action !== 'disable') {
        throw new Error('Runtime action은 enable 또는 disable이어야 합니다.');
    }

    const rawAllowedTargets = input.rawAllowedTargets ?? '';
    const expectedCount = input.expectedCount ?? '';
    const expectedDigest = input.expectedDigest ?? '';

    if (input.action === 'disable') {
        if (
            rawAllowedTargets !== '' ||
            expectedCount !== '0' ||
            expectedDigest !== ''
        ) {
            throw new Error(
                'disable은 빈 allowlist, expected count 0, 빈 digest만 허용합니다.'
            );
        }
        return {
            action: 'disable',
            count: 0,
            digest: '',
        };
    }

    if (!/^[1-9][0-9]*$/.test(expectedCount)) {
        throw new Error('enable expected count는 양의 정수여야 합니다.');
    }
    if (!SHA256_RE.test(expectedDigest)) {
        throw new Error(
            'enable expected digest는 소문자 64자리 SHA-256이어야 합니다.'
        );
    }

    const manifest =
        createLandAreaSyncAllowedTargetsManifest(rawAllowedTargets);
    if (manifest.count === 0) {
        throw new Error('enable allowlist는 비어 있을 수 없습니다.');
    }
    if (manifest.canonicalValue !== rawAllowedTargets) {
        throw new Error(
            'enable allowlist는 공백 없이 소문자 UUID와 정렬된 canonical 형식이어야 합니다.'
        );
    }
    if (
        manifest.canonicalValue
            .split(',')
            .some((entry) => !entry.startsWith('development:'))
    ) {
        throw new Error(
            'runtime allowlist는 exact development target만 허용합니다.'
        );
    }
    if (String(manifest.count) !== expectedCount) {
        throw new Error('runtime allowlist count가 승인 입력과 일치하지 않습니다.');
    }
    if (manifest.digest !== expectedDigest) {
        throw new Error('runtime allowlist digest가 승인 입력과 일치하지 않습니다.');
    }

    return {
        action: 'enable',
        count: manifest.count,
        digest: manifest.digest,
    };
}
