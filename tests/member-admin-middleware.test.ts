import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

type RuntimeModules = {
    memberAdminMiddleware: typeof import('../src/middleware/member-admin').memberAdminMiddleware;
    memberSystemAdminMiddleware: typeof import('../src/middleware/member-admin').memberSystemAdminMiddleware;
    supabaseService: typeof import('../src/services/supabase.service').supabaseService;
};

let runtimeModules: Promise<RuntimeModules> | undefined;

function loadRuntimeModules(): Promise<RuntimeModules> {
    if (!runtimeModules) {
        Object.assign(process.env, {
            JWT_SECRET: 'test-jwt-secret',
            ALIGO_API_KEY: 'test-aligo-key',
            ALIGO_USER_ID: 'test-aligo-user',
            ALIGO_SENDER_PHONE: '0212345678',
            DEFAULT_SENDER_KEY: 'test-sender-key',
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
        });
        runtimeModules = Promise.all([
            import('../src/middleware/member-admin'),
            import('../src/services/supabase.service'),
        ]).then(([middlewareModule, serviceModule]) => ({
            memberAdminMiddleware: middlewareModule.memberAdminMiddleware,
            memberSystemAdminMiddleware: middlewareModule.memberSystemAdminMiddleware,
            supabaseService: serviceModule.supabaseService,
        }));
    }
    return runtimeModules;
}

type QueryResult = { data: unknown; error: { message: string } | null };
type QueryPlan = Partial<Record<'user_auth_links' | 'users' | 'unions', QueryResult>>;

function createFakeClient(plan: QueryPlan) {
    return {
        from(table: keyof QueryPlan) {
            const result = () => plan[table] ?? { data: null, error: null };
            const builder: Record<string, unknown> & PromiseLike<QueryResult> = {
                select: () => builder,
                eq: () => builder,
                in: () => builder,
                maybeSingle: async () => result(),
                then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
            };
            return builder;
        },
    };
}

function createResponse() {
    const state: { status: number; body?: unknown } = { status: 200 };
    const response = {
        status(value: number) {
            state.status = value;
            return response;
        },
        json(value: unknown) {
            state.body = value;
            return response;
        },
    };
    return { response: response as unknown as Response, state };
}

function memberQueueUser(
    actorUserId: string,
    unionId = 'union-a',
    operation: 'MEMBER_INVITE_SYNC' | 'PRE_REGISTER' = 'MEMBER_INVITE_SYNC'
) {
    return {
        unionId,
        userId: 'auth-uuid',
        actorUserId,
        purpose: 'MEMBER_QUEUE' as const,
        operation,
        issuer: 'tonghari-web',
        audience: 'tonghari-api',
    };
}

async function runMiddleware(
    plan: QueryPlan,
    overrides: Partial<Request> = {},
    mode: 'invite' | 'pre-register' = 'invite'
) {
    const { memberAdminMiddleware, memberSystemAdminMiddleware, supabaseService } =
        await loadRuntimeModules();
    const originalGetClient = supabaseService.getClient;
    (supabaseService as unknown as { getClient: () => unknown }).getClient = () => createFakeClient(plan);
    const { response, state } = createResponse();
    let nextCalled = false;
    const request = {
        body: { unionId: ' union-a ' },
        user: memberQueueUser('admin-a'),
        ...overrides,
    } as unknown as Request;
    try {
        const middleware = mode === 'pre-register'
            ? memberSystemAdminMiddleware
            : memberAdminMiddleware;
        await middleware(
            request,
            response,
            (() => { nextCalled = true; }) as NextFunction
        );
        return { request, state, nextCalled };
    } finally {
        (supabaseService as unknown as { getClient: typeof originalGetClient }).getClient = originalGetClient;
    }
}

test('현재 요청 조합의 미차단 ADMIN과 전역 SYSTEM_ADMIN을 허용한다', async () => {
    for (const actor of [
        { id: 'admin-a', role: 'ADMIN', is_blocked: false, union_id: 'union-a' },
        { id: 'system-a', role: 'SYSTEM_ADMIN', is_blocked: false, union_id: null },
    ]) {
        const result = await runMiddleware({
            user_auth_links: { data: [{ user_id: actor.id }], error: null },
            users: { data: [actor], error: null },
            unions: { data: { id: 'union-a' }, error: null },
        }, {
            user: memberQueueUser(actor.id),
        });
        assert.equal(result.nextCalled, true);
        assert.equal(result.request.user?.actorUserId, actor.id);
        assert.equal(result.request.body.unionId, 'union-a');
    }
});

