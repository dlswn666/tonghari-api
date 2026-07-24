import { validateLandAreaSyncRuntimeAllowlist } from '../verification/land-area-sync-runtime-allowlist';

try {
    const attestation = validateLandAreaSyncRuntimeAllowlist({
        action: process.env.LAND_AREA_SYNC_RUNTIME_ACTION,
        rawAllowedTargets: process.env.LAND_AREA_SYNC_ALLOWED_TARGETS,
        expectedCount: process.env.EXPECTED_ALLOWLIST_COUNT,
        expectedDigest: process.env.EXPECTED_ALLOWLIST_DIGEST,
    });

    // workflow 전용 machine-readable 출력. allowlist 원문은 출력하지 않는다.
    process.stdout.write(`${attestation.count}:${attestation.digest}\n`);
} catch (error) {
    process.stderr.write(
        `${
            error instanceof Error
                ? error.message
                : 'Runtime allowlist 검증에 실패했습니다.'
        }\n`
    );
    process.exitCode = 1;
}
