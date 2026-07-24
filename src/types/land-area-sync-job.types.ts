/**
 * LAND_AREA_SYNC job·route·preview 오케스트레이션 타입 (DESIGN §14).
 *
 * 권위 스펙: docs/2026-07-23-land-area-sync-design.md §14.2 (preview_data.landAreaSync
 * schemaVersion 2 shape), §14.1 (route·confirmation), 그리고
 * supabase/migrations/20260723172000_create_property_unit_land_rights.sql 의
 * [5.2]/[5.3] RPC 인자·p_items 계약.
 *
 * 상태값은 enum이 아니라 string union으로 관리한다. 주석은 한국어.
 */

import type { DatabaseTarget } from './database.types';
import type {
    BylotSourcePolicy,
    BylotCrossCheckState,
    LandAreaSyncIssueCode,
} from './land-area-sync.types';

/** LAND_AREA_SYNC sync_jobs.job_type 값(마이그레이션 A에서 enum 추가). */
export const LAND_AREA_SYNC_JOB_TYPE = 'LAND_AREA_SYNC';

/** preview_data.landAreaSync 스키마 버전(§14.2). */
export const LAND_AREA_SYNC_SCHEMA_VERSION = 2;

/** 적용 전략 2종(v1). */
export type LandAreaSyncStrategy = 'LADFRL' | 'LDAREG';

/** §14.2 scopeState 6종. */
export type LandAreaSyncScopeState =
    | 'SINGLE_SCOPE_CONFIRMATION_REQUIRED'
    | 'SINGLE_PNU_CONFIRMED'
    | 'LINKED_SCOPE_RESOLVED'
    | 'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED'
    | 'REVIEW_REQUIRED'
    | 'FAILED';

/** §14.2 terminal outcome 5종. */
export type LandAreaSyncOutcome = 'APPLIED' | 'PARTIAL' | 'NO_DATA' | 'REVIEW_REQUIRED' | 'FAILED';

/** apply RPC 로 넘기는 scan completeness(§13.1 barrier). COMPLETE 만 적용 가능. */
export type LandAreaSyncScanCompleteness = 'COMPLETE' | 'INCOMPLETE' | 'FAILED';

/** bylot 근거 1건(§14.2 scopeSnapshot.bylotEvidence). */
export interface LandAreaSyncBylotEvidence {
    mgmBldrgstPk: string;
    source: 'TITLE' | 'BASIS_FALLBACK' | null;
    rawValue: string | null;
    count: number | null;
    crossCheckState: BylotCrossCheckState;
}

/** 현재 land tuple / 제안 면적(문자열 numeric 로 직렬화 — JS float 을 DB 로 보내지 않는다). */
export interface LandAreaSyncLandTuple {
    propertyUnitId: string;
    landArea: string;
    source: string;
}
export interface LandAreaSyncProposedArea {
    propertyUnitId: string;
    landArea: string;
}

/** §14.2 scopeEvidence. */
export interface LandAreaSyncScopeEvidence {
    attachedRows: number;
    distinctAttachedPnuCount: number;
    linkedRelationCount: number;
    pendingRelationCount: number;
    blockingEvidenceCount: number;
    openUnresolvedCount: number;
    componentPnuCount: number;
}

