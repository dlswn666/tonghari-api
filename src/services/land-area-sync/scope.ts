/**
 * 공통 parcel-scope completeness gate + DB resolver 호출 + 3층 hash (DESIGN §11).
 *
 * DB resolver가 scan 대상을 확정한 뒤, LINKED의 모든 distinct base PNU 또는 no-cache
 * anchor에 대한 same-run title/bylot/attached strict scan을 전부 완료한 결과 묶음을 받아
 * 5종 상태 중 하나로 판정한다. 네트워크 없이 순수 판정만 수행한다.
 *
 * hash 책임 분리:
 *  - dbScopeHash: DB resolver가 반환한 값을 그대로 사용(재계산 금지).
 *  - externalScopeDigest: same-run 외부 scan의 endpoint·completeness·totalCount·정렬
 *    canonical identity rows·expected PK 집합·bylot 정책/원천/정규화 count/cross-check.
 *    요청시각·secret·raw body 제외.
 *  - scopeHash: strategy + 정렬 candidate property + membership + land tuple + 제안면적
 *    + dbScopeHash + externalScopeDigest의 versioned SHA-256.
 */

import { createHash } from 'node:crypto';
import type {
    BrTitleRow,
    BrAtchJibunRow,
    BrBasisOulnRow,
    StrictScan,
    StrictScanState,
    BylotSourcePolicy,
    ParcelScopeState,
    LandAreaSyncIssueCode,
} from '../../types/land-area-sync.types';
import { assembleAttachedPnus, type AtchJibunRowInput } from '../gis-shared/pnu';
import { resolveBylotCounts, BYLOT_SOURCE_POLICY, type BylotResolution } from './bylot';
import { classifyHousingType, type HousingClassification } from './classifier';
import { housingOtherPurposeSignals } from './housing-purpose-signals';
import {
    isOptionalRegistryManagementPkValid,
    normalizeRegistryManagementPk,
} from './registry-pk';

export const SCOPE_HASH_VERSION = 'land-area-sync/scope-hash@2';
export const EXTERNAL_SCOPE_DIGEST_VERSION = 'land-area-sync/external-scope-digest@3';

// ── DB resolver 결과 (DESIGN §11 계약) ────────────────────────────

export type DbScopeState = 'NO_EVIDENCE' | 'PENDING' | 'LINKED' | 'BLOCKING_EVIDENCE';

export interface DbBlockingEvidence {
    sourceKind: string;
    sourceId: string;
    state: string;
    reasonCode?: string;
}

export interface DbScopeResolution {
    dbState: DbScopeState;
    rootBuildingIdentities: string[];
    componentPnus: string[];
    /** LINKED positive-cache relation의 distinct base_pnu만 정렬한 집합. */
    linkedBasePnus: string[];
    /** LINKED component 전체 base∪attached PNU 집합. */
    linkedPnus: string[];
    linkedEvidenceKeys: string[];
    pendingEvidenceKeys: string[];
    blockingEvidence: DbBlockingEvidence[];
    openUnresolvedEvidenceKeys: string[];
    componentTruncated: boolean;
    propertyMembership: unknown[];
    dbScopeHash: string;
}

function asStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
}

/**
 * resolver jsonb 결과를 방어적으로 파싱한다. 누락 필드는 안전한 기본값으로 채우고,
 * 알 수 없는 dbState는 자동 진행을 막기 위해 BLOCKING_EVIDENCE로 취급한다.
 */
