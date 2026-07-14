import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('구 member/consent status 및 list endpoint는 410으로 fail-closed한다', async () => {
    for (const file of ['src/routes/member.ts', 'src/routes/consent.ts']) {
        const source = await readFile(file, 'utf8');

        assert.match(source, /status\(410\)/, `${file}: 410 boundary missing`);
        assert.ok(source.includes("router.get('/job/:jobId', legacyJobReadDisabled)"));
        assert.ok(source.includes("router.get('/job/:jobId/db', legacyJobReadDisabled)"));
        assert.ok(source.includes("router.get('/jobs/:unionId', legacyJobReadDisabled)"));
        assert.ok(!source.includes(".from('sync_jobs')"), `${file}: legacy status DB read remains`);
        assert.ok(!source.includes('getJobStatus(jobId)'), `${file}: legacy in-memory status read remains`);
    }
});
