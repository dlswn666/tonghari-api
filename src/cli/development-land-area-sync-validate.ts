import {
    chmod,
    lstat,
    readFile,
    realpath,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    controlledFailureCode,
    createDevelopmentPublicRunArtifact,
    parseDevelopmentTargetManifest,
    validateDevelopmentRunArtifact,
    validateDevelopmentPublicRunArtifact,
} from '../operations/development-land-area-sync-runner';

const PRIVATE_DIRECTORY = '.development-land-area-sync';
const INPUT_SIZE_LIMIT = 3 * 1024 * 1024;

function argument(argv: string[], key: string): string {
    const index = argv.indexOf(key);
    if (
        index < 0 ||
        index + 1 >= argv.length ||
        argv.filter((value) => value === key).length !== 1
    ) {
        throw new Error('CLI_ARGUMENT_INVALID');
    }
    return argv[index + 1];
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

async function readJson(candidate: string): Promise<unknown> {
    const target = resolvePrivatePath(candidate);
    const parent = path.dirname(target);
    const [parentStat, targetStat] = await Promise.all([
        lstat(parent),
        lstat(target),
    ]);
    if (
        !parentStat.isDirectory() ||
        parentStat.isSymbolicLink() ||
        !targetStat.isFile() ||
        targetStat.isSymbolicLink() ||
        targetStat.size < 2 ||
        targetStat.size > INPUT_SIZE_LIMIT
    ) {
        throw new Error('CLI_INPUT_FILE_INVALID');
    }
    const [parentReal, targetReal] = await Promise.all([
        realpath(parent),
        realpath(target),
    ]);
    if (!targetReal.startsWith(`${parentReal}${path.sep}`)) {
        throw new Error('CLI_INPUT_FILE_INVALID');
    }
    return JSON.parse(await readFile(targetReal, 'utf8')) as unknown;
}

async function writePublicJson(
    candidate: string,
    value: unknown
): Promise<void> {
    const target = resolvePrivatePath(candidate);
    const root = path.resolve(process.cwd(), PRIVATE_DIRECTORY);
    if (path.dirname(target) !== root) {
        throw new Error('CLI_PUBLIC_OUTPUT_PATH_INVALID');
    }
    const [rootStat, rootReal] = await Promise.all([
        lstat(root),
        realpath(root),
    ]);
    if (
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        rootReal !== root
    ) {
        throw new Error('CLI_PUBLIC_OUTPUT_PATH_INVALID');
    }
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    await chmod(target, 0o600);
    const outputStat = await lstat(target);
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) {
        throw new Error('CLI_PUBLIC_OUTPUT_PATH_INVALID');
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.length !== 4 && argv.length !== 8) {
        throw new Error('CLI_ARGUMENT_INVALID');
    }
    const target = parseDevelopmentTargetManifest(
        await readJson(argument(argv, '--target'))
    );
    const artifact = validateDevelopmentRunArtifact(
        await readJson(argument(argv, '--artifact')),
        target
    );
    if (argv.length === 8) {
        const manifestLabel = argument(argv, '--manifest-label');
        const publicArtifact = createDevelopmentPublicRunArtifact(
            artifact,
            manifestLabel
        );
        validateDevelopmentPublicRunArtifact(
            publicArtifact,
            manifestLabel
        );
        const publicOutput = argument(argv, '--public-out');
        await writePublicJson(publicOutput, publicArtifact);
        validateDevelopmentPublicRunArtifact(
            await readJson(publicOutput),
            manifestLabel
        );
    }
    process.stdout.write('LAND_AREA_DEVELOPMENT_RUN_ARTIFACT_VALIDATED\n');
}

main().catch((error: unknown) => {
    process.stderr.write(
        `LAND_AREA_DEVELOPMENT_VALIDATOR_ERROR:${controlledFailureCode(error)}\n`
    );
    process.exitCode = 1;
});
