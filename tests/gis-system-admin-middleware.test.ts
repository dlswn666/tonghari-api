import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

type RuntimeModules = {
    gisSystemAdminMiddleware: typeof import('../src/middleware/gis-system-admin').gisSystemAdminMiddleware;
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
            import('../src/middleware/gis-system-admin'),
            import('../src/services/supabase.service'),
        ]).then(([middlewareModule, serviceModule]) => ({
            gisSystemAdminMiddleware: middlewareModule.gisSystemAdminMiddleware,
            supabaseService: serviceModule.supabaseService,
        }));
    }

    return runtimeModules;
}

type QueryResult = { data: unknown; error: { message: string } | null };
type QueryPlan = Partial<Record<'user_auth_links' | 'users' | 'unions' | 'sync_jobs', QueryResult>>;

function createFakeClient(plan: QueryPlan) {
    return {
        from(table: keyof QueryPlan) {
            const result = () => plan[table] ?? { data: null, error: null };
            const builder: Record<string, unknown> & PromiseLike<QueryResult> = {
                select: () => builder,
                eq: () => builder,
                in: () => builder,
                limit: () => builder,
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

async function runMiddleware(plan: QueryPlan, overrides: Partial<Request> = {}) {
    const { gisSystemAdminMiddleware, supabaseService } = await loadRuntimeModules();
    const originalGetClient = supabaseService.getClient;
    (supabaseService as unknown as { getClient: () => unknown }).getClient = () => createFakeClient(plan);
    const { response, state } = createResponse();
    let nextCalled = false;
    const request = {
        body: { unionId: ' union-a ' },
        params: {},
        user: { unionId: 'union-a', userId: 'auth-uuid' },
        ...overrides,
    } as unknown as Request;

    try {
        await gisSystemAdminMiddleware(
            request,
            response,
            (() => {
                nextCalled = true;
            }) as NextFunction
        );
        return { request, state, nextCalled };
    } finally {
        (supabaseService as unknown as { getClient: typeof originalGetClient }).getClient = originalGetClient;
    }
}

test('JWT auth UUID를 user_auth_links로 해소하고 DB의 현재 SYSTEM_ADMIN만 허용한다', async () => {
    const result = await runMiddleware({
        user_auth_links: { data: [{ user_id: 'varchar-user-id' }], error: null },
        users: { data: { id: 'varchar-user-id', role: 'SYSTEM_ADMIN', is_blocked: false }, error: null },
        unions: { data: { id: 'union-a' }, error: null },
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.request.user?.actorUserId, 'varchar-user-id');
    assert.equal(result.request.body.unionId, 'union-a');
});

test('JWT role claim과 무관하게 DB의 일반 관리자·차단 시스템관리자를 거부한다', async () => {
    for (const actor of [
        { id: 'user-1', role: 'ADMIN', is_blocked: false },
        { id: 'user-1', role: 'SYSTEM_ADMIN', is_blocked: true },
    ]) {
        const result = await runMiddleware({
            user_auth_links: { data: [{ user_id: 'user-1' }], error: null },
            users: { data: actor, error: null },
            unions: { data: { id: 'union-a' }, error: null },
        });
        assert.equal(result.nextCalled, false);
        assert.equal(result.state.status, 403);
    }
});

test('권한 조회 오류와 작업 조합 불일치는 fail-closed한다', async () => {
    const lookupFailure = await runMiddleware({
        user_auth_links: { data: null, error: { message: 'db unavailable' } },
    });
    assert.equal(lookupFailure.state.status, 503);

    const jobMismatch = await runMiddleware(
        {
            user_auth_links: { data: [{ user_id: 'user-1' }], error: null },
            users: { data: { id: 'user-1', role: 'SYSTEM_ADMIN', is_blocked: false }, error: null },
            sync_jobs: { data: { id: 'job-1', union_id: 'union-b' }, error: null },
        },
        {
            body: {},
            params: { jobId: 'job-1' },
        } as Partial<Request>
    );
    assert.equal(jobMismatch.state.status, 403);
    assert.equal(jobMismatch.nextCalled, false);
});
