import assert from 'node:assert/strict';
import { createBuildInfo } from '../src/utils/build-info';

{
    const info = createBuildInfo({
        env: {
            GIT_SHA: 'abc1234',
            BUILD_TIME: '2026-07-02T01:23:45.000Z',
            IMAGE_TAG: 'tonghari-api:abc1234',
        },
        packageVersion: '1.2.3',
    });

    assert.equal(info.version, '1.2.3');
    assert.equal(info.gitSha, 'abc1234');
    assert.equal(info.buildTime, '2026-07-02T01:23:45.000Z');
    assert.equal(info.imageTag, 'tonghari-api:abc1234');
}

{
    const info = createBuildInfo({
        env: {},
        packageVersion: '1.2.3',
        fallbackGitSha: 'localsha',
        fallbackBuildTime: '2026-07-02T02:00:00.000Z',
    });

    assert.equal(info.version, '1.2.3');
    assert.equal(info.gitSha, 'localsha');
    assert.equal(info.buildTime, '2026-07-02T02:00:00.000Z');
    assert.equal(info.imageTag, 'local');
}
