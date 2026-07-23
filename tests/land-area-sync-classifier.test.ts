import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHousingType, type HousingClassifierInput } from '../src/services/land-area-sync/classifier';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';

const DETACHED = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'DETACHED')!;
const MULTIFAMILY = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIFAMILY')!;
const MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIPLEX')!;

function row(p: { regstrGbCd: string; mainPurpsCd: string; mainPurpsCdNm: string }) {
    return { regstrGbCd: p.regstrGbCd, mainPurpsCd: p.mainPurpsCd, mainPurpsCdNm: p.mainPurpsCdNm };
}

function input(over: Partial<HousingClassifierInput> = {}): HousingClassifierInput {
    return { titleRows: [], rootIdentities: ['ROOT-1'], ...over };
}

// ── 공식 pair (§9.2 결정표 상단) ──────────────────────────────────

test('단독주택 exact pair → LADFRL/DETACHED', () => {
    const r = classifyHousingType(input({ titleRows: [row(DETACHED)] }));
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LADFRL');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'DETACHED');
    assert.equal(r.kind === 'CLASSIFIED' && r.regstrGbCd, '1');
});

test('다가구주택 exact pair → LADFRL/MULTIFAMILY', () => {
    const r = classifyHousingType(input({ titleRows: [row(MULTIFAMILY), row(MULTIFAMILY)] }));
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LADFRL');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'MULTIFAMILY');
});

test('다세대주택 exact pair → LDAREG/MULTIPLEX', () => {
    const r = classifyHousingType(input({ titleRows: [row(MULTIPLEX)] }));
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LDAREG');
    assert.equal(r.kind === 'CLASSIFIED' && r.regstrGbCd, '2');
});

// ── 미지원·비주거 (§9.2) ─────────────────────────────────────────

test('아파트·연립·다중은 REVIEW_REQUIRED / UNSUPPORTED_HOUSING_TYPE', () => {
    for (const name of ['아파트', '연립주택', '다중주택']) {
        const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '2', mainPurpsCd: '09999', mainPurpsCdNm: name })] }));
        assert.equal(r.kind, 'REVIEW_REQUIRED');
        assert.equal(r.kind === 'REVIEW_REQUIRED' && r.issue, 'UNSUPPORTED_HOUSING_TYPE');
    }
});

test('비주거·복합용도(allowlist·unsupported 어디에도 없음)는 CLASSIFICATION_CONFLICT', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: '03000', mainPurpsCdNm: '제1종근린생활시설' })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.issue, 'BUILDING_CLASSIFICATION_CONFLICT');
});

// ── 혼재·불일치 차단 (§9.2) ──────────────────────────────────────

test('일반·집합 혼재(regstrGbCd 다름)는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row(DETACHED), row(MULTIPLEX)] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'MIXED_REGISTER_GB');
});

test('purpose pair 혼재(단독+다가구)는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row(DETACHED), row(MULTIFAMILY)] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'MIXED_PURPOSE_PAIR');
});

test('code/name 불일치(코드는 단독인데 명칭 다름)는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: DETACHED.mainPurpsCd, mainPurpsCdNm: '창고' })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
});

test('regstrGbCd가 용도와 불일치(다세대인데 일반)는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: MULTIPLEX.mainPurpsCd, mainPurpsCdNm: MULTIPLEX.mainPurpsCdNm })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
});

test('빈 코드·명칭은 REVIEW_REQUIRED / EMPTY', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: '', mainPurpsCdNm: '단독주택' })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'EMPTY_PURPOSE_CODE_OR_NAME');
});

test('root 관리번호 여러 개는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row(DETACHED)], rootIdentities: ['ROOT-1', 'ROOT-2'] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'MULTIPLE_ROOT_IDENTITIES');
});

test('title row 없음(TITLE_COMPLETE_ZERO)은 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'NO_TITLE_ROWS');
});

test('substring 분류 금지: mainPurpsCdNm에 "주택" 포함되어도 allowlist 아니면 미분류', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: '01000', mainPurpsCdNm: '단독주택형 기타' })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
});
