/**
 * LDAREG 분모 검증용 same-run LADFRL scope 면적 확정.
 *
 * 각 resolved scope PNU는 같은 실행의 LADFRL 응답에서 정확히 하나의 distinct 양수
 * 유한 면적을 가져야 한다. 누락·0·음수·비숫자·다른 PNU 혼입·상충값은 합계를 만들지
 * 않고 fail-closed한다.
 */

import type { LadfrlRow } from '../../types/land-area-sync.types';

const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_DECIMAL_SCALE = 10;

export interface ScopeLadfrlArea {
    pnu: string;
    /** canonical decimal string */
    area: string;
}

export type ScopeLadfrlResolution =
    | {
          ok: true;
          areas: ScopeLadfrlArea[];
          /** canonical decimal string */
          totalArea: string;
          totalAreaNumber: number;
      }
    | {
          ok: false;
          targetPnu: string;
      };

function canonicalPositiveDecimal(value: unknown): string | null {
    const raw =
        typeof value === 'string'
            ? value.trim()
            : typeof value === 'number' && Number.isFinite(value)
              ? String(value)
              : '';
    if (!DECIMAL_RE.test(raw)) return null;
    const [whole, fraction = ''] = raw.split('.');
    if (fraction.length > MAX_DECIMAL_SCALE) return null;
    const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
    const canonicalFraction = fraction.replace(/0+$/, '');
    const canonical = canonicalFraction ? `${canonicalWhole}.${canonicalFraction}` : canonicalWhole;
    const numeric = Number(canonical);
    return Number.isFinite(numeric) && numeric > 0 ? canonical : null;
}

function sumCanonicalDecimals(values: string[]): string {
    const scale = Math.max(0, ...values.map((value) => value.split('.')[1]?.length ?? 0));
    let total = 0n;
    for (const value of values) {
        const [whole, fraction = ''] = value.split('.');
        total += BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
    }
    if (scale === 0) return total.toString();
    const digits = total.toString().padStart(scale + 1, '0');
    const whole = digits.slice(0, -scale);
    const fraction = digits.slice(-scale).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

export function resolveScopeLadfrlAreas(
    scans: Array<{ pnu: string; rows: LadfrlRow[] }>,
    expectedPnus: string[] = scans.map((scan) => scan.pnu)
): ScopeLadfrlResolution {
    const expected = [...new Set(expectedPnus)].sort();
    const actual = [...new Set(scans.map((scan) => scan.pnu))].sort();
    if (
        expected.length !== expectedPnus.length ||
        actual.length !== scans.length ||
        expected.length !== actual.length ||
        expected.some((pnu, index) => pnu !== actual[index])
    ) {
        return { ok: false, targetPnu: expected[0] ?? actual[0] ?? '' };
    }
    const seenPnus = new Set<string>();
    const areas: ScopeLadfrlArea[] = [];

    for (const scan of [...scans].sort((a, b) => a.pnu.localeCompare(b.pnu))) {
        if (seenPnus.has(scan.pnu) || scan.rows.length === 0) {
            return { ok: false, targetPnu: scan.pnu };
        }
        seenPnus.add(scan.pnu);

        const distinct = new Set<string>();
        for (const row of scan.rows) {
            if (String(row.pnu ?? '').trim() !== scan.pnu) {
                return { ok: false, targetPnu: scan.pnu };
            }
            const area = canonicalPositiveDecimal(row.lndpclAr);
            if (area === null) return { ok: false, targetPnu: scan.pnu };
            distinct.add(area);
        }
        if (distinct.size !== 1) return { ok: false, targetPnu: scan.pnu };
        areas.push({ pnu: scan.pnu, area: [...distinct][0] });
    }

    if (areas.length === 0) return { ok: false, targetPnu: '' };
    const totalArea = sumCanonicalDecimals(areas.map((entry) => entry.area));
    const totalAreaNumber = Number(totalArea);
    if (!Number.isFinite(totalAreaNumber) || totalAreaNumber <= 0) {
        return { ok: false, targetPnu: areas[0]?.pnu ?? '' };
    }
    return { ok: true, areas, totalArea, totalAreaNumber };
}
