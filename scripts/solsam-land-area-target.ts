/**
 * 삼양동(solsam) 운영 대지권 동기화용 v3 target manifest 생성기.
 *
 * - digest 는 손으로 쓰지 않는다 — 러너의 canonical 생성 함수만 호출하고
 *   조립 결과를 러너 파서(parseDevelopmentTargetManifest)로 자가 검증한다.
 * - 읽기 전용: 운영 DB 에 SELECT 만 날린다(500행 페이징 + 총행수 검증).
 * - anchors 는 활성 PNU 전체에서 제외 목록(--exclude)과 모드(--mode)에 따라
 *   부분집합을 만든다. expectedUnionActive* 는 항상 DB 진실값(활성 전체)이다.
 *
 * 사용:
 *   tsx scripts/solsam-land-area-target.ts \
 *     --label solsam-full-1086-api-readonly-production-20260904 \
 *     --out development-land-area-sync-manifests/solsam-full-1086-api-readonly-production-target-20260904.json \
 *     [--exclude <json: {"excluded_pnus":[...]}>] [--include <json: {"included_pnus":[...]}>]
 *     [--mode full|non-manual|manual-only]
 *   --include 는 anchors 를 명시 집합으로 좁힌다(활성 PNU ∩ included). 잔여 필지를
 *   묶음(G1 등)으로 처리할 때 쓰며, --exclude 와 함께 주면 둘 다 적용된다.
 */
import { readFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

import {
    computeDevelopmentActivePnuDigest,
    computeDevelopmentTargetDigest,
    computeDevelopmentTargetV3ManifestDigest,
    parseDevelopmentTargetManifest,
} from '../src/operations/development-land-area-sync-runner';

const UNION_ID = '7c35ee21-34fc-4597-84db-ee63e5b0d351';
const PRODUCTION_SUPABASE_URL = 'https://bpdjashtxqrcgxfequgf.supabase.co';
const PNU_RE = /^[0-9]{19}$/;
const LABEL_RE = /^[a-z0-9-]{1,100}$/;
const PAGE_SIZE = 500;

type Mode = 'full' | 'non-manual' | 'manual-only';

interface ActiveRow {
    id: string;
    pnu: string | null;
    land_area_source: string | null;
}

function parseArgs(argv: string[]): {
    label: string;
    out: string;
    excludeFile: string | null;
    includeFile: string | null;
    mode: Mode;
} {
    const args = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!key.startsWith('--')) throw new Error(`UNKNOWN_ARG: ${key}`);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`MISSING_VALUE: ${key}`);
        }
        args.set(key.slice(2), value);
        i += 1;
    }
    const label = args.get('label') ?? '';
    if (!LABEL_RE.test(label) || /[0-9]{19}/.test(label)) {
        throw new Error('LABEL_INVALID');
    }
    const out = args.get('out') ?? '';
    if (!out.endsWith('.json')) throw new Error('OUT_INVALID');
    const mode = (args.get('mode') ?? 'full') as Mode;
    if (!['full', 'non-manual', 'manual-only'].includes(mode)) {
        throw new Error('MODE_INVALID');
    }
    return {
        label,
        out,
        excludeFile: args.get('exclude') ?? null,
        includeFile: args.get('include') ?? null,
        mode,
    };
}

function readIncludedPnus(file: string | null): Set<string> | null {
    if (!file) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        included_pnus?: unknown;
    };
    if (!Array.isArray(parsed.included_pnus) || parsed.included_pnus.length === 0) {
        throw new Error('INCLUDE_INVALID');
    }
    const set = new Set<string>();
    for (const pnu of parsed.included_pnus) {
        if (typeof pnu !== 'string' || !PNU_RE.test(pnu)) {
            throw new Error(`INCLUDE_PNU_INVALID: ${String(pnu)}`);
        }
        set.add(pnu);
    }
    return set;
}

function readExcludedPnus(file: string | null): Set<string> {
    if (!file) return new Set();
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        excluded_pnus?: unknown;
    };
    if (!Array.isArray(parsed.excluded_pnus)) throw new Error('EXCLUDE_INVALID');
    const set = new Set<string>();
    for (const pnu of parsed.excluded_pnus) {
        if (typeof pnu !== 'string' || !PNU_RE.test(pnu)) {
            throw new Error(`EXCLUDE_PNU_INVALID: ${String(pnu)}`);
        }
        set.add(pnu);
    }
    return set;
}

