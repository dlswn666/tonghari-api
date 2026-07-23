/**
 * PNU(필지고유번호) 관련 공용 순수 함수.
 *
 * gis-inspect.service.ts에서 검증된 로직을 그대로 옮긴 것이다 (DESIGN §10.6).
 * inspector와 land-area-sync 어댑터가 함께 import한다.
 */

/** PNU 로컬 생성에 필요한 카카오 우편번호 위젯 주소 필드만 담은 최소 입력 타입 */
export interface KakaoAddressPnuInput {
    /** 법정동코드 10자리 */
    bcode: string;
    /** 지번 본번 */
    mainNo: string;
    /** 지번 부번 (없으면 빈 문자열) */
    subNo: string;
    /** 산 여부 */
    mountainYn: string;
}

/**
 * 카카오 우편번호 위젯 데이터로 PNU(19자리)를 로컬 생성한다.
 * 법정동코드(10) + 대지구분(1: 일반=1, 산=2) + 본번(4) + 부번(4)
 */
export function buildPnuFromKakaoAddress(address: KakaoAddressPnuInput): string | null {
    const bcode = (address.bcode || '').trim();
    const mainNo = (address.mainNo || '').trim();
    const subNo = (address.subNo || '').trim() || '0';

    if (!/^\d{10}$/.test(bcode)) return null;
    if (!/^\d{1,4}$/.test(mainNo)) return null;
    if (!/^\d{1,4}$/.test(subNo)) return null;

    const landType = address.mountainYn === 'Y' ? '2' : '1';
    return `${bcode}${landType}${mainNo.padStart(4, '0')}${subNo.padStart(4, '0')}`;
}

// ── 건축물대장 부속지번(getBrAtchJibunInfo) PNU 조립 (DESIGN §10.5) ──
//
// 신규 순수 함수. gis.service.ts의 parsePNU는 참고만 하고 이동/재사용하지 않는다.
// 핵심 계약:
//  - 기준 PNU = sigunguCd + bjdongCd + platGbCd + bun + ji
//  - 부속 PNU = atchSigunguCd + atchBjdongCd + atchPlatGbCd + atchBun + atchJi
//  - Building HUB platGbCd 0/1 → PNU 토지구분 1/2 명시 변환
//  - self relation, 중복 pair, 블록 지번, PNU 변환 실패를 zero로 축약하지 않고 rejected로 분리

/** PNU 조립 실패 사유 */
export type PnuBuildFailReason =
    | 'MISSING_FIELD'
    | 'INVALID_REGION_CODE'
    | 'INVALID_PLAT_GB_CD'
    | 'BLOCK_OR_NON_NUMERIC_JIBUN';

export type PnuBuildResult =
    | { ok: true; pnu: string }
    | { ok: false; reason: PnuBuildFailReason };

/**
 * Building HUB platGbCd(0/1)를 PNU 토지구분(1/2)으로 명시 변환한다.
 * 0=대지(일반)→'1', 1=산→'2'. 그 외 값은 변환 불가(null)이며 zero로 축약하지 않는다.
 */
export function convertPlatGbCdToLandGbn(platGbCd: string): '1' | '2' | null {
    if (platGbCd === '0') return '1';
    if (platGbCd === '1') return '2';
    return null;
}

export interface BuildingHubPnuParts {
    sigunguCd: string;
    bjdongCd: string;
    platGbCd: string;
    bun: string;
    ji: string;
}

/**
 * Building HUB 5필드로 19자리 PNU를 조립한다.
 * 실패는 사유와 함께 반환한다(빈 값·잘못된 지역코드·platGbCd·블록/비숫자 지번).
 */
