import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
    LocalhostDevelopmentLandAreaSyncClient,
    controlledFailureCode,
    parseDevelopmentDbApprovalManifest,
    parseDevelopmentEvidenceManifest,
    parseDevelopmentTargetManifest,
    runDevelopmentLandAreaSync,
    validateDevelopmentRunnerEnvironment,
} from '../operations/development-land-area-sync-runner';

const PRIVATE_DIRECTORY = '.development-land-area-sync';
const INPUT_SIZE_LIMIT = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CliArguments {
    targetPath: string;
    dbApprovalPath: string;
    evidencePath: string;
    actorAuthUserId: string;
    outputPath: string;
}

function parseArguments(argv: string[]): CliArguments {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (
            !key ||
            !value ||
            ![
                '--target',
                '--db-approval',
                '--evidence',
                '--actor-auth-user-id',
                '--out',
            ].includes(key) ||
            values.has(key)
        ) {
            throw new Error('CLI_ARGUMENT_INVALID');
        }
        values.set(key, value);
    }
    const targetPath = values.get('--target');
    const dbApprovalPath = values.get('--db-approval');
    const evidencePath = values.get('--evidence');
    const actorAuthUserId = values.get('--actor-auth-user-id');
    const outputPath = values.get('--out');
    if (
        !targetPath ||
        !dbApprovalPath ||
        !evidencePath ||
        !actorAuthUserId ||
        !outputPath ||
        !UUID_RE.test(actorAuthUserId)
    ) {
        throw new Error('CLI_ARGUMENT_INVALID');
    }
    return {
        targetPath,
        dbApprovalPath,
        evidencePath,
        actorAuthUserId: actorAuthUserId.toLowerCase(),
        outputPath,
    };
}

function resolvePrivatePath(candidate: string): string {
    const root = path.resolve(process.cwd(), PRIVATE_DIRECTORY);
    const resolved = path.resolve(process.cwd(), candidate);
    if (
        resolved === root ||
        !resolved.startsWith(`${root}${path.sep}`)
    ) {
        throw new Error('CLI_PATH_OUTSIDE_PRIVATE_DIRECTORY');
    }
    return resolved;
}

async function readJsonInput(candidate: string): Promise<unknown> {
    const target = resolvePrivatePath(candidate);
    const root = path.dirname(target);
    const [rootStat, targetStat] = await Promise.all([
        lstat(root),
        lstat(target),
    ]);
    if (
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        !targetStat.isFile() ||
        targetStat.isSymbolicLink() ||
        targetStat.size < 2 ||
        targetStat.size > INPUT_SIZE_LIMIT
    ) {
        throw new Error('CLI_INPUT_FILE_INVALID');
    }
    const [rootReal, targetReal] = await Promise.all([
        realpath(root),
        realpath(target),
    ]);
    if (!targetReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error('CLI_INPUT_FILE_INVALID');
    }
    return JSON.parse(await readFile(targetReal, 'utf8')) as unknown;
}

async function writeArtifact(
    candidate: string,
    artifact: unknown
): Promise<void> {
    const target = resolvePrivatePath(candidate);
    const parent = path.dirname(target);
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error('CLI_OUTPUT_DIRECTORY_INVALID');
    }
    const body = `${JSON.stringify(artifact, null, 2)}\n`;
    const file = await open(target, 'wx', 0o600);
    try {
        await file.writeFile(body, 'utf8');
    } finally {
        await file.close();
    }
}