export function parseDbScopeResolution(data: unknown): DbScopeResolution {
    const o = (data ?? {}) as Record<string, unknown>;
    const rawState = typeof o.dbState === 'string' ? o.dbState : '';
    const dbState: DbScopeState =
        rawState === 'NO_EVIDENCE' || rawState === 'PENDING' || rawState === 'LINKED' || rawState === 'BLOCKING_EVIDENCE'
            ? rawState
            : 'BLOCKING_EVIDENCE';
    const blockingEvidence: DbBlockingEvidence[] = Array.isArray(o.blockingEvidence)
        ? o.blockingEvidence
              .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
              .map((x) => ({
                  sourceKind: String(x.sourceKind ?? ''),
                  sourceId: String(x.sourceId ?? ''),
                  state: String(x.state ?? ''),
                  reasonCode: typeof x.reasonCode === 'string' ? x.reasonCode : undefined,
              }))
        : [];
    return {
        dbState,
        rootBuildingIdentities: asStringArray(o.rootBuildingIdentities),
        componentPnus: asStringArray(o.componentPnus),
        linkedBasePnus: asStringArray(o.linkedBasePnus),
        linkedPnus: asStringArray(o.linkedPnus),
        linkedEvidenceKeys: asStringArray(o.linkedEvidenceKeys),
        pendingEvidenceKeys: asStringArray(o.pendingEvidenceKeys),
        blockingEvidence,
        openUnresolvedEvidenceKeys: asStringArray(o.openUnresolvedEvidenceKeys),
        componentTruncated: o.componentTruncated === true,
        propertyMembership: Array.isArray(o.propertyMembership) ? o.propertyMembership : [],
        dbScopeHash: typeof o.dbScopeHash === 'string' ? o.dbScopeHash : '',
    };
}

// ── DB resolver 호출 client ───────────────────────────────────────
//
// service-role 전용 `resolve_land_area_sync_scope_v1` 호출 자체는 orchestrator/apply
// task가 주입한다. 이 판정 계층은 서명 매핑·결과 파싱·오류 처리만 담당하고, 실제 클라이언트
// 호출은 주입한 caller로 위임한다.
//   - Phase 0-S writer-guard 정책상 새 `.rpc(...)` 호출은 정책 인벤토리(owner/rationale)
//     등록이 필요하므로, 판정 계층에서 직접 supabase 클라이언트를 참조하지 않는다.
//   - production wiring 예: `(p) => getSupabaseService(target).rpc('resolve_land_area_sync_scope_v1', p)`

/** DB resolver를 실제로 호출하는 주입 함수. RPC의 jsonb 결과와 오류를 그대로 반환한다. */
export type ScopeResolverInvoker = (
    params: { p_union_id: string; p_anchor_pnu: string; p_root_mgm_bldrgst_pks: string[] }
) => Promise<{ data: unknown; error: { message: string } | null }>;

export interface ScopeResolverDeps {
    /** DB resolver 호출을 위임할 함수. orchestrator가 service-role 클라이언트로 구성해 주입한다. */
    callResolver: ScopeResolverInvoker;
}

export interface ScopeResolverParams {
    unionId: string;
    anchorPnu: string;
    rootMgmBldrgstPks: string[];
}

/**
 * `resolve_land_area_sync_scope_v1` 인자를 조립해 주입된 caller로 호출하고 결과를 파싱한다.
 * RPC error는 throw한다.
 */
export async function callParcelScopeResolver(
    params: ScopeResolverParams,
    deps: ScopeResolverDeps
): Promise<DbScopeResolution> {
    const { data, error } = await deps.callResolver({
        p_union_id: params.unionId,
        p_anchor_pnu: params.anchorPnu,
        p_root_mgm_bldrgst_pks: params.rootMgmBldrgstPks,
    });
    if (error) {
        throw Object.assign(new Error('parcel-scope resolver RPC 실패'), { code: 'SCOPE_RESOLVER_RPC_ERROR' });
    }
    return parseDbScopeResolution(data);
}

// ── gate 입력·출력 ────────────────────────────────────────────────

/** 채택된 한 base PNU의 same-run strict scan 묶음 */
export interface BasePnuScan {
    pnu: string;
    title: StrictScan<BrTitleRow>;
    attached: StrictScan<BrAtchJibunRow>;
    /** fallback 정책에서 조회한 경우에만 존재 */
    basis?: StrictScan<BrBasisOulnRow>;
}

export interface ParcelScopeInput {
    dbScope: DbScopeResolution;
    baseScans: BasePnuScan[];
    policy: BylotSourcePolicy;
}

export interface ParcelScopeResult {
    state: ParcelScopeState;
    /** §14.3 issue code, 정렬·중복 제거 */
    issues: LandAreaSyncIssueCode[];
    expectedPks: string[];
    bylot: BylotResolution;
    classification: HousingClassification;
    /** 정렬된 distinct base PNU */
    scannedPnus: string[];
    dbScopeHash: string;
    externalScopeDigest: string;
}

