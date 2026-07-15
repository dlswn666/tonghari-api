import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
    assertDisposableCloneArtifactPair,
    parsePhase0MemberImportApproval,
    parsePhase0SnapshotArtifact,
    verifyPhase0InvariantOperation,
    verifyPhase0MemberImport,
} from '../src/verification/phase0-s-artifact';
import {
    assertDistinctPhase0UnionSelection,
    assertDisposableCloneTarget,
    capturePhase0CloneArtifact,
} from '../src/verification/phase0-s-clone-reader';

type ParsedArgs = { values: Map<string, string[]>; positionals: string[] };

function parseArgs(args: string[]): ParsedArgs {
    const values = new Map<string, string[]>();
    const positionals: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const token = args[index];
        if (!token.startsWith('--')) {
            positionals.push(token);
            continue;
        }
        const value = args[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${token} 값이 필요합니다.`);
        const key = token.slice(2);
        values.set(key, [...(values.get(key) ?? []), value]);
        index++;
    }
    return { values, positionals };
}

function required(args: ParsedArgs, name: string): string {
    const value = args.values.get(name)?.at(-1);
    if (!value) throw new Error(`--${name} 값이 필요합니다.`);
    return value;
}

function all(args: ParsedArgs, name: string): string[] {
    return args.values.get(name) ?? [];
}

async function readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function resolvePrivateArtifactPath(path: string): string {
    const privateRoot = resolve(process.cwd(), '.phase0-s');
    const output = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
    const relation = relative(privateRoot, output);
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        throw new Error('snapshot artifact는 gitignore된 .phase0-s/ 아래에만 저장할 수 있습니다.');
    }
    return output;
}

function parseUnion(value: string): { alias: string; unionId: string } {
    const separator = value.indexOf('=');
    if (separator < 1 || separator === value.length - 1) {
        throw new Error(`--union은 A=<union_uuid> 형식이어야 합니다: ${value}`);
    }
    return { alias: value.slice(0, separator), unionId: value.slice(separator + 1) };
}

async function capture(args: ParsedArgs): Promise<void> {
    const unions = all(args, 'union').map(parseUnion);
    assertDistinctPhase0UnionSelection(unions);
    const url = process.env.PHASE0_S_CLONE_URL;
    const key = process.env.PHASE0_S_CLONE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error('PHASE0_S_CLONE_URL과 PHASE0_S_CLONE_SERVICE_ROLE_KEY가 필요합니다.');
    }
    const target = assertDisposableCloneTarget({
        url,
        confirmation: process.env.PHASE0_S_CLONE_CONFIRMED,
        cloneProjectRef: process.env.PHASE0_S_CLONE_PROJECT_REF,
        productionProjectRef: process.env.PHASE0_S_PRODUCTION_PROJECT_REF,
        configuredProductionUrl: process.env.SUPABASE_URL,
    });
    const output = resolvePrivateArtifactPath(required(args, 'out'));
    const client = createClient(target.normalizedUrl, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const artifact = await capturePhase0CloneArtifact({
        client,
        projectRef: target.projectRef,
        label: required(args, 'label'),
        unions,
    });
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    await chmod(output, 0o600);

    // 원문 row/union id를 stdout에 출력하지 않는다.
    console.log(JSON.stringify({
        success: true,
        output,
        aliases: artifact.unions.map((union) => ({
            alias: union.alias,
            sharedPnuHashCount: union.sharedPnuHashes.length,
            datasets: Object.fromEntries(
                Object.entries(union.datasets).map(([name, dataset]) => [name, {
                    rowCount: dataset.rowCount,
                    digest: dataset.digest,
                }])
            ),
        })),
    }, null, 2));
}

async function verifyInvariant(args: ParsedArgs): Promise<void> {
    const before = parsePhase0SnapshotArtifact(await readJson(required(args, 'before')));
    const after = parsePhase0SnapshotArtifact(await readJson(required(args, 'after')));
    assertDisposableCloneArtifactPair(before, after);
    const result = verifyPhase0InvariantOperation({
        before,
        after,
        operation: required(args, 'operation'),
        unionAliases: all(args, 'union'),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
}

async function verifyMemberImport(args: ParsedArgs): Promise<void> {
    const before = parsePhase0SnapshotArtifact(await readJson(required(args, 'before')));
    const after = parsePhase0SnapshotArtifact(await readJson(required(args, 'after')));
    assertDisposableCloneArtifactPair(before, after);
    const approval = parsePhase0MemberImportApproval(await readJson(required(args, 'approval')));
    const result = verifyPhase0MemberImport({ before, after, approval });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const command = args.positionals[0];
    switch (command) {
        case 'capture':
            await capture(args);
            break;
        case 'verify-invariant':
            await verifyInvariant(args);
            break;
        case 'verify-member-import':
            await verifyMemberImport(args);
            break;
        default:
            throw new Error(
                '사용법: capture | verify-invariant | verify-member-import (각 명령은 --help 대신 인자 누락 오류를 반환합니다.)'
            );
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Phase 0-S gate failed');
    process.exitCode = 1;
});
