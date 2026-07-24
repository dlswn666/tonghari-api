/**
 * Phase 0 read-only live capture CLI.
 *
 * production image에서는 다음 compiled entry를 직접 실행한다.
 * node dist/cli/phase0-land-area-capture.js --input <manifest> --out <artifact>
 */

import {
    lstat,
    mkdir,
    open,
    readFile,
    chmod,
} from 'node:fs/promises';
import path from 'node:path';
import { LandAreaSyncAdapter } from '../services/land-area-sync/adapter';
import {
    LAND_AREA_PHASE0_OUTPUT_DIRECTORY,
    captureLandAreaPhase0,
    parseLandAreaPhase0Manifest,
    resolveLandAreaPhase0OutputPath,
    type LandAreaPhase0CaptureAdapter,
} from '../verification/land-area-phase0-capture';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 3 * 1024 * 1024;
const STDOUT_LIMIT = 256;

interface CliEnvironment {
    DATA_PORTAL_API_KEY?: string;
    VWORLD_API_KEY?: string;
    VWORLD_API_DOMAIN?: string;
    VWORLD_DOMAIN?: string;
    [key: string]: string | undefined;
}

export interface LandAreaPhase0CliDependencies {
    cwd?: string;
    env?: CliEnvironment;
    adapter?: LandAreaPhase0CaptureAdapter;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
}

interface ParsedArgs {
    input: string;
    out: string;
}

function parseArgs(args: string[]): ParsedArgs {
    if (args.length !== 4) {
        throw new Error('인자 형식이 올바르지 않습니다.');
    }
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (
            (flag !== '--input' && flag !== '--out') ||
            !value ||
            value.startsWith('--') ||
            values.has(flag)
        ) {
            throw new Error('인자 형식이 올바르지 않습니다.');
        }
        values.set(flag, value);
    }
    const input = values.get('--input');
    const out = values.get('--out');
    if (!input || !out) {
        throw new Error('인자 형식이 올바르지 않습니다.');
    }
    return { input, out };
}

function requiredSecret(value: string | undefined): string {
    const normalized = value?.trim();
    if (!normalized) {
        throw new Error('필수 인증 설정이 없습니다.');
    }
    return normalized;
}

function validatedDomain(value: string | undefined): string {
    const domain = requiredSecret(value);
    const hostnamePattern =
        /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
    if (hostnamePattern.test(domain)) return domain;

    try {
        const parsed = new URL(domain);
        if (
            parsed.protocol === 'https:' &&
            !parsed.username &&
            !parsed.password &&
            Boolean(parsed.hostname) &&
            (parsed.pathname === '/' || parsed.pathname === '') &&
            !parsed.search &&
            !parsed.hash
        ) {
            return domain;
        }
    } catch {
        // 아래의 고정 오류로 fail-closed한다.
    }
    throw new Error('API domain 형식이 올바르지 않습니다.');
}

async function readPrivateManifest(
    cwd: string,
    inputPath: string
): Promise<unknown> {
    const root = path.resolve(cwd, LAND_AREA_PHASE0_OUTPUT_DIRECTORY);
    if (path.dirname(inputPath) !== root) {
        throw new Error('manifest는 전용 디렉터리 바로 아래에 있어야 합니다.');
    }
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error('manifest 디렉터리 경계가 올바르지 않습니다.');
    }
    if ((rootInfo.mode & 0o077) !== 0) {
        throw new Error('manifest 디렉터리 권한은 private이어야 합니다.');
    }
    const info = await lstat(inputPath);
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('manifest는 일반 파일이어야 합니다.');
    }
    if ((info.mode & 0o077) !== 0) {
        throw new Error('manifest 파일 권한은 private이어야 합니다.');
    }
    if (info.size <= 0 || info.size > MAX_MANIFEST_BYTES) {
        throw new Error('manifest 파일 크기가 허용 범위를 벗어났습니다.');
    }
    const text = await readFile(inputPath, 'utf8');
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error('manifest JSON 형식이 올바르지 않습니다.');
    }
}

