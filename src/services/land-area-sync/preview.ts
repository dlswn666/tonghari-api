/**
 * LAND_AREA_SYNC preview_data.landAreaSync 순수 빌더 (DESIGN §14.2).
 *
 * 책임(전부 네트워크·DB 없는 순수 로직):
 *  - scopeEvidence / scopeSnapshot 조립(3층 hash·membership hash·projection digest).
 *  - issue ≤200·PNU ≤50 상한 + truncated 플래그.
 *  - §17.3 PII 경계: issue 는 code·propertyUnitId·targetPnu·최소 동/호만.
 *  - clsSeCode → sourceState(CURRENT/CLOSED) 매핑(명확 값만 CLOSED, 불명확은 CURRENT).
 *  - matcher 주입 전 floor 표기 정규화(building_units.floor integer ↔ LDAREG '3층').
 */

import { createHash } from 'node:crypto';
import {
    canonicalStableStringify,
    computeScopeHash,
    computePropertyMembershipHash,
    type DbScopeResolution,
} from './scope';
import { BYLOT_SOURCE_POLICY } from './bylot';
import { normalizeUnitSegment } from './normalizer';
import type { BylotResolution } from './bylot';
import type {
    LandAreaSyncStrategy,
    LandAreaSyncScopeEvidence,
    LandAreaSyncScopeSnapshot,
    LandAreaSyncBylotEvidence,
    LandAreaSyncLandTuple,
    LandAreaSyncProposedArea,
    LandAreaSyncIssue,
    LandAreaSyncCounts,
} from '../../types/land-area-sync-job.types';
import { LAND_AREA_SYNC_MAX_ISSUES } from '../../types/land-area-sync-job.types';
import type { LdaregSourceState } from './identity';

/** snapshot canonical 버전. 직렬화가 바뀌면 올린다. */
export const LAND_AREA_SYNC_CANONICAL_VERSION = 1;

// ── scopeEvidence ─────────────────────────────────────────────────

/**
 * §14.2 scopeEvidence 를 DB resolver 결과 + attached scan 파생값으로 만든다.
 * relation count 는 positive-cache evidence key 수, distinctAttachedPnuCount 는
 * assembleAttachedPnus 가 조립한 attachedPnu distinct 수를 넘겨받는다.
 */
export function buildScopeEvidence(
    dbScope: DbScopeResolution,
    derived: { attachedRows: number; distinctAttachedPnuCount: number }
): LandAreaSyncScopeEvidence {
    return {
        attachedRows: derived.attachedRows,
        distinctAttachedPnuCount: derived.distinctAttachedPnuCount,
        linkedRelationCount: dbScope.linkedEvidenceKeys.length,
        pendingRelationCount: dbScope.pendingEvidenceKeys.length,
        blockingEvidenceCount: dbScope.blockingEvidence.length,
        openUnresolvedCount: dbScope.openUnresolvedEvidenceKeys.length,
        componentPnuCount: dbScope.componentPnus.length,
    };
}

// ── scopeSnapshot ─────────────────────────────────────────────────

export interface ScopeSnapshotInput {
    strategy: LandAreaSyncStrategy;
    frozenAt: string;
    scannedPnus: string[];
    /** DB resolver 호출에 실제 사용한 root 관리번호 식별자(정렬·dedup, up-PK 우선). CAS 로 함께 고정. */
    resolverRootPks: string[];
    bylot: BylotResolution;
    dbScopeHash: string;
    externalScopeDigest: string;
    /** DB resolver propertyMembership 원본(order-invariant hash 대상). */
    propertyMembership: unknown;
    /** apply 대상 candidate property unit id(정렬 전 허용 — 여기서 정렬한다). */
    candidatePropertyUnitIds: string[];
    currentLandTuples: LandAreaSyncLandTuple[];
    proposedLandAreas: LandAreaSyncProposedArea[];
    /** scopeHash 의 정렬 component/match digest 입력. */
    componentMatchDigest: unknown[];
    /** apply p_items(projectionInputDigest 원문). */
    projectionItems: unknown;
}