function scanRows<T>(scan: StrictScan<T>): T[] {
    return scan.state === 'COMPLETE' ? scan.rows : [];
}

function normStr(v: unknown): string {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
    return '';
}

function hasInvalidRequiredPk(rows: Array<{ mgmBldrgstPk?: unknown }>): boolean {
    return rows.some((row) => normalizeRegistryManagementPk(row.mgmBldrgstPk) === null);
}

function hasInvalidOptionalUpPk(rows: Array<{ mgmUpBldrgstPk?: unknown }>): boolean {
    return rows.some((row) => !isOptionalRegistryManagementPkValid(row.mgmUpBldrgstPk));
}

/**
 * 공통 parcel-scope completeness gate (DESIGN §11).
 *
 * 반환 상태는 5종 중 하나이나, SINGLE_PNU_CONFIRMED는 이 함수가 스스로 발급하지 않는다
 * (자동 single 승격 금지). no-cache single은 SINGLE_SCOPE_CONFIRMATION_REQUIRED로 반환하고,
 * SINGLE_PNU_CONFIRMED는 confirmation 후속 job이 verifySinglePnuConfirmation으로만 발급한다.
 */
export function resolveParcelScopeCompleteness(input: ParcelScopeInput): ParcelScopeResult {
    const { dbScope, baseScans, policy } = input;
    const scannedBasePnus = [...new Set(baseScans.map((b) => b.pnu))].sort();
    const scannedPnus =
        dbScope.dbState === 'LINKED'
            ? [...new Set(dbScope.linkedPnus)].sort()
            : scannedBasePnus;

    // ── row 수집 + 필수 provider scan 상태 검사 ──
    const titleRows: BrTitleRow[] = [];
    const attachedRows: BrAtchJibunRow[] = [];
    const basisRows: BrBasisOulnRow[] = [];
    const basisFallbackInvoked = baseScans.some((b) => b.basis !== undefined);
    let scanFailure: LandAreaSyncIssueCode | null = null;
    let anyTitleZero = false;

    const failFromState = (st: StrictScanState, incompleteIssue: LandAreaSyncIssueCode, failedIssue: LandAreaSyncIssueCode) => {
        if (st === 'INCOMPLETE') scanFailure ??= incompleteIssue;
        else if (st === 'FAILED') scanFailure ??= failedIssue;
    };

    for (const b of baseScans) {
        // title 실패는 basis로 대체하지 않는다 (DESIGN §10.4, §11).
        failFromState(b.title.state, 'PAGINATION_INCOMPLETE', 'PROVIDER_PROTOCOL_ERROR');
        failFromState(b.attached.state, 'ATTACHED_SCAN_INCOMPLETE', 'ATTACHED_SCAN_INCOMPLETE');
        if (b.basis) failFromState(b.basis.state, 'PAGINATION_INCOMPLETE', 'PROVIDER_PROTOCOL_ERROR');
        if (b.title.state === 'COMPLETE_ZERO') anyTitleZero = true;
        titleRows.push(...scanRows(b.title));
        attachedRows.push(...scanRows(b.attached));
        if (b.basis) basisRows.push(...scanRows(b.basis));
    }

    // ── 파생 계산(FAILED여도 digest는 방어적으로 계산) ──
    if (
        hasInvalidRequiredPk(titleRows) ||
        hasInvalidOptionalUpPk(titleRows) ||
        hasInvalidRequiredPk(attachedRows) ||
        hasInvalidRequiredPk(basisRows) ||
        hasInvalidOptionalUpPk(basisRows)
    ) {
        scanFailure ??= 'PROVIDER_PROTOCOL_ERROR';
    }
    const attachedPks = attachedRows
        .map((r) => normalizeRegistryManagementPk(r.mgmBldrgstPk))
        .filter((p): p is string => p !== null);
    const normalizedAttachedRows = attachedRows.map((row) => ({
        ...row,
        mgmBldrgstPk: normalizeRegistryManagementPk(row.mgmBldrgstPk) ?? '',
    }));
    const attached = assembleAttachedPnus(normalizedAttachedRows as unknown as AtchJibunRowInput[]);
    const bylot = resolveBylotCounts({ policy, titleRows, basisRows, attachedPks, basisFallbackInvoked });
    const classification = classifyHousingType({
        titleRows: titleRows.map((r) => ({
            regstrGbCd: r.regstrGbCd,
            mainPurpsCd: r.mainPurpsCd,
            mainPurpsCdNm: r.mainPurpsCdNm,
            etcPurps:
                typeof r.etcPurps === 'string' ? r.etcPurps : undefined,
        })),
        rootIdentities: dbScope.rootBuildingIdentities,
    });
    const externalScopeDigest = buildExternalScopeDigest(baseScans, bylot, policy);

    const finalize = (state: ParcelScopeState, issues: LandAreaSyncIssueCode[]): ParcelScopeResult => ({
        state,
        issues: sortedDedup(issues),
        expectedPks: bylot.expectedPks,
        bylot,
        classification,
        scannedPnus,
        dbScopeHash: dbScope.dbScopeHash,
        externalScopeDigest,
    });

    // ── 1. 최우선: 필수 provider FAILED/INCOMPLETE → FAILED (apply 0) ──
    if (scanFailure) {
        return finalize('FAILED', [scanFailure]);
    }

    // ── 2. REVIEW 조건 수집(하나라도 있으면 REVIEW_REQUIRED, apply 0) ──
    const review: LandAreaSyncIssueCode[] = [];

    // component 50 초과 — 추정 절단 금지
    if (dbScope.componentTruncated || dbScope.componentPnus.length > 50) {
        review.push('SCOPE_COMPONENT_TOO_LARGE');
    }
    // DB evidence 차단
    if (dbScope.dbState === 'PENDING' || dbScope.pendingEvidenceKeys.length > 0) {
        review.push('SCOPE_PENDING');
    }
    if (dbScope.dbState === 'BLOCKING_EVIDENCE' || dbScope.blockingEvidence.length > 0 || dbScope.openUnresolvedEvidenceKeys.length > 0) {
        review.push('SCOPE_BLOCKING_EVIDENCE');
    }
    if (dbScope.dbState === 'LINKED') {
        const linkedBases = [...new Set(dbScope.linkedBasePnus)].sort();
        const linkedScope = new Set(dbScope.linkedPnus);
        if (
            linkedBases.length === 0 ||
            linkedBases.length !== scannedBasePnus.length ||
            linkedBases.some((pnu, index) => pnu !== scannedBasePnus[index]) ||
            linkedBases.some((pnu) => !linkedScope.has(pnu))
        ) {
            review.push('SCOPE_NOT_LINKED');
        }
    }
    // 분류할 표제부 없음 (TITLE_COMPLETE_ZERO)
    if (anyTitleZero) {
        review.push('BUILDING_CLASSIFICATION_CONFLICT');
    }
    // bylot 원천 판정 issue
    for (const i of bylot.issues) review.push(i);
    // 부속지번 PNU 조립 실패(블록지번·잘못된 지역코드 등) — self/dup pair는 무해
    if (attached.rejected.some((r) => r.reason.side !== 'PAIR')) {
        review.push('ATTACHED_PNU_INVALID');
    }
    // resolved bylotCnt vs distinct attached PNU 수 정합성 (per PK)
    const distinctAttachedByPk = new Map<string, Set<string>>();
    for (const p of attached.pairs) {
        const pk = normalizeRegistryManagementPk(p.mgmBldrgstPk);
        if (!pk) continue;
        const set = distinctAttachedByPk.get(pk) ?? new Set<string>();
        set.add(p.attachedPnu);
        distinctAttachedByPk.set(pk, set);
    }
    for (const ev of bylot.evidence) {
        if (ev.count === null) continue; // unavailable/conflict은 이미 bylot.issues로 처리
        const d = distinctAttachedByPk.get(ev.mgmBldrgstPk)?.size ?? 0;
        if (ev.count === 0 && d > 0) review.push('BYLOT_ATTACHED_COUNT_MISMATCH');
        else if (ev.count > 0 && ev.count !== d) review.push('BYLOT_ATTACHED_COUNT_MISMATCH');
    }
    // cache 없음인데 attached row 존재 → 관계 생성·승격 없이 REVIEW
    if (dbScope.dbState === 'NO_EVIDENCE' && attached.pairs.length > 0) {
        review.push('SCOPE_CACHE_SCAN_CONFLICT');
    }
    // 분류 REVIEW
    if (classification.kind === 'REVIEW_REQUIRED') {
        review.push(classification.issue);
    }
    // 일반건축물(LADFRL 계열) multi-PNU 금지
    const effectivePnuCount = dbScope.dbState === 'LINKED' ? new Set(dbScope.linkedPnus).size : scannedBasePnus.length;
    if (classification.kind === 'CLASSIFIED' && classification.family === 'LADFRL' && effectivePnuCount > 1) {
        review.push('MULTI_PNU_GENERAL_BUILDING');
    }
    // LINKED인데 linkedPnus와 complete attached scan이 exact 일치하지 않으면 REVIEW
    if (dbScope.dbState === 'LINKED' && !linkedExactMatch(dbScope, scannedBasePnus, attached.pairs)) {
        review.push('SCOPE_NOT_LINKED');
    }

    if (review.length > 0) {
        return finalize('REVIEW_REQUIRED', review);
    }

    // ── 3. 차단 조건 전무 → positive path ──
    if (dbScope.dbState === 'LINKED') {
        // exact match는 위에서 통과 확인됨
        return finalize('LINKED_SCOPE_RESOLVED', []);
    }
    if (dbScope.dbState === 'NO_EVIDENCE') {
        // 관계 없음 + same-run ATTACHED_COMPLETE_ZERO + 관리 PK별 bylot0 + 단일 anchor + 분류 성립
        const allZero = bylot.evidence.length > 0 && bylot.evidence.every((e) => e.count === 0);
        if (scannedBasePnus.length === 1 && classification.kind === 'CLASSIFIED' && allZero) {
            return finalize('SINGLE_SCOPE_CONFIRMATION_REQUIRED', []);
        }
        return finalize('REVIEW_REQUIRED', ['SCOPE_NOT_LINKED']);
    }
    // PENDING/BLOCKING은 위에서 REVIEW 처리됨 — 도달 시 방어적 REVIEW
    return finalize('REVIEW_REQUIRED', ['SCOPE_NOT_LINKED']);
}

