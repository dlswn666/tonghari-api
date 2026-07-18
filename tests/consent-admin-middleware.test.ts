import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

type RuntimeModules = {
    consentBulkUpdateAdminMiddleware:
        typeof import('../src/middleware/consent-admin').consentBulkUpdateAdminMiddleware;
    consentBulkUploadAdminMiddleware:
        typeof import('../src/middleware/consent-admin').consentBulkUploadAdminMiddleware;
    getSupabaseService: typeof import('../src/services/supabase.service').getSupabaseService;
};

let runtimeModules: Promise<RuntimeModules> | undefined;

function loadRuntimeModules(): Promise<RuntimeModules> {
    if (!runtimeModules) {
        Object.assign(process.env, {
            JWT_SECRET: 'test-consent-jwt-secret',
            ALIGO_API_KEY: 'test-aligo-key',
            ALIGO_USER_ID: 'test-aligo-user',
            ALIGO_SENDER_PHONE: '0212345678',
            DEFAULT_SENDER_KEY: 'test-sender-key',
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
            DEV_API_JWT_SECRET: 'test-consent-dev-jwt-secret',
            DEV_SUPABASE_URL: 'https://development-example.supabase.co',
            DEV_SUPABASE_SERVICE_ROLE_KEY: 'test-development-service-role-key',
        });

        runtimeModules = Promise.all([
            import('../src/middleware/consent-admin'),
            import('../src/services/supabase.service'),
        ]).then(([middlewareModule, serviceModule]) => ({
            consentBulkUpdateAdminMiddleware:
                middlewareModule.consentBulkUpdateAdminMiddleware,
            consentBulkUploadAdminMiddleware:
                middlewareModule.consentBulkUploadAdminMiddleware,
            getSupabaseService: serviceModule.getSupabaseService,
        }));
    }

    return runtimeModules;
}

type TableName =
    | 'user_auth_links'
    | 'users'
    | 'unions'
    | 'consent_stages'
    | 'sync_jobs';

type QueryTrace = {
    table: TableName;
    columns: string;
    eq: Array<[string, unknown]>;
    in: Array<[string, unknown[]]>;
};

type FakePlan = {
    rows?: Partial<Record<TableName, Array<Record<string, unknown>>>>;
    errors?: Partial<Record<string, { message: string }>>;
};

type QueryResult = {
    data: unknown;
    error: { message: string } | null;
};