/** §14.2 scopeSnapshot — 최초 CAS 뒤 immutable. */
export interface LandAreaSyncScopeSnapshot {
    frozenAt: string;
    strategy: LandAreaSyncStrategy;
    scannedPnus: string[];
    /**
     * DB resolver(`resolve_land_area_sync_scope_v1`) 호출에 실제 사용한 root 관리번호 식별자
     * 배열(정렬·dedup). up-PK 우선(`mgmUpBldrgstPk` 있으면 그 값, 없으면 `mgmBldrgstPk`)으로
     * anchor PNU 표제부에서 유도한 `p_root_mgm_bldrgst_pks` 그대로다.
     *
     * ⚠️ 계약(웹 [5.3] apply RPC 재검증 대상): apply RPC 는 dbScopeHash 재검증 시 이 필드로
     * resolver 를 재호출해야 한다. bylotEvidence.mgmBldrgstPk(정확 PK)로 재유도하면
     * `mgmUpBldrgstPk ≠ mgmBldrgstPk` 필지에서 dbScopeHash 가 결정적으로 달라져
     * SCOPE_CHANGED_DURING_SYNC 로 오탈락한다. 위조는 dbScopeHash 재검증이 방어한다.
     */
    resolverRootPks: string[];
    bylotSourcePolicy: BylotSourcePolicy;
    bylotEvidence: LandAreaSyncBylotEvidence[];
    dbScopeHash: string;
    externalScopeDigest: string;
    scopeHash: string;
    candidatePropertyUnitIds: string[];
    propertyMembershipHash: string;
    currentLandTuples: LandAreaSyncLandTuple[];
    proposedLandAreas: LandAreaSyncProposedArea[];
    /** LDAREG 분모 검증에 사용한 immutable same-run LADFRL scope 근거. */
    ladfrlAreaEvidence: {
        version: 'land-area-sync.ladfrl-scope.v1';
        /** distinct resolved scope PNU별 canonical 양수면적(PNU 오름차순). */
        parcels: Array<{ pnu: string; area: string }>;
        /** parcels 면적의 canonical decimal 합계. */
        totalArea: string;
    } | null;
    /**
     * multi-PNU LDAREG가 query PNU만 다른 exact replica임을 증명하는 immutable 근거.
     * LADFRL branch는 null이다.
     */
    replicationEvidence: {
        version: 'land-area-sync.ldareg-replication.v2';
        /** scanned set에 포함된 base PNU 중 정렬 첫 값. */
        canonicalSourcePnu: string;
        /** scannedPnus와 exact 같은 정렬 PNU 집합. */
        comparedPnus: string[];
        exactReplica: true;
        /** query-specific pnu를 제외한 canonical LDAREG multiset 행 수(중복 포함). */
        rowCount: number;
        /** canonical multiset SHA-256. */
        rowMultisetDigest: string;
    } | null;
    projectionInputDigest: string;
    canonicalVersion: number;
}

/** §14.2 confirmation — confirmation-job admission RPC 가 채운다. discovery/LINKED apply 는 null. */
export interface LandAreaSyncConfirmation {
    confirmedByUserId: string;
    confirmedAt: string;
    sourceDiscoveryJobId: string;
    confirmedDiscoveryScopeHash: string;
    confirmedPropertyUnitIds: string[];
    confirmedPropertyMembershipHash: string;
    parcelScopeConfirmed: boolean;
    landOwnershipConfirmed: boolean | null;
    overwriteManualConfirmed: boolean;
    parcelScopeEvidenceKind: string | null;
    parcelScopeEvidenceRef: string | null;
    landOwnershipEvidenceKind: string | null;
    landOwnershipEvidenceRef: string | null;
}

/** §14.2 counts. */
export interface LandAreaSyncCounts {
    titleRows: number;
    basisRows: number;
    attachedRows: number;
    exposureRows: number;
    landRegistryRows: number;
    landRightRows: number;
    parsedRows: number;
    matchedPropertyUnits: number;
    activeRights: number;
    staledRights: number;
    closedRights: number;
    updatedPropertyUnits: number;
    unchangedPropertyUnits: number;
    skippedRows: number;
}

/** issue 1건(§14.2 — PNU·최소 동/호·property-unit ID·issue code 만 허용). */
export interface LandAreaSyncIssue {
    code: LandAreaSyncIssueCode;
    propertyUnitId?: string;
    targetPnu?: string;
    dong?: string;
    ho?: string;
}

/** §14.2 preview_data.landAreaSync 전체 shape(schemaVersion 2). */
export interface LandAreaSyncPreview {
    schemaVersion: number;
    anchorPnu: string;
    sourceDiscoveryJobId: string | null;
    /** admission 응답 유실 시 exact job을 찾기 위한 UUID. PROCESSING부터 immutable이다. */
    admissionKey?: string;
    /**
     * terminal payload와 같은 DB UPDATE에서만 생성되는 immutable receipt.
     * PROCESSING 및 구 terminal job에는 key 자체가 없다.
     */
    workerFinalization?: {
        version: 1;
        finalizedAt: string;
    };
    scopeState: LandAreaSyncScopeState;
    scopeEvidence: LandAreaSyncScopeEvidence;
    scopeSnapshot: LandAreaSyncScopeSnapshot | null;
    confirmation: LandAreaSyncConfirmation | null;
    branch: LandAreaSyncStrategy | null;
    outcome: LandAreaSyncOutcome | null;
    counts: LandAreaSyncCounts;
    issues: LandAreaSyncIssue[];
    issuesTotal: number;
    issuesTruncated: boolean;
}