async function main(): Promise<void> {
    const { label, out, excludeFile, includeFile, mode } = parseArgs(
        process.argv.slice(2)
    );

    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) throw new Error('MISSING_PRODUCTION_SUPABASE_ENV');
    if (url.replace(/\/+$/, '') !== PRODUCTION_SUPABASE_URL) {
        throw new Error('TARGET_DATABASE_MISMATCH: production URL 이 아니다');
    }

    const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    // 총행수를 먼저 고정하고 페이지 합이 정확히 같아야 한다 — PostgREST max-rows 절단 방지.
    const { count: expectedRows, error: countError } = await client
        .from('property_units')
        .select('id', { count: 'exact', head: true })
        .eq('union_id', UNION_ID)
        .eq('is_deleted', false);
    if (countError || typeof expectedRows !== 'number') {
        throw new Error(`COUNT_FAILED: ${countError?.message ?? 'no count'}`);
    }

    const rows: ActiveRow[] = [];
    for (let from = 0; from < expectedRows; from += PAGE_SIZE) {
        const { data, error } = await client
            .from('property_units')
            .select('id, pnu, land_area_source')
            .eq('union_id', UNION_ID)
            .eq('is_deleted', false)
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`READ_FAILED: ${error.message}`);
        if (!data || data.length === 0) break;
        rows.push(...(data as ActiveRow[]));
    }
    if (rows.length !== expectedRows) {
        throw new Error(
            `ACTIVE_ROW_COUNT_MISMATCH: paged ${rows.length} vs count ${expectedRows}`
        );
    }
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
        throw new Error('ACTIVE_ROW_DUPLICATE_ID');
    }

    const invalid = rows.filter((row) => !row.pnu || !PNU_RE.test(row.pnu));
    if (invalid.length > 0) {
        throw new Error(
            `ACTIVE_PNU_INVALID: ${invalid.length} rows (${invalid
                .slice(0, 5)
                .map((row) => row.id)
                .join(', ')})`
        );
    }

    const activePnus = [...new Set(rows.map((row) => row.pnu as string))].sort();
    const manualPnus = new Set(
        rows
            .filter((row) => row.land_area_source === 'MANUAL')
            .map((row) => row.pnu as string)
    );
    const excluded = readExcludedPnus(excludeFile);
    const excludedNotActive = [...excluded].filter(
        (pnu) => !activePnus.includes(pnu)
    );
    if (excludedNotActive.length > 0) {
        throw new Error(
            `EXCLUDE_NOT_ACTIVE: ${excludedNotActive.join(', ')}`
        );
    }

    const included = readIncludedPnus(includeFile);
    if (included) {
        const includedNotActive = [...included].filter(
            (pnu) => !activePnus.includes(pnu)
        );
        if (includedNotActive.length > 0) {
            throw new Error(
                `INCLUDE_NOT_ACTIVE: ${includedNotActive.join(', ')}`
            );
        }
    }

    const anchors = activePnus.filter((pnu) => {
        if (excluded.has(pnu)) return false;
        if (included && !included.has(pnu)) return false;
        if (mode === 'non-manual') return !manualPnus.has(pnu);
        if (mode === 'manual-only') return manualPnus.has(pnu);
        return true;
    });
    if (anchors.length === 0) throw new Error('ANCHORS_EMPTY');
    const allowedScopePnus = anchors;
    const anchorSet = new Set(anchors);

    const expectedUnionActivePropertyUnitCount = rows.length;
    const expectedPropertyUnitCount = rows.filter((row) =>
        anchorSet.has(row.pnu as string)
    ).length;
    const expectedUnionActivePnuCount = activePnus.length;

    const expectedUnionActivePnuDigest = computeDevelopmentActivePnuDigest(
        'production',
        UNION_ID,
        activePnus
    );
    const scopeDigest = computeDevelopmentTargetDigest(
        'production',
        UNION_ID,
        allowedScopePnus
    );
    const manifestDigest = computeDevelopmentTargetV3ManifestDigest({
        databaseTarget: 'production',
        unionId: UNION_ID,
        anchors,
        allowedScopePnus,
        expectedUnionActivePnus: activePnus,
        expectedUnionActivePnuDigest,
        targetCount: anchors.length,
        expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount,
        expectedUnionActivePnuCount,
        allowManualOverwrite: true,
    });

    const manifest = {
        version: 'land-area-development-target-manifest@3',
        databaseTarget: 'production',
        unionId: UNION_ID,
        anchors,
        allowedScopePnus,
        expectedUnionActivePnus: activePnus,
        expectedUnionActivePnuDigest,
        targetCount: anchors.length,
        scopeDigest,
        manifestDigest,
        expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount,
        expectedUnionActivePnuCount,
        allowManualOverwrite: true,
    };

    // 러너 파서로 자가 검증 — 키 집합·정렬·부분집합·digest 3종·카운트 불변식.
    const parsed = parseDevelopmentTargetManifest(
        JSON.parse(JSON.stringify(manifest))
    );
    if (parsed.version !== 'land-area-development-target-manifest@3') {
        throw new Error('SELF_VALIDATION_VERSION_MISMATCH');
    }

    const outPath = path.resolve(process.cwd(), out);
    await mkdir(path.dirname(outPath), { recursive: true });
    const handle = await open(outPath, 'w', 0o644);
    try {
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } finally {
        await handle.close();
    }

    console.log(
        JSON.stringify(
            {
                label,
                mode,
                activeRows: rows.length,
                activePnuCount: activePnus.length,
                manualPnuCount: manualPnus.size,
                manualUnitCount: rows.filter(
                    (row) => row.land_area_source === 'MANUAL'
                ).length,
                excludedCount: excluded.size,
                includedCount: included ? included.size : null,
                anchorCount: anchors.length,
                expectedPropertyUnitCount,
                expectedUnionActivePropertyUnitCount,
                expectedUnionActivePnuCount,
                expectedUnionActivePnuDigest,
                scopeDigest,
                manifestDigest,
                out: outPath,
            },
            null,
            2
        )
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