export function buildBuildingHubPnu(parts: BuildingHubPnuParts): PnuBuildResult {
    const sigunguCd = (parts.sigunguCd ?? '').trim();
    const bjdongCd = (parts.bjdongCd ?? '').trim();
    const platGbCd = (parts.platGbCd ?? '').trim();
    const bun = (parts.bun ?? '').trim();
    const ji = (parts.ji ?? '').trim();

    if (!sigunguCd || !bjdongCd || !platGbCd || !bun || !ji) {
        return { ok: false, reason: 'MISSING_FIELD' };
    }
    if (!/^\d{5}$/.test(sigunguCd) || !/^\d{5}$/.test(bjdongCd)) {
        return { ok: false, reason: 'INVALID_REGION_CODE' };
    }
    const landGbn = convertPlatGbCdToLandGbn(platGbCd);
    if (!landGbn) {
        return { ok: false, reason: 'INVALID_PLAT_GB_CD' };
    }
    // 블록-로트 지번 등 비숫자·4자리 초과 지번은 표준 PNU로 조립할 수 없다.
    if (!/^\d{1,4}$/.test(bun) || !/^\d{1,4}$/.test(ji)) {
        return { ok: false, reason: 'BLOCK_OR_NON_NUMERIC_JIBUN' };
    }
    return {
        ok: true,
        pnu: `${sigunguCd}${bjdongCd}${landGbn}${bun.padStart(4, '0')}${ji.padStart(4, '0')}`,
    };
}

/** 부속지번 조립 입력 (getBrAtchJibunInfo row에서 필요한 필드만) */
export interface AtchJibunRowInput {
    mgmBldrgstPk?: string;
    sigunguCd: string;
    bjdongCd: string;
    platGbCd: string;
    bun: string;
    ji: string;
    atchSigunguCd: string;
    atchBjdongCd: string;
    atchPlatGbCd: string;
    atchBun: string;
    atchJi: string;
}

/** 부속지번 pair 거부 사유 (side로 기준/부속/pair 구분) */
export type AttachedPnuRejectReason =
    | { side: 'BASE' | 'ATTACHED'; reason: PnuBuildFailReason }
    | { side: 'PAIR'; reason: 'SELF_RELATION' | 'DUPLICATE_PAIR' };

export interface AssembledAttachedPnu {
    basePnu: string;
    attachedPnu: string;
    mgmBldrgstPk: string | null;
}

export interface AssembledAttachedPnus {
    /** 유효하고 중복 없는 (기준, 부속) PNU 쌍 */
    pairs: AssembledAttachedPnu[];
    /** self relation·중복·블록지번·변환 실패 등으로 제외된 row (zero로 축약하지 않음) */
    rejected: Array<{ input: AtchJibunRowInput; reason: AttachedPnuRejectReason }>;
}

/**
 * getBrAtchJibunInfo row 배열을 (기준 PNU, 부속 PNU) 쌍으로 조립한다.
 *
 * self relation, 중복 pair, 블록 지번, PNU 변환 실패는 zero로 축약하지 않고 rejected로 분리한다.
 * (row가 존재하는 한 결과를 빈 것으로 뭉개면 안 된다 — DESIGN §10.5)
 */
export function assembleAttachedPnus(rows: AtchJibunRowInput[]): AssembledAttachedPnus {
    const pairs: AssembledAttachedPnu[] = [];
    const rejected: AssembledAttachedPnus['rejected'] = [];
    const seenPairs = new Set<string>();

    for (const input of rows) {
        const base = buildBuildingHubPnu({
            sigunguCd: input.sigunguCd,
            bjdongCd: input.bjdongCd,
            platGbCd: input.platGbCd,
            bun: input.bun,
            ji: input.ji,
        });
        if (!base.ok) {
            rejected.push({ input, reason: { side: 'BASE', reason: base.reason } });
            continue;
        }
        const attached = buildBuildingHubPnu({
            sigunguCd: input.atchSigunguCd,
            bjdongCd: input.atchBjdongCd,
            platGbCd: input.atchPlatGbCd,
            bun: input.atchBun,
            ji: input.atchJi,
        });
        if (!attached.ok) {
            rejected.push({ input, reason: { side: 'ATTACHED', reason: attached.reason } });
            continue;
        }
        if (base.pnu === attached.pnu) {
            rejected.push({ input, reason: { side: 'PAIR', reason: 'SELF_RELATION' } });
            continue;
        }
        const pairKey = `${base.pnu}|${attached.pnu}`;
        if (seenPairs.has(pairKey)) {
            rejected.push({ input, reason: { side: 'PAIR', reason: 'DUPLICATE_PAIR' } });
            continue;
        }
        seenPairs.add(pairKey);
        pairs.push({
            basePnu: base.pnu,
            attachedPnu: attached.pnu,
            mgmBldrgstPk: input.mgmBldrgstPk ?? null,
        });
    }

    return { pairs, rejected };
}