/** bylot evidence 를 snapshot 형태(정렬)로 투영한다. */
function toBylotEvidence(bylot: BylotResolution): LandAreaSyncBylotEvidence[] {
    return [...bylot.evidence]
        .sort((a, b) => (a.mgmBldrgstPk < b.mgmBldrgstPk ? -1 : a.mgmBldrgstPk > b.mgmBldrgstPk ? 1 : 0))
        .map((e) => ({
            mgmBldrgstPk: e.mgmBldrgstPk,
            source: e.source,
            rawValue: e.rawValue,
            count: e.count,
            crossCheckState: e.crossCheckState,
        }));
}

function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

/**
 * §14.2 scopeSnapshot(3층 hash + membership hash + projection digest) 를 조립한다.
 * 여기서 만든 값이 CAS 로 한 번 고정되며 apply/confirmation RPC 의 대조 기준이 된다.
 */
export function buildScopeSnapshot(input: ScopeSnapshotInput): LandAreaSyncScopeSnapshot {
    const candidatePropertyUnitIds = [...new Set(input.candidatePropertyUnitIds)].sort();
    const propertyMembershipHash = computePropertyMembershipHash(input.propertyMembership);
    const scopeHash = computeScopeHash({
        strategy: input.strategy,
        candidatePropertyIds: candidatePropertyUnitIds,
        propertyMembership: input.propertyMembership,
        currentLandTuples: input.currentLandTuples,
        proposedAreas: input.proposedLandAreas,
        componentMatchDigest: input.componentMatchDigest,
        dbScopeHash: input.dbScopeHash,
        externalScopeDigest: input.externalScopeDigest,
    });
    const projectionInputDigest = sha256Hex(canonicalStableStringify(input.projectionItems ?? []));

    return {
        frozenAt: input.frozenAt,
        strategy: input.strategy,
        scannedPnus: [...input.scannedPnus],
        // resolver 호출 입력을 그대로 고정한다(정렬·dedup 는 이미 deriveRootPks 가 보장하나 방어적 정규화).
        resolverRootPks: [...new Set(input.resolverRootPks)].sort(),
        bylotSourcePolicy: BYLOT_SOURCE_POLICY.policy,
        bylotEvidence: toBylotEvidence(input.bylot),
        dbScopeHash: input.dbScopeHash,
        externalScopeDigest: input.externalScopeDigest,
        scopeHash,
        candidatePropertyUnitIds,
        propertyMembershipHash,
        currentLandTuples: input.currentLandTuples,
        proposedLandAreas: input.proposedLandAreas,
        projectionInputDigest,
        canonicalVersion: LAND_AREA_SYNC_CANONICAL_VERSION,
    };
}

// ── issue 상한 + PII 경계 ─────────────────────────────────────────

const PNU_RE = /^[0-9]{19}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * issue 를 §17.3 allowlist 필드만 남기도록 정제한다.
 * code·propertyUnitId(uuid)·targetPnu(19자리)·dong·ho(최소 표기)만 허용하고
 * 소유자명·연락처·raw 등은 절대 통과시키지 않는다.
 */
export function sanitizeIssue(issue: LandAreaSyncIssue): LandAreaSyncIssue {
    const out: LandAreaSyncIssue = { code: issue.code };
    if (typeof issue.propertyUnitId === 'string' && UUID_RE.test(issue.propertyUnitId)) {
        out.propertyUnitId = issue.propertyUnitId;
    }
    if (typeof issue.targetPnu === 'string' && PNU_RE.test(issue.targetPnu)) {
        out.targetPnu = issue.targetPnu;
    }
    if (typeof issue.dong === 'string' && issue.dong.length > 0 && issue.dong.length <= 20) {
        out.dong = issue.dong;
    }
    if (typeof issue.ho === 'string' && issue.ho.length > 0 && issue.ho.length <= 20) {
        out.ho = issue.ho;
    }
    return out;
}

export interface CappedIssues {
    issues: LandAreaSyncIssue[];
    issuesTotal: number;
    issuesTruncated: boolean;
}