function bounded(message: string): string {
    return message.length <= STDOUT_LIMIT
        ? message
        : `${message.slice(0, STDOUT_LIMIT - 3)}...`;
}

async function ensurePrivateOutputDirectory(
    cwd: string,
    outputPath: string
): Promise<string> {
    const root = path.resolve(cwd, LAND_AREA_PHASE0_OUTPUT_DIRECTORY);
    if (path.dirname(outputPath) !== root) {
        throw new Error('출력 경로가 전용 디렉터리를 벗어났습니다.');
    }
    try {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error('출력 디렉터리 경계가 올바르지 않습니다.');
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(root, { mode: 0o700 });
    }
    await chmod(root, 0o700);
    return root;
}

/**
 * artifact를 exclusive create로 기록한다. 기존 파일과 symlink를 덮어쓰지 않는다.
 */
export async function writeLandAreaPhase0Artifact(
    cwd: string,
    outputPath: string,
    artifact: unknown
): Promise<void> {
    const json = JSON.stringify(artifact, null, 2);
    if (json === undefined) {
        throw new Error('artifact 직렬화에 실패했습니다.');
    }
    const serialized = `${json}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ARTIFACT_BYTES) {
        throw new Error('artifact 크기가 허용 범위를 벗어났습니다.');
    }
    await ensurePrivateOutputDirectory(cwd, outputPath);
    let handle;
    try {
        handle = await open(outputPath, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('출력 artifact가 이미 존재합니다.');
        }
        throw error;
    }
    try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
        await handle.chmod(0o600);
    } finally {
        await handle.close();
    }
}

/**
 * 성공은 0, capture gate 실패는 1, 입력·환경·파일 경계 실패는 2를 반환한다.
 */
export async function runLandAreaPhase0CaptureCli(
    args: string[],
    dependencies: LandAreaPhase0CliDependencies = {}
): Promise<number> {
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());
    const env = dependencies.env ?? process.env;
    const stdout = dependencies.stdout ?? ((message) => process.stdout.write(`${message}\n`));
    const stderr = dependencies.stderr ?? ((message) => process.stderr.write(`${message}\n`));

    try {
        const parsedArgs = parseArgs(args);
        const inputPath = path.resolve(cwd, parsedArgs.input);
        const outputPath = resolveLandAreaPhase0OutputPath(cwd, parsedArgs.out);
        if (inputPath === outputPath) {
            throw new Error('입력과 출력 경로가 같을 수 없습니다.');
        }

        const rawManifest = await readPrivateManifest(cwd, inputPath);
        const manifest = parseLandAreaPhase0Manifest(rawManifest);
        const buildingHubAuth = {
            serviceKey: requiredSecret(env.DATA_PORTAL_API_KEY),
        };
        const vworldAuth = {
            key: requiredSecret(env.VWORLD_API_KEY),
            domain: validatedDomain(
                env.VWORLD_API_DOMAIN ||
                    env.VWORLD_DOMAIN ||
                    'www.tonghari.kr'
            ),
        };
        const artifact = await captureLandAreaPhase0({
            manifest,
            adapter: dependencies.adapter ?? new LandAreaSyncAdapter(),
            buildingHubAuth,
            vworldAuth,
        });
        await writeLandAreaPhase0Artifact(cwd, outputPath, artifact);

        if (artifact.gate.status === 'PASS') {
            stdout(
                bounded(
                    `Phase 0 capture PASS (samples=${artifact.samples.length}, artifact=written)`
                )
            );
            return 0;
        }
        stdout(
            bounded(
                `Phase 0 capture FAIL (samples=${artifact.samples.length}, failures=${artifact.gate.failureCodes.length}, artifact=written)`
            )
        );
        return 1;
    } catch {
        stderr('Phase 0 capture rejected (input, environment, or file boundary).');
        return 2;
    }
}

export async function mainLandAreaPhase0CaptureCli(): Promise<void> {
    process.exitCode = await runLandAreaPhase0CaptureCli(process.argv.slice(2));
}

if (require.main === module) {
    void mainLandAreaPhase0CaptureCli();
}
