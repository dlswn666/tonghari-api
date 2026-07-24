import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveScopeLadfrlAreas } from '../src/services/land-area-sync/ladfrl-scope';

const BASE = '1154510300108410032';
const ATTACHED = '1154510300108410033';

test('same-run LADFRL: 실측 177.6 + 187 = 364.6 scope 합계를 정확히 만든다', () => {
    const result = resolveScopeLadfrlAreas([
        { pnu: ATTACHED, rows: [{ pnu: ATTACHED, lndpclAr: '187.0' }] },
        { pnu: BASE, rows: [{ pnu: BASE, lndpclAr: '177.6' }] },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.areas, [
        { pnu: BASE, area: '177.6' },
        { pnu: ATTACHED, area: '187' },
    ]);
    assert.equal(result.totalArea, '364.6');
    assert.equal(result.totalAreaNumber, 364.6);
});

test('same-run LADFRL: 단일 PNU는 해당 필지면적과 같은 scope 합계를 만든다', () => {
    const result = resolveScopeLadfrlAreas([
        {
            pnu: BASE,
            rows: [
                { pnu: BASE, lndpclAr: '177.600' },
                { pnu: BASE, lndpclAr: '177.6' },
            ],
        },
    ]);
    assert.deepEqual(result, {
        ok: true,
        areas: [{ pnu: BASE, area: '177.6' }],
        totalArea: '177.6',
        totalAreaNumber: 177.6,
    });
});

test('same-run LADFRL: 누락·0·상충·다른 PNU 혼입은 합계를 만들지 않는다', () => {
    const cases = [
        [{ pnu: BASE, rows: [] }],
        [{ pnu: BASE, rows: [{ pnu: BASE, lndpclAr: '0' }] }],
        [
            {
                pnu: BASE,
                rows: [
                    { pnu: BASE, lndpclAr: '177.6' },
                    { pnu: BASE, lndpclAr: '178.6' },
                ],
            },
        ],
        [{ pnu: BASE, rows: [{ pnu: ATTACHED, lndpclAr: '177.6' }] }],
    ];
    for (const scans of cases) {
        const result = resolveScopeLadfrlAreas(scans);
        assert.equal(result.ok, false);
    }
});