/** issue 목록을 정제·중복 제거 없이 상한(200) 절단한다. total·truncated 도 함께 반환. */
export function capIssues(issues: LandAreaSyncIssue[]): CappedIssues {
    const sanitized = issues.map(sanitizeIssue);
    const total = sanitized.length;
    if (total > LAND_AREA_SYNC_MAX_ISSUES) {
        return { issues: sanitized.slice(0, LAND_AREA_SYNC_MAX_ISSUES), issuesTotal: total, issuesTruncated: true };
    }
    return { issues: sanitized, issuesTotal: total, issuesTruncated: false };
}

/** counts 골격(0 초기화). */
export function emptyCounts(): LandAreaSyncCounts {
    return {
        titleRows: 0,
        basisRows: 0,
        attachedRows: 0,
        exposureRows: 0,
        landRegistryRows: 0,
        landRightRows: 0,
        parsedRows: 0,
        matchedPropertyUnits: 0,
        activeRights: 0,
        staledRights: 0,
        closedRights: 0,
        updatedPropertyUnits: 0,
        unchangedPropertyUnits: 0,
        skippedRows: 0,
    };
}

// ── clsSeCode → sourceState 매핑(§13.4) ────────────────────────────

/**
 * 대지권등록부 clsSeCode/clsSeCodeNm 을 말소 여부로 판정한다.
 * 명확한 말소 표기만 CLOSED, 명확한 유효/공란은 CURRENT, 그 외 불명확은 CURRENT 유지(자동
 * CLOSE 금지)하고 ambiguous=true 로 표시한다. 자동으로 숫자를 0으로 만들지 않기 위함이다.
 */
const CLOSED_CODE_TOKENS = new Set(['2', '3', '9']);
const CLOSED_NAME_TOKENS = ['말소', '폐쇄', '소멸', '멸실'];
const CURRENT_CODE_TOKENS = new Set(['', '0', '1']);
const CURRENT_NAME_TOKENS = ['유효', '현행', '존재', '정상'];

export interface SourceStateDecision {
    state: LdaregSourceState;
    ambiguous: boolean;
}

export function mapClsSeCodeToSourceState(
    clsSeCode: string | null | undefined,
    clsSeCodeNm?: string | null
): SourceStateDecision {
    const code = (clsSeCode == null ? '' : String(clsSeCode)).trim();
    const name = (clsSeCodeNm == null ? '' : String(clsSeCodeNm)).normalize('NFKC').trim();

    // 명확한 말소: 코드 또는 명칭이 말소류.
    if (CLOSED_CODE_TOKENS.has(code) || CLOSED_NAME_TOKENS.some((t) => name.includes(t))) {
        return { state: 'CLOSED', ambiguous: false };
    }
    // 명확한 유효/공란.
    if (CURRENT_CODE_TOKENS.has(code) || CURRENT_NAME_TOKENS.some((t) => name.includes(t))) {
        return { state: 'CURRENT', ambiguous: false };
    }
    // 불명확: 자동 CLOSE 금지 → CURRENT 유지 + 표시.
    return { state: 'CURRENT', ambiguous: true };
}

// ── floor 표기 정규화(matcher 주입 전) ─────────────────────────────

/**
 * matcher 주입 전 floor 표기를 정규화한다(§12.3 계약 정렬).
 * normalizer 가 층 접미사를 제거하지 않으므로, LDAREG '3층'·building_units.floor integer 3 를
 * 주입 전에 동일 표기로 맞춘다. 지하 표기는 normalizer 의 지하 codebook 이 처리하도록 남긴다.
 */
export function normalizeFloorLabel(raw: string | number | null | undefined): string {
    if (raw == null) return '';
    let s = String(raw).normalize('NFKC').replace(/\s+/g, '');
    if (s === '') return '';
    // 정확한 '층'/'F' 접미사만 1회 제거(지하 접두 표기는 normalizer 로 위임).
    if (s.endsWith('층')) s = s.slice(0, -1);
    else if (/[fF]$/.test(s) && /\d/.test(s)) s = s.slice(0, -1);
    // 나머지(지하/leading-zero 등)는 normalizer 가 idempotent 하게 처리하도록 위임.
    return normalizeUnitSegment(s);
}