/** bounded component 전체에서 LINKED PNU와 complete attached scan이 exact 일치하는지 (DESIGN §11). */
function linkedExactMatch(dbScope: DbScopeResolution, scannedPnus: string[], pairs: { basePnu: string; attachedPnu: string }[]): boolean {
    const observed = new Set<string>(scannedPnus);
    for (const p of pairs) {
        observed.add(p.basePnu);
        observed.add(p.attachedPnu);
    }
    const linked = new Set(dbScope.linkedPnus);
    if (observed.size !== linked.size) return false;
    for (const p of observed) if (!linked.has(p)) return false;
    return true;
}

// ── SINGLE_PNU_CONFIRMED 확인 ─────────────────────────────────────

export type SinglePnuConfirmationResult =
    | { state: 'SINGLE_PNU_CONFIRMED' }
    | { state: 'REVIEW_REQUIRED'; issue: 'LAND_SCOPE_CONFIRMATION_MISMATCH' };

/**
 * SYSTEM_ADMIN 확인 뒤 후속 job이 전체 resolver·외부 scan을 재실행해 얻은 결과가
 * discovery 시점의 정렬 property membership + scopeHash와 정확히 일치할 때만
 * SINGLE_PNU_CONFIRMED를 발급한다 (DESIGN §11).
 */
