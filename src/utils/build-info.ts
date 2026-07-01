import packageJson from '../../package.json';

interface BuildInfoOptions {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    packageVersion?: string;
    fallbackGitSha?: string;
    fallbackBuildTime?: string;
}

export interface BuildInfo {
    version: string;
    gitSha: string;
    buildTime: string;
    imageTag: string;
}

export function createBuildInfo(options: BuildInfoOptions = {}): BuildInfo {
    const env = options.env ?? process.env;

    return {
        version: options.packageVersion ?? packageJson.version,
        gitSha: env.GIT_SHA || env.VERCEL_GIT_COMMIT_SHA || options.fallbackGitSha || 'unknown',
        buildTime: env.BUILD_TIME || options.fallbackBuildTime || 'unknown',
        imageTag: env.IMAGE_TAG || env.DOCKER_IMAGE_TAG || 'local',
    };
}
