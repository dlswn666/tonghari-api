import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';

Object.assign(process.env, {
    JWT_SECRET: 'test-identity-production', DEV_API_JWT_SECRET: 'test-identity-development',
    SUPABASE_URL: 'https://synthetic-production.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-production-only',
    DEV_SUPABASE_URL: 'https://synthetic-development.supabase.co', DEV_SUPABASE_SERVICE_ROLE_KEY: 'test-development-only',
    ALIGO_API_KEY: 'test-only', ALIGO_USER_ID: 'test-only', ALIGO_SENDER_PHONE: '0200000000', DEFAULT_SENDER_KEY: 'test-only',
    KG_INICIS_ENABLED: 'false', KG_INICIS_DATABASE_TARGET: '', KG_INICIS_MID: '', KG_INICIS_API_KEY: '',
    KG_INICIS_SEED_IV: '', KG_INICIS_CALLBACK_BASE_URL: '', KG_INICIS_ID_PROVIDERS: '',
});
const claims = { userId: 'actor', unionId: 'union', assemblyId: 'assembly', verificationPurpose: 'ENTRY',
    purpose: 'IDENTITY_VERIFICATION', databaseTarget: 'production', iss: 'tonghari-web', aud: 'tonghari-api' };
function signed(change: Record<string, unknown> = {}, options: jwt.SignOptions = {}): string {
    return jwt.sign({ ...claims, ...change }, 'test-identity-production', { algorithm: 'HS256', keyid: 'prod', expiresIn: 60, ...options });
}

async function createApp() {
    const { KgInicisService } = await import('../src/services/kg-inicis.service');
    const { createKgInicisRouter } = await import('../src/routes/kg-inicis');
    const { errorHandler } = await import('../src/middleware/errorHandler');
    const service = new KgInicisService({ enabled: false, databaseTarget: 'development', mid: '', apiKey: '', seedIv: '', callbackBaseUrl: '', idProviders: [] }, {
        transport: async () => { throw Error('External calls must never occur'); },
    });
    const app = express(); app.use(express.json()); app.use('/api/kg-inicis', createKgInicisRouter(service)); app.use(errorHandler);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kg-inicis`,
        close: async () => { service.destroy(); await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); } };
}

test('A2 BFF 목적/총회/권한/60초/환경 서명이 유효한 경우만 readiness를 읽는다', async () => {
    const app = await createApp();
    try {
        for (const token of [undefined, signed({ purpose: 'MEMBER_QUEUE' }), signed({ assemblyId: '' }),
            signed({ verificationPurpose: 'SIGN' }), signed({ isBlocked: true }), signed({}, { expiresIn: 300 }),
            signed({ iat: Math.floor(Date.now() / 1000) + 10 }), signed({}, { expiresIn: -1 }),
            jwt.sign({ userId: 'actor', unionId: 'union', purpose: 'IDENTITY_VERIFICATION' }, 'test-identity-production', { expiresIn: 60 }),
            signed({ databaseTarget: 'development' })]) {
            const response = await fetch(`${app.url}/auth/readiness`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
            assert.ok(response.status === 401 || response.status === 403, `unexpected status ${response.status}`);
        }
        for (const token of [signed(), jwt.sign({ ...claims, databaseTarget: 'development', iss: 'tonghari-web-dev' },
            'test-identity-development', { algorithm: 'HS256', keyid: 'dev', expiresIn: 60 })]) {
            const response = await fetch(`${app.url}/auth/readiness`, { headers: { authorization: `Bearer ${token}` } });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.deepEqual(await response.json(), { success: true, data: { enabled: false, available: false, code: 'IDENTITY_VERIFICATION_UNAVAILABLE' } });
        }
    } finally { await app.close(); }
});

test('A1 유효 scoped 요청도 비활성일 때 503이며 callback은 state 없는 성공을 인정하지 않는다', async () => {
    const app = await createApp();
    try {
        const response = await fetch(`${app.url}/auth/request`, { method: 'POST',
            headers: { authorization: `Bearer ${signed()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ reqSvcCd: '03', expectedIdentity: { name: '테스트', phone: '01000000000' } }) });
        assert.equal(response.status, 503);
        assert.equal((await response.json() as {code: string}).code, 'IDENTITY_VERIFICATION_UNAVAILABLE');
        const callback = await fetch(`${app.url}/auth/success`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ resultCode: '0000', resultMsg: 'sensitive-do-not-echo', token: 'sensitive-do-not-echo' }) });
        assert.equal(callback.status, 503);
        assert.doesNotMatch(await callback.text(), /sensitive-do-not-echo/);
    } finally { await app.close(); }
});

test('A2 목적제한 토큰은 다른 일반 API 인증 미들웨어에서 거부한다', async () => {
    const { authMiddleware, databaseTargetAuthMiddleware } = await import('../src/middleware/auth');
    for (const middleware of [authMiddleware, databaseTargetAuthMiddleware]) {
        let code = 0; let body: unknown; let nextCalled = false;
        const response = { status(value: number) { code = value; return this; }, json(value: unknown) { body = value; return this; } } as Response;
        middleware({ headers: { authorization: `Bearer ${signed()}` } } as Request, response, () => { nextCalled = true; });
        assert.equal(code, 403); assert.equal(nextCalled, false);
        assert.deepEqual(body, { success: false, error: 'Token purpose is not allowed.', code: 'TOKEN_PURPOSE_INVALID' });
    }
});

test('A5 전역 JSON 파서 오류도 callback 개인정보/token을 로그나 응답에 노출하지 않는다', async () => {
    const app = await createApp();
    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
        for (const url of [app.url, app.url.replace('/api/kg-inicis', '/API/KG-INICIS')]) {
        const response = await fetch(`${url}/auth/success?t=00000000000000000000&s=aaaaaaaaaaaaaaaaaaaaaa`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: '{"token":"sensitive-synthetic-token","userName":"테스트",BROKEN',
        });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        assert.doesNotMatch(await response.text(), /sensitive-synthetic-token|테스트|BROKEN|SyntaxError/);
        assert.deepEqual(logged, []);
        }
    } finally { console.error = originalConsoleError; await app.close(); }
});

test('A2 결과 요청은 현재 expectedIdentity를 필수로 받고 추가 제어필드를 거부한다', async () => {
    const app = await createApp();
    try {
        for (const body of [
            { mTxId: '0'.repeat(20) },
            { mTxId: '0'.repeat(20), expectedIdentity: { name: '테스트' } },
            { mTxId: '0'.repeat(20), expectedIdentity: { name: '테스트', phone: '01000000000', birthday: null } },
            { mTxId: '0'.repeat(20), expectedIdentity: { name: '테스트', phone: '01000000000', success: true } },
            { mTxId: '0'.repeat(20), expectedIdentity: { name: '테스트', phone: '01000000000' }, success: true },
        ]) {
            const response = await fetch(`${app.url}/auth/result`, { method: 'POST',
                headers: { authorization: `Bearer ${signed()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
            assert.equal(response.status, 400);
            assert.equal((await response.json() as {code: string}).code, 'INVALID_PARAMS');
        }
    } finally { await app.close(); }
});