export function verifySinglePnuConfirmation(
    prior: { scopeHash: string; propertyMembership: unknown },
    current: { scopeHash: string; propertyMembership: unknown }
): SinglePnuConfirmationResult {
    const hashOk = prior.scopeHash.length > 0 && prior.scopeHash === current.scopeHash;
    // propertyMembership 정렬 정규화 후 비교 (비결정적 DB 행 순서 제거).
    const membershipOk =
        canonicalStableStringify(normalizePropertyMembershipOrder(prior.propertyMembership)) ===
        canonicalStableStringify(normalizePropertyMembershipOrder(current.propertyMembership));
    if (hashOk && membershipOk) return { state: 'SINGLE_PNU_CONFIRMED' };
    return { state: 'REVIEW_REQUIRED', issue: 'LAND_SCOPE_CONFIRMATION_MISMATCH' };
}

// ── 3층 hash ──────────────────────────────────────────────────────

function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

/** 결정론적 canonical JSON 직렬화(객체 키 정렬). 배열 순서는 호출부에서 확정한다. */
export function canonicalStableStringify(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        const o = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
        return out;
    }
    return value;
}

/** propertyMembership hash 버전(§14.2 propertyMembershipHash). */
export const PROPERTY_MEMBERSHIP_HASH_VERSION = 'land-area-sync/property-membership@1';