/** §14.2 제한. */
export const LAND_AREA_SYNC_MAX_SCOPE_PNUS = 50;
export const LAND_AREA_SYNC_MAX_ISSUES = 200;

// ── request/route DTO ─────────────────────────────────────────────

/** POST /api/gis/land-area-sync 요청(오케스트레이션 producer 입력). */
export interface LandAreaSyncDiscoveryRequest {
    unionId: string;
    anchorPnu: string;
    admissionKey: string;
    actorUserId: string;
    databaseTarget: DatabaseTarget;
}

/** confirmation route body(확인자·시각은 body 금지 — §14.1). */
export interface LandAreaSyncConfirmBody {
    unionId: string;
    admissionKey: string;
    expectedScopeHash: string;
    propertyUnitIds: string[];
    parcelScopeConfirmed: boolean;
    landOwnershipConfirmed?: boolean | null;
    overwriteManualConfirmed?: boolean;
    parcelScopeEvidenceKind: string;
    parcelScopeEvidenceRef: string;
    landOwnershipEvidenceKind?: string | null;
    landOwnershipEvidenceRef?: string | null;
}

/** producer 반환(202 body). */
export interface LandAreaSyncJobInfo {
    jobId: string;
    unionId: string;
    anchorPnu: string;
    status: 'pending';
    createdAt: Date;
}

// ── apply RPC p_items 계약(migration [5.3] 원천) ────────────────────

/** LADFRL p_items(정확히 1건). ladfrlArea=null → LADFRL_COMPLETE_ZERO. */
export interface LandAreaSyncApplyLadfrlItem {
    propertyUnitId: string;
    targetPnu: string;
    ladfrlArea: string | null;
}

/** LDAREG component(§7.3 allowlist source record 포함). */
export interface LandAreaSyncApplyLdaregComponent {
    targetPnu: string;
    sourceState: 'CURRENT' | 'CLOSED';
    matchMethod: 'BUILDING_UNIT_ID' | 'PNU_DONG_HO';
    matchedBuildingUnitId: string | null;
    sourceIdentity: string;
    sourceAgbldgSn: string | null;
    ratioRaw: string;
    ratioNumerator: string;
    ratioDenominator: string;
    retiredReason: string | null;
    sourceRecord: Record<string, string | null>;
}

/** LDAREG p_items(property 배열, 중복 propertyUnitId 금지). */
export interface LandAreaSyncApplyLdaregItem {
    propertyUnitId: string;
    expectedTargetPnus: string[];
    components: LandAreaSyncApplyLdaregComponent[];
}

/** apply RPC 인자(migration [5.3]). */
export interface ApplyPropertyLandAreaSyncParams {
    p_union_id: string;
    p_sync_job_id: string;
    p_strategy: LandAreaSyncStrategy;
    p_scan_started_at: string;
    p_scan_completeness: LandAreaSyncScanCompleteness;
    p_db_scope_hash: string;
    p_external_scope_digest: string;
    p_scope_hash: string;
    p_scanned_pnus: string[];
    p_items: LandAreaSyncApplyLadfrlItem[] | LandAreaSyncApplyLdaregItem[];
    p_result_summary: {
        counts?: Partial<LandAreaSyncCounts>;
        extraIssues?: LandAreaSyncIssue[];
    };
}

/** confirmation-job admission RPC 인자(migration [5.2]). */
export interface CreateConfirmationJobParams {
    p_union_id: string;
    p_discovery_job_id: string;
    p_admission_key: string;
    p_actor_user_id: string;
    p_expected_scope_hash: string;
    p_property_unit_ids: string[];
    p_parcel_scope_confirmed: boolean;
    p_land_ownership_confirmed: boolean | null;
    p_overwrite_manual_confirmed: boolean;
    p_parcel_scope_evidence_kind: string;
    p_parcel_scope_evidence_ref: string;
    p_land_ownership_evidence_kind: string | null;
    p_land_ownership_evidence_ref: string | null;
}

/** scope resolver RPC 인자(migration [5.1]). */
export interface ResolveScopeParams {
    p_union_id: string;
    p_anchor_pnu: string;
    p_root_mgm_bldrgst_pks: string[];
}