function createFakeClient(plan: FakePlan) {
    const traces: QueryTrace[] = [];

    function from(table: TableName) {
        let columns = '';
        const equalityFilters: Array<[string, unknown]> = [];
        const membershipFilters: Array<[string, unknown[]]> = [];

        const evaluate = (single: boolean): QueryResult => {
            const trace = {
                table,
                columns,
                eq: [...equalityFilters],
                in: [...membershipFilters],
            };
            traces.push(trace);

            const error = plan.errors?.[`${table}:${columns}`] ?? plan.errors?.[table];
            if (error) return { data: null, error };

            const rows = (plan.rows?.[table] ?? []).filter((row) =>
                equalityFilters.every(([column, value]) => row[column] === value) &&
                membershipFilters.every(([column, values]) => values.includes(row[column]))
            );

            if (!single) return { data: rows, error: null };
            if (rows.length > 1) {
                return { data: null, error: { message: 'multiple rows returned' } };
            }
            return { data: rows[0] ?? null, error: null };
        };

        const builder: Record<string, unknown> & PromiseLike<QueryResult> = {
            select(value: string) {
                columns = value;
                return builder;
            },
            eq(column: string, value: unknown) {
                equalityFilters.push([column, value]);
                return builder;
            },
            in(column: string, values: unknown[]) {
                membershipFilters.push([column, values]);
                return builder;
            },
            maybeSingle: async () => evaluate(true),
            then(resolve, reject) {
                return Promise.resolve(evaluate(false)).then(resolve, reject);
            },
        };

        return builder;
    }

    return { client: { from }, traces };
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

function consentUser(overrides: Record<string, unknown> = {}) {
    return {
        unionId: 'union-a',
        userId: 'auth-uuid',
        actorUserId: 'admin-a',
        purpose: 'CONSENT_QUEUE' as const,
        operation: 'CONSENT_BULK_UPDATE' as const,
        issuer: 'tonghari-web',
        audience: 'tonghari-api',
        databaseTarget: 'production' as const,
        legacyProductionToken: false,
        ...overrides,
    };
}

function validRows(actor: Record<string, unknown> = {
    id: 'admin-a',
    role: 'ADMIN',
    is_blocked: false,
    union_id: 'union-a',
}): NonNullable<FakePlan['rows']> {
    return {
        user_auth_links: [{ auth_user_id: 'auth-uuid', user_id: actor.id }],
        users: [
            actor,
            { id: 'member-a', role: 'USER', is_blocked: false, union_id: 'union-a' },
            { id: 'member-b', role: 'USER', is_blocked: false, union_id: 'union-b' },
        ],
        unions: [{
            id: 'union-a',
            union_project_profiles: {
                project_type_code: 'REDEVELOPMENT',
                implementation_method: 'UNION_DIRECT',
            },
        }],
        consent_stages: [{
            id: 'stage-a',
            project_type_code: 'REDEVELOPMENT',
            implementation_method_code: 'UNION_DIRECT',
        }],
        sync_jobs: [{
            id: 'job-a',
            union_id: 'union-a',
            job_type: 'CONSENT_UPLOAD',
            status: 'PROCESSING',
        }],
    };
}

async function runMiddleware(
    plan: FakePlan = { rows: validRows() },
    overrides: Partial<Request> = {},
    mode: 'update' | 'upload' = 'update',
    otherTargetPlan: FakePlan = {
        errors: { user_auth_links: { message: 'wrong target client selected' } },
    }
) {
    const {
        consentBulkUpdateAdminMiddleware,
        consentBulkUploadAdminMiddleware,
        getSupabaseService,
    } = await loadRuntimeModules();

    const { response, state } = createResponse();
    let nextCalled = false;
    const request = {
        body: {
            jobId: ' job-a ',
            unionId: ' union-a ',
            stageId: ' stage-a ',
            memberIds: ['member-a'],
        },
        user: consentUser({
            operation: mode === 'update'
                ? 'CONSENT_BULK_UPDATE'
                : 'CONSENT_BULK_UPLOAD',
        }),
        ...overrides,
    } as unknown as Request;
    const databaseTarget = request.user?.databaseTarget ?? 'production';
    const selectedFake = createFakeClient(plan);
    const otherFake = createFakeClient(otherTargetPlan);
    const productionService = getSupabaseService('production');
    const developmentService = getSupabaseService('development');
    const originalProductionGetClient = productionService.getClient;
    const originalDevelopmentGetClient = developmentService.getClient;
    (productionService as unknown as { getClient: () => unknown }).getClient = () =>
        databaseTarget === 'production' ? selectedFake.client : otherFake.client;
    (developmentService as unknown as { getClient: () => unknown }).getClient = () =>
        databaseTarget === 'development' ? selectedFake.client : otherFake.client;

    try {
        const middleware = mode === 'update'
            ? consentBulkUpdateAdminMiddleware
            : consentBulkUploadAdminMiddleware;
        await middleware(
            request,
            response,
            (() => { nextCalled = true; }) as NextFunction
        );
        return {
            request,
            state,
            nextCalled,
            traces: selectedFake.traces,
            otherTargetTraces: otherFake.traces,
        };
    } finally {
        (productionService as unknown as { getClient: typeof originalProductionGetClient }).getClient =
            originalProductionGetClient;
        (developmentService as unknown as { getClient: typeof originalDevelopmentGetClient }).getClient =
            originalDevelopmentGetClient;
    }
}

test('무인증 요청과 legacy 토큰을 consent queue에서 거부한다', async () => {
    const unauthenticated = await runMiddleware({}, { user: undefined });
    assert.equal(unauthenticated.state.status, 401);
    assert.equal(unauthenticated.nextCalled, false);
    assert.equal(unauthenticated.traces.length, 0);

    const legacy = await runMiddleware({}, {
        user: consentUser({ legacyProductionToken: true }),
    });
    assert.equal(legacy.state.status, 403);
    assert.equal((legacy.state.body as { code: string }).code, 'LEGACY_TOKEN_NOT_SUPPORTED');
    assert.equal(legacy.traces.length, 0);

});

test('development consent 토큰은 개발 client에서만 현재 권한과 sync_job을 검증한다', async () => {
    const development = await runMiddleware({ rows: validRows() }, {
        user: consentUser({
            databaseTarget: 'development',
            issuer: 'tonghari-web-dev',
        }),
    });

    assert.equal(development.nextCalled, true);
    assert.equal(development.state.status, 200);
    assert.ok(development.traces.length > 0);
    assert.equal(development.otherTargetTraces.length, 0);
});

test('development 요청은 운영에만 같은 UUID sync_job이 있어도 wrong-target not-found다', async () => {
    const developmentRows = validRows();
    developmentRows.sync_jobs = [];
    const result = await runMiddleware(
        { rows: developmentRows },
        {
            user: consentUser({
                databaseTarget: 'development',
                issuer: 'tonghari-web-dev',
            }),
        },
        'update',
        { rows: validRows() }
    );

    assert.equal(result.state.status, 404);
    assert.equal((result.state.body as { code: string }).code, 'JOB_NOT_FOUND');
    assert.equal(result.nextCalled, false);
    assert.equal(result.otherTargetTraces.length, 0);
    assert.deepEqual(
        result.traces.find((trace) => trace.table === 'sync_jobs')?.eq,
        [
            ['id', 'job-a'],
            ['union_id', 'union-a'],
            ['job_type', 'CONSENT_UPLOAD'],
            ['status', 'PROCESSING'],
        ]
    );
});

test('purpose/operation 또는 토큰 union이 요청 범위와 다르면 DB 조회 전에 거부한다', async () => {
    for (const user of [
        consentUser({ purpose: 'MEMBER_QUEUE' }),
        consentUser({ operation: 'CONSENT_BULK_UPLOAD' }),
        consentUser({ unionId: 'union-b' }),
    ]) {
        const result = await runMiddleware({}, { user });
        assert.equal(result.state.status, 403);
        assert.equal(result.nextCalled, false);
        assert.equal(result.traces.length, 0);
    }
});

test('auth UUID와 actor profile 링크가 정확하고 현재 미차단 ADMIN/SYSTEM_ADMIN일 때만 허용한다', async () => {
    const admin = await runMiddleware();
    assert.equal(admin.nextCalled, true);
    assert.equal(admin.request.user?.actorUserId, 'admin-a');

    const systemActor = {
        id: 'system-a',
        role: 'SYSTEM_ADMIN',
        is_blocked: false,
        union_id: null,
    };
    const systemAdmin = await runMiddleware({
        rows: validRows(systemActor),
    }, {
        user: consentUser({ actorUserId: 'system-a' }),
    });
    assert.equal(systemAdmin.nextCalled, true);

    const wrongAuthUuid = await runMiddleware({ rows: validRows() }, {
        user: consentUser({ userId: 'other-auth-uuid' }),
    });
    assert.equal(wrongAuthUuid.state.status, 403);
    assert.equal(
        (wrongAuthUuid.state.body as { code: string }).code,
        'ACTOR_ID_MISMATCH'
    );

    const forgedActor = await runMiddleware({ rows: validRows() }, {
        user: consentUser({ actorUserId: 'attacker-admin' }),
    });
    assert.equal(forgedActor.state.status, 403);
    assert.equal(
        (forgedActor.state.body as { code: string }).code,
        'ACTOR_ID_MISMATCH'
    );

    for (const actor of [
        { id: 'admin-a', role: 'ADMIN', is_blocked: false, union_id: 'union-b' },
        { id: 'admin-a', role: 'ADMIN', is_blocked: true, union_id: 'union-a' },
        { id: 'admin-a', role: 'USER', is_blocked: false, union_id: 'union-a' },
    ]) {
        const denied = await runMiddleware({ rows: validRows(actor) });
        assert.equal(denied.state.status, 403);
        assert.equal(denied.nextCalled, false);
    }
});

test('job은 요청한 union의 CONSENT_UPLOAD 원장과 정확히 일치해야 한다', async () => {
    for (const job of [
        { id: 'job-a', union_id: 'union-b', job_type: 'CONSENT_UPLOAD', status: 'PROCESSING' },
        { id: 'job-a', union_id: 'union-a', job_type: 'GIS_UPLOAD' },
        { id: 'other-job', union_id: 'union-a', job_type: 'CONSENT_UPLOAD', status: 'PROCESSING' },
        { id: 'job-a', union_id: 'union-a', job_type: 'CONSENT_UPLOAD', status: 'COMPLETED' },
    ]) {
        const rows = validRows();
        rows.sync_jobs = [job];
        const result = await runMiddleware({ rows });
        assert.equal(result.state.status, 404);
        assert.equal((result.state.body as { code: string }).code, 'JOB_NOT_FOUND');
        assert.equal(result.nextCalled, false);

        const jobTrace = result.traces.find((trace) => trace.table === 'sync_jobs');
        assert.deepEqual(jobTrace?.eq, [
            ['id', 'job-a'],
            ['union_id', 'union-a'],
            ['job_type', 'CONSENT_UPLOAD'],
            ['status', 'PROCESSING'],
        ]);
    }
});

test('bulk-update memberIds는 모두 요청 union의 사용자여야 한다', async () => {
    const denied = await runMiddleware({ rows: validRows() }, {
        body: {
            jobId: 'job-a',
            unionId: 'union-a',
            stageId: 'stage-a',
            memberIds: ['member-a', 'member-b'],
        },
    });
    assert.equal(denied.state.status, 403);
    assert.equal(
        (denied.state.body as { code: string }).code,
        'MEMBER_SCOPE_MISMATCH'
    );
    assert.equal(denied.nextCalled, false);

    const memberTrace = denied.traces.find((trace) =>
        trace.table === 'users' && trace.columns === 'id'
    );
    assert.deepEqual(memberTrace?.eq, [['union_id', 'union-a']]);
    assert.deepEqual(memberTrace?.in, [['id', ['member-a', 'member-b']]]);
});

test('전역 consent stage는 조합 profile의 사업유형과 시행방식이 모두 일치해야 한다', async () => {
    const rows = validRows();
    rows.consent_stages = [{
        id: 'stage-a',
        project_type_code: 'RECONSTRUCTION',
        implementation_method_code: 'UNION_DIRECT',
    }];
    const result = await runMiddleware({ rows });

    assert.equal(result.state.status, 404);
    assert.equal(
        (result.state.body as { code: string }).code,
        'CONSENT_STAGE_NOT_FOUND'
    );
    assert.equal(result.nextCalled, false);

    const unionTrace = result.traces.find((trace) => trace.table === 'unions');
    assert.match(unionTrace?.columns ?? '', /union_project_profiles/);
    const stageTrace = result.traces.find((trace) => trace.table === 'consent_stages');
    assert.deepEqual(stageTrace?.eq, [
        ['id', 'stage-a'],
        ['project_type_code', 'REDEVELOPMENT'],
        ['implementation_method_code', 'UNION_DIRECT'],
    ]);

    const missingProfileRows = validRows();
    missingProfileRows.unions = [{ id: 'union-a', union_project_profiles: null }];
    const missingProfile = await runMiddleware({ rows: missingProfileRows });
    assert.equal(missingProfile.state.status, 409);
    assert.equal(
        (missingProfile.state.body as { code: string }).code,
        'UNION_PROJECT_PROFILE_REQUIRED'
    );
    assert.equal(missingProfile.nextCalled, false);
});

test('권한/범위 DB 조회 오류는 fail-closed한다', async () => {
    for (const [errorKey, expectedCode] of [
        ['user_auth_links', 'AUTHORIZATION_LOOKUP_FAILED'],
        ['users:id, role, is_blocked, union_id', 'AUTHORIZATION_LOOKUP_FAILED'],
        ['unions', 'UNION_SCOPE_LOOKUP_FAILED'],
        ['consent_stages', 'CONSENT_STAGE_LOOKUP_FAILED'],
        ['sync_jobs', 'JOB_SCOPE_LOOKUP_FAILED'],
        ['users:id', 'MEMBER_SCOPE_LOOKUP_FAILED'],
    ] as const) {
        const result = await runMiddleware({
            rows: validRows(),
            errors: { [errorKey]: { message: 'db unavailable' } },
        });
        assert.equal(result.state.status, 503, errorKey);
        assert.equal((result.state.body as { code: string }).code, expectedCode, errorKey);
        assert.equal(result.nextCalled, false, errorKey);
    }
});

test('정확한 upload/update 범위는 next로 넘기고 union+profile 조회를 한 쿼리로 유지한다', async () => {
    const upload = await runMiddleware(
        { rows: validRows() },
        { body: { jobId: ' job-a ', unionId: ' union-a ', stageId: ' stage-a ' } },
        'upload'
    );
    assert.equal(upload.nextCalled, true);
    assert.deepEqual(upload.request.body, {
        jobId: 'job-a',
        unionId: 'union-a',
        stageId: 'stage-a',
    });
    assert.equal(upload.traces.length, 5);
    assert.equal(upload.traces.filter((trace) => trace.table === 'unions').length, 1);
    assert.match(
        upload.traces.find((trace) => trace.table === 'unions')?.columns ?? '',
        /union_project_profiles/
    );

    const update = await runMiddleware();
    assert.equal(update.nextCalled, true);
    assert.equal(update.traces.length, 6);
});
