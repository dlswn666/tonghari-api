import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('pre-register는 인증·현재 SYSTEM_ADMIN·차단·조합 scope 경계를 통과해야 한다', async () => {
    const routeSource = await readFile('src/routes/member.ts', 'utf8');
    assert.ok(
        routeSource.includes(
            "router.post('/pre-register', authMiddleware, memberSystemAdminMiddleware"
        ),
        'pre-register must use the authenticated current-role union-scope middleware'
    );
});

test('pre-register 실행자는 body가 아니라 서버에서 검증한 actorUserId만 사용한다', async () => {
    const routeSource = await readFile('src/routes/member.ts', 'utf8');
    const queueSource = await readFile('src/services/member.queue.service.ts', 'utf8');
    const typeSource = await readFile('src/types/member.types.ts', 'utf8');

    assert.ok(routeSource.includes('actorUserId: req.user!.actorUserId!'));
    assert.ok(!routeSource.includes('actorUserId: req.body'));
    assert.ok(typeSource.includes('actorUserId: string;'));
    assert.ok(
        queueSource.includes('actorUserId: request.actorUserId'),
        'persisted sync job preview must retain the server-derived actor'
    );
});

test('invite-sync도 인증된 현재 조합 관리자만 허용하고 body createdBy를 신뢰하지 않는다', async () => {
    const routeSource = await readFile('src/routes/member.ts', 'utf8');
    const queueSource = await readFile('src/services/member.queue.service.ts', 'utf8');
    assert.ok(
        routeSource.includes("router.post('/invite-sync', authMiddleware, memberAdminMiddleware")
    );
    assert.ok(routeSource.includes('createdBy: req.user!.actorUserId!'));
    assert.ok(!routeSource.includes('const { unionId, createdBy'));
    assert.ok(queueSource.includes('actorUserId: request.createdBy'));
});
