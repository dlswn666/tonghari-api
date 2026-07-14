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

test('조합원 초대 작업의 DB column type과 preview subtype 계약을 고정한다', async () => {
    const source = await readFile('src/services/member.queue.service.ts', 'utf8');
    const start = source.indexOf('async addMemberInviteSyncJob');
    const end = source.indexOf('async addPreRegisterJob', start);
    const producer = source.slice(start, end);

    assert.ok(producer.includes("job_type: 'MEMBER_INVITE'"));
    assert.ok(producer.includes("preview_data: { job_type: 'MEMBER_INVITE_SYNC' }"));
});
