import { createLandAreaSyncAllowedTargetsManifest } from '../security/land-area-sync-canary-policy';

const manifest = createLandAreaSyncAllowedTargetsManifest(
    process.env.LAND_AREA_SYNC_ALLOWED_TARGETS
);

// 배포 workflow 전용 machine-readable 출력. allowlist 원문은 출력하지 않는다.
process.stdout.write(`${manifest.count}:${manifest.digest}\n`);
