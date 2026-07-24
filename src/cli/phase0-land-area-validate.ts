/**
 * Candidate image 안에서 실행하는 Phase 0 artifact validator CLI.
 *
 * 성공 시 고정 sentinel만 stdout에 기록하며 raw manifest/artifact/PNU/secret은
 * 어떤 실패 경로에서도 출력하지 않는다.
 */

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    LAND_AREA_PHASE0_MAX_ARTIFACT_BYTES,
    LAND_AREA_PHASE0_OUTPUT_DIRECTORY,
} from '../verification/land-area-phase0-capture';
import { validateLandAreaPhase0CaptureArtifact } from '../verification/land-area-phase0-artifact-validator';

const MAX_MANIFEST_BYTES = 64 * 1024;
const PRIVATE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.json$/;
export const LAND_AREA_PHASE0_VALIDATION_SENTINEL =
    'LAND_AREA_PHASE0_ARTIFACT_VALIDATED' as const;

export interface LandAreaPhase0ValidationCliDependencies {
    cwd?: string;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
}

interface ParsedArgs {
    manifest: string;
    artifact: string;
}

function parseArgs(args: string[]): ParsedArgs {
    if (args.length !== 4) throw new Error('invalid arguments');
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (
            (flag !== '--manifest' && flag !== '--artifact') ||
            !value ||
            value.startsWith('--') ||
            values.has(flag)
        ) {
            throw new Error('invalid arguments');
        }
        values.set(flag, value);
    }
    const manifest = values.get('--manifest');
    const artifact = values.get('--artifact');
    if (!manifest || !artifact || manifest === artifact) {
        throw new Error('invalid arguments');
    }
    return { manifest, artifact };
}

function resolvePrivateFile(cwd: string, requested: string): string {
    const root = path.resolve(cwd, LAND_AREA_PHASE0_OUTPUT_DIRECTORY);
    const normalized = requested.replaceAll('\\', '/');
    const filename = normalized.startsWith(`${LAND_AREA_PHASE0_OUTPUT_DIRECTORY}/`)
        ? normalized.slice(LAND_AREA_PHASE0_OUTPUT_DIRECTORY.length + 1)
        : normalized;
    if (
        filename.includes('/') ||
        !PRIVATE_FILE_PATTERN.test(filename) ||
        path.dirname(path.resolve(root, filename)) !== root
    ) {
        throw new Error('invalid private file path');
    }
    return path.resolve(root, filename);
}

async function readPrivateJson(
    cwd: string,
    requested: string,
    maxBytes: number
): Promise<unknown> {
    const root = path.resolve(cwd, LAND_AREA_PHASE0_OUTPUT_DIRECTORY);
    const filePath = resolvePrivateFile(cwd, requested);
    const rootInfo = await lstat(root);
    if (
        !rootInfo.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        (rootInfo.mode & 0o077) !== 0
    ) {
        throw new Error('invalid private directory');
    }
    const fileInfo = await lstat(filePath);
    if (
        !fileInfo.isFile() ||
        fileInfo.isSymbolicLink() ||
        (fileInfo.mode & 0o077) !== 0 ||
        fileInfo.size <= 0 ||
        fileInfo.size > maxBytes
    ) {
        throw new Error('invalid private file');
    }
    const text = await readFile(filePath, 'utf8');
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error('invalid JSON');
    }
}

export async function runLandAreaPhase0ValidationCli(
    args: string[],
    dependencies: LandAreaPhase0ValidationCliDependencies = {}
): Promise<number> {
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());
    const stdout =
        dependencies.stdout ??
        ((message: string) => process.stdout.write(`${message}\n`));
    const stderr =
        dependencies.stderr ??
        ((message: string) => process.stderr.write(`${message}\n`));
    try {
        const parsed = parseArgs(args);
        const manifest = await readPrivateJson(
            cwd,
            parsed.manifest,
            MAX_MANIFEST_BYTES
        );
        const artifact = await readPrivateJson(
            cwd,
            parsed.artifact,
            LAND_AREA_PHASE0_MAX_ARTIFACT_BYTES
        );
        validateLandAreaPhase0CaptureArtifact(manifest, artifact);
        stdout(LAND_AREA_PHASE0_VALIDATION_SENTINEL);
        return 0;
    } catch {
        stderr('Phase 0 artifact validation rejected.');
        return 2;
    }
}

export async function mainLandAreaPhase0ValidationCli(): Promise<void> {
    process.exitCode = await runLandAreaPhase0ValidationCli(
        process.argv.slice(2)
    );
}

if (require.main === module) {
    void mainLandAreaPhase0ValidationCli();
}