/**
 * DB `propertyMembership` 의 order-invariant hash (§14.1·§14.2).
 * discovery snapshot 과 후속 apply job 재실행이 같은 membership 이면 (DB row 순서와 무관하게)
 * 반드시 같은 hash 를 내야 confirmation lineage 재검증이 성립한다. 뒤섞인 순서 → 동일 hash.
 */
export function computePropertyMembershipHash(membership: unknown): string {
    return sha256Hex(
        canonicalStableStringify({
            v: PROPERTY_MEMBERSHIP_HASH_VERSION,
            membership: normalizePropertyMembershipOrder(membership),
        })
    );
}

/**
 * propertyMembership 배열 순서 정규화.
 * 비결정적 DB row 순서(조회할 때마다 다를 수 있음)를 안정적으로 정렬한다.
 * 정렬 기준: propertyUnitId 오름차순, 동일 시 buildingUnitId 오름차순.
 * 해시 계산에 참여하므로 정렬이 결정론성의 일부가 된다.
 */
export function normalizePropertyMembershipOrder(membership: unknown): unknown {
    if (!Array.isArray(membership)) return membership;
    const items = membership.filter((item) => item && typeof item === 'object');
    return items.sort((a, b) => {
        const aObj = a as Record<string, unknown>;
        const bObj = b as Record<string, unknown>;
        const aUnitId = String(aObj.propertyUnitId ?? '');
        const bUnitId = String(bObj.propertyUnitId ?? '');
        // propertyUnitId 기준 정렬
        const unitCmp = aUnitId.localeCompare(bUnitId);
        if (unitCmp !== 0) return unitCmp;
        // 동일하면 buildingUnitId 기준
        const aBuildingId = String(aObj.buildingUnitId ?? '');
        const bBuildingId = String(bObj.buildingUnitId ?? '');
        return aBuildingId.localeCompare(bBuildingId);
    });
}