async function main(): Promise<void> {
    const args = parseArguments(process.argv.slice(2));
    const [targetInput, dbApprovalInput, evidenceInput] = await Promise.all([
        readJsonInput(args.targetPath),
        readJsonInput(args.dbApprovalPath),
        readJsonInput(args.evidencePath),
    ]);
    const target = parseDevelopmentTargetManifest(targetInput);
    const dbApproval =
        parseDevelopmentDbApprovalManifest(dbApprovalInput);
    const evidence = parseDevelopmentEvidenceManifest(evidenceInput);
    validateDevelopmentRunnerEnvironment(process.env, target);

    const client = new LocalhostDevelopmentLandAreaSyncClient(
        process.env.DEV_API_JWT_SECRET!,
        args.actorAuthUserId
    );
    const developmentDatabase = createClient(
        process.env.DEV_SUPABASE_URL!,
        process.env.DEV_SUPABASE_SERVICE_ROLE_KEY!,
        {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
            },
        }
    );
    const artifact = await runDevelopmentLandAreaSync({
        target,
        dbApproval,
        evidence,
        client,
        preflightReader: {
            async readActivePropertyUnits(unionId) {
                const { data, error } = await developmentDatabase
                    .from('property_units')
                    .select(
                        'id, pnu, land_area, land_area_source, land_area_synced_at, land_area_sync_job_id'
                    )
                    .eq('union_id', unionId)
                    .eq('is_deleted', false)
                    .order('id', { ascending: true })
                    .range(
                        0,
                        target.expectedUnionActivePropertyUnitCount
                    );
                if (error || !Array.isArray(data)) {
                    throw new Error('DEVELOPMENT_PREFLIGHT_READ_FAILED');
                }
                return data.map((row: Record<string, unknown>) => {
                    const source =
                        row.land_area_source == null
                            ? 'LEGACY_UNKNOWN'
                            : String(row.land_area_source);
                    if (
                        source !== 'LEGACY_UNKNOWN' &&
                        source !== 'MANUAL' &&
                        source !== 'LADFRL' &&
                        source !== 'LDAREG'
                    ) {
                        throw new Error('DEVELOPMENT_PREFLIGHT_SOURCE_INVALID');
                    }
                    return {
                        id: String(row.id ?? ''),
                        pnu: String(row.pnu ?? ''),
                        landArea:
                            row.land_area == null
                                ? null
                                : String(row.land_area),
                        landAreaSource: source,
                        landAreaSyncedAt:
                            row.land_area_synced_at == null
                                ? null
                                : String(row.land_area_synced_at),
                        landAreaSyncJobId:
                            row.land_area_sync_job_id == null
                                ? null
                                : String(row.land_area_sync_job_id),
                    };
                });
            },
            async readPropertyUnitsBySyncJobIds(syncJobIds) {
                if (
                    syncJobIds.length < 1 ||
                    syncJobIds.length > target.targetCount
                ) {
                    throw new Error(
                        'DEVELOPMENT_WRITE_ATTRIBUTION_SCOPE_INVALID'
                    );
                }
                const { data, error } = await developmentDatabase
                    .from('property_units')
                    .select('id, union_id, land_area_sync_job_id')
                    .in('land_area_sync_job_id', syncJobIds)
                    .order('id', { ascending: true })
                    .range(0, target.expectedPropertyUnitCount);
                if (error || !Array.isArray(data)) {
                    throw new Error(
                        'DEVELOPMENT_WRITE_ATTRIBUTION_READ_FAILED'
                    );
                }
                return data.map((row: Record<string, unknown>) => ({
                    id: String(row.id ?? ''),
                    unionId: String(row.union_id ?? ''),
                    landAreaSyncJobId: String(
                        row.land_area_sync_job_id ?? ''
                    ),
                }));
            },
        },
    });
    await writeArtifact(args.outputPath, artifact);
    process.stdout.write(
        `LAND_AREA_DEVELOPMENT_RUN_ARTIFACT:${artifact.gate.status}\n`
    );
    if (artifact.gate.status !== 'PASS') {
        process.exitCode = 1;
    }
}

main().catch((error: unknown) => {
    process.stderr.write(
        `LAND_AREA_DEVELOPMENT_RUNNER_ERROR:${controlledFailureCode(error)}\n`
    );
    process.exitCode = 2;
});