test('타 조합 ADMIN·차단 관리자·일반 사용자는 fail-closed한다', async () => {
    for (const actor of [
        { id: 'admin-b', role: 'ADMIN', is_blocked: false, union_id: 'union-b' },
        { id: 'admin-a', role: 'ADMIN', is_blocked: true, union_id: 'union-a' },
        { id: 'user-a', role: 'USER', is_blocked: false, union_id: 'union-a' },
    ]) {
        const result = await runMiddleware({
            user_auth_links: { data: [{ user_id: actor.id }], error: null },
            users: { data: actor.role === 'USER' ? [] : [actor], error: null },
        }, {
            user: memberQueueUser(actor.id),
        });
        assert.equal(result.nextCalled, false);
        assert.equal(result.state.status, 403);
    }
});

test('토큰 조합 변조와 DB 조회 오류를 거부한다', async () => {
    const mismatch = await runMiddleware({}, {
        user: memberQueueUser('admin-a', 'union-b'),
    } as Partial<Request>);
    assert.equal(mismatch.state.status, 403);

    const lookupFailure = await runMiddleware({
        user_auth_links: { data: null, error: { message: 'db unavailable' } },
    });
    assert.equal(lookupFailure.state.status, 503);
});

test('토큰 actor가 현재 auth UUID의 연결 profile과 다르면 거부한다', async () => {
    const result = await runMiddleware({
        user_auth_links: { data: [{ user_id: 'admin-a' }], error: null },
    }, {
        user: memberQueueUser('attacker-admin'),
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.state.status, 403);
    assert.deepEqual(result.state.body, {
        success: false,
        code: 'ACTOR_ID_MISMATCH',
        error: '토큰 실행자가 현재 인증 사용자와 연결되어 있지 않습니다.',
    });
});

test('다른 용도의 shared-secret 토큰은 조합원 queue에 사용할 수 없다', async () => {
    const result = await runMiddleware({}, {
        user: {
            ...memberQueueUser('admin-a'),
            purpose: 'GIS_SYSTEM_ADMIN',
        },
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.state.status, 403);
    assert.deepEqual(result.state.body, {
        success: false,
        code: 'TOKEN_PURPOSE_INVALID',
        error: '조합원 queue 전용 토큰이 필요합니다.',
    });
});

test('사전등록은 PRE_REGISTER 토큰의 동일 SYSTEM_ADMIN profile만 허용한다', async () => {
    const systemActor = {
        id: 'system-a',
        role: 'SYSTEM_ADMIN',
        is_blocked: false,
        union_id: null,
    };
    const allowed = await runMiddleware({
        user_auth_links: { data: [{ user_id: systemActor.id }], error: null },
        users: { data: [systemActor], error: null },
        unions: { data: { id: 'union-a' }, error: null },
    }, {
        user: memberQueueUser(systemActor.id, 'union-a', 'PRE_REGISTER'),
    }, 'pre-register');
    assert.equal(allowed.nextCalled, true);

    const adminActor = {
        id: 'admin-a',
        role: 'ADMIN',
        is_blocked: false,
        union_id: 'union-a',
    };
    const adminDenied = await runMiddleware({
        user_auth_links: { data: [{ user_id: adminActor.id }], error: null },
        users: { data: [adminActor], error: null },
    }, {
        user: memberQueueUser(adminActor.id, 'union-a', 'PRE_REGISTER'),
    }, 'pre-register');
    assert.equal(adminDenied.nextCalled, false);
    assert.equal(adminDenied.state.status, 403);

    const wrongOperation = await runMiddleware({}, {
        user: memberQueueUser(systemActor.id, 'union-a', 'MEMBER_INVITE_SYNC'),
    }, 'pre-register');
    assert.equal(wrongOperation.nextCalled, false);
    assert.equal(wrongOperation.state.status, 403);
    assert.deepEqual(wrongOperation.state.body, {
        success: false,
        code: 'TOKEN_PURPOSE_INVALID',
        error: '조합원 queue 전용 토큰이 필요합니다.',
    });
});