/** 집합류 배열을 canonical string 기준으로 정렬(결정론). */
function sortedByCanonical<T>(arr: T[]): T[] {
    return [...arr].sort((a, b) => {
        const sa = canonicalStableStringify(a);
        const sb = canonicalStableStringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
}

function scanDigestPart<T>(scan: StrictScan<T>): { state: StrictScanState; totalCount: number | null } {
    if (scan.state === 'COMPLETE' || scan.state === 'COMPLETE_ZERO') {
        return { state: scan.state, totalCount: scan.totalCount };
    }
    return { state: scan.state, totalCount: null };
}

/**
 * same-run 외부 scan digest (DESIGN §11).
 * endpoint·completeness·totalCount·정렬 canonical identity rows·expected PK 집합·
 * bylot 정책/원천/정규화 count/cross-check를 포함하고 요청시각·secret·raw body는 제외한다.
 */
function buildExternalScopeDigest(baseScans: BasePnuScan[], bylot: BylotResolution, policy: BylotSourcePolicy): string {
    const scans = [...baseScans]
        .sort((a, b) => (a.pnu < b.pnu ? -1 : a.pnu > b.pnu ? 1 : 0))
        .map((b) => {
            const titleIdentity = sortedByCanonical(
                scanRows(b.title).map((r) => ({
                    mgmBldrgstPk: normalizeRegistryManagementPk(r.mgmBldrgstPk),
                    regstrGbCd: normStr(r.regstrGbCd),
                    mainPurpsCd: normStr(r.mainPurpsCd),
                    mainPurpsCdNm: normStr(r.mainPurpsCdNm),
                    otherPurposeSignals:
                        housingOtherPurposeSignals(r.etcPurps),
                    bylotCnt: normStr(r.bylotCnt),
                }))
            );
            const attachedIdentity = sortedByCanonical(
                scanRows(b.attached).map((r) => ({
                    mgmBldrgstPk: normalizeRegistryManagementPk(r.mgmBldrgstPk),
                    base: `${normStr(r.sigunguCd)}${normStr(r.bjdongCd)}${normStr(r.platGbCd)}${normStr(r.bun)}${normStr(r.ji)}`,
                    atch: `${normStr(r.atchSigunguCd)}${normStr(r.atchBjdongCd)}${normStr(r.atchPlatGbCd)}${normStr(r.atchBun)}${normStr(r.atchJi)}`,
                }))
            );
            const basisIdentity = b.basis
                ? sortedByCanonical(
                      scanRows(b.basis).map((r) => ({
                          mgmBldrgstPk: normalizeRegistryManagementPk(r.mgmBldrgstPk),
                          bylotCnt: normStr(r.bylotCnt),
                      }))
                  )
                : null;
            return {
                pnu: b.pnu,
                title: scanDigestPart(b.title),
                attached: scanDigestPart(b.attached),
                basis: b.basis ? scanDigestPart(b.basis) : null,
                titleIdentity,
                attachedIdentity,
                basisIdentity,
            };
        });

    const payload = {
        v: EXTERNAL_SCOPE_DIGEST_VERSION,
        bylotSourcePolicy: { version: BYLOT_SOURCE_POLICY.version, policy },
        expectedPks: [...bylot.expectedPks].sort(),
        bylotEvidence: [...bylot.evidence]
            .sort((a, b) => (a.mgmBldrgstPk < b.mgmBldrgstPk ? -1 : 1))
            .map((e) => ({ mgmBldrgstPk: e.mgmBldrgstPk, source: e.source, count: e.count, crossCheckState: e.crossCheckState })),
        scans,
    };
    return sha256Hex(canonicalStableStringify(payload));
}

export interface ScopeHashInput {
    strategy: string;
    candidatePropertyIds: string[];
    propertyMembership: unknown;
    currentLandTuples: unknown[];
    proposedAreas: unknown[];
    componentMatchDigest: unknown[];
    dbScopeHash: string;
    externalScopeDigest: string;
}

/**
 * 최종 scopeHash (DESIGN §11). strategy + 정렬 candidate property + membership + 현재 land
 * tuple + 제안 면적 + 정렬 component/match digest + dbScopeHash + externalScopeDigest의
 * versioned SHA-256. apply 직전 snapshot 고정·비교의 기준값이다.
 */
export function computeScopeHash(input: ScopeHashInput): string {
    const payload = {
        v: SCOPE_HASH_VERSION,
        strategy: input.strategy,
        candidatePropertyIds: [...input.candidatePropertyIds].sort(),
        // propertyMembership 정렬 정규화 (비결정적 DB 행 순서 → 안정적 기준).
        // 해시 결정론에 참여하므로 배열 순서를 propertyUnitId/buildingUnitId 기준으로 정렬.
        propertyMembership: normalizePropertyMembershipOrder(input.propertyMembership),
        currentLandTuples: sortedByCanonical(input.currentLandTuples),
        proposedAreas: sortedByCanonical(input.proposedAreas),
        componentMatchDigest: sortedByCanonical(input.componentMatchDigest),
        dbScopeHash: input.dbScopeHash,
        externalScopeDigest: input.externalScopeDigest,
    };
    return sha256Hex(canonicalStableStringify(payload));
}

// ── 유틸 ──────────────────────────────────────────────────────────

function sortedDedup(issues: LandAreaSyncIssueCode[]): LandAreaSyncIssueCode[] {
    return [...new Set(issues)].sort();
}
