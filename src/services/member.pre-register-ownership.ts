export function getAutoOwnershipRatio(ownerCount: number): number {
    if (!Number.isFinite(ownerCount) || ownerCount <= 1) return 100;
    return Math.trunc((100 / ownerCount) * 10000) / 10000;
}
