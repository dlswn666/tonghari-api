import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { IdentityVerificationContext } from '../src/types/kg-inicis.types';
import type { KgInicisConfig } from '../src/services/kg-inicis.service';

// 실제 .env/계정/외부 API를 사용하지 않는 독립 프로세스 테스트다.
Object.assign(process.env, {
    JWT_SECRET: 'test-production-secret', DEV_API_JWT_SECRET: '',
    SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only-key',
    DEV_SUPABASE_URL: '', DEV_SUPABASE_SERVICE_ROLE_KEY: '',
    ALIGO_API_KEY: 'test-only', ALIGO_USER_ID: 'test-only', ALIGO_SENDER_PHONE: '0200000000',
    DEFAULT_SENDER_KEY: 'test-only', KG_INICIS_ENABLED: 'false',
    KG_INICIS_MID: '', KG_INICIS_API_KEY: '', KG_INICIS_SEED_IV: '',
    KG_INICIS_DATABASE_TARGET: '', KG_INICIS_CALLBACK_BASE_URL: '', KG_INICIS_ID_PROVIDERS: '',
});
const config: KgInicisConfig = {
    enabled: true, databaseTarget: 'production', mid: 'TESTONLY00', apiKey: 'synthetic-only',
    seedIv: '0123456789abcdef', callbackBaseUrl: 'https://example.com/api/identity-verification/callback', idProviders: ['SMS'],
};
const owner: IdentityVerificationContext = { userId: 'actor', unionId: 'union', databaseTarget: 'production', assemblyId: 'assembly', purpose: 'ENTRY' };
const expected = { name: '테스트', phone: '01000000000', birthday: '19900101' };
const request = { reqSvcCd: '03' as const, expectedIdentity: expected };
const token = Buffer.alloc(16, 1).toString('base64');
const ci = Buffer.alloc(64, 2).toString('base64');
const syntheticCipher = {
    available: () => true,
    decrypt: (value: unknown) => {
        if (typeof value !== 'string' || !value.startsWith('synthetic:')) throw Error('bad ciphertext');
        return value.slice(10);
    },
};
const coded = (code: string) => (error: unknown) => (error as {code: string}).code === code;

async function fixture(options: { config?: Partial<KgInicisConfig>; change?: Record<string, unknown>; delay?: boolean } = {}) {
    const { KgInicisService } = await import('../src/services/kg-inicis.service');
    let now = Date.UTC(2026, 8, 13);
    let calls = 0;
    let release: (() => void) | undefined;
    const pending = options.delay ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
    let mTxId = '';
    const service = new KgInicisService({ ...config, ...options.config }, {
        now: () => now, cipher: syntheticCipher,
        transport: async (url, body) => {
            calls++;
            assert.equal(url, 'https://fcsa.inicis.com/api/result');
            assert.deepEqual(body, { mid: config.mid, txId: 'PROVIDER_TX' });
            await pending;
            return { resultCode: '0000', mTxId, txId: 'PROVIDER_TX', svcCd: '03', providerDevCd: 'SMS',
                userName: `synthetic:${expected.name}`, userPhone: `synthetic:${expected.phone}`,
                userBirthday: `synthetic:${expected.birthday}`, userCi: `synthetic:${ci}`,
                userDi: 'DO_NOT_RETURN', signedData: 'DO_NOT_RETURN', ...options.change };
        },
    });
    const start = (input = request, context = owner) => {
        const output = service.requestAuth(input, context);
        mTxId = output.mTxId;
        const url = new URL(output.formParams.successUrl);
        return { ...output, state: url.searchParams.get('s')! };
    };
    const callback = (tx: ReturnType<typeof start>, params = {}) => service.handleCallback(tx.mTxId, tx.state, 'success', {
        resultCode: '0000', authRequestUrl: 'https://fcsa.inicis.com/api/result', txId: 'PROVIDER_TX', token, ...params,
    });
    return { service, start, callback, advance: (delta: number) => { now += delta; }, calls: () => calls, release: () => release?.() };
}

test('A1 키가 있어도 기본 비활성이면 요청/결과/콜백에서 외부 호출이 없다', async () => {
    const f = await fixture({ config: { enabled: false } });
    try {
        assert.deepEqual(f.service.getReadiness('production'), { enabled: false, available: false, code: 'IDENTITY_VERIFICATION_UNAVAILABLE' });
        assert.throws(() => f.start(), coded('IDENTITY_VERIFICATION_UNAVAILABLE'));
        assert.throws(() => f.service.handleCallback('0'.repeat(20), '0'.repeat(22), 'success', {}), coded('IDENTITY_VERIFICATION_UNAVAILABLE'));
        await assert.rejects(f.service.queryResult('0'.repeat(20), owner, expected), coded('IDENTITY_VERIFICATION_UNAVAILABLE'));
        assert.equal(f.calls(), 0);
        const { parseExactTrueFeatureFlag } = await import('../src/config/feature-flags');
        for (const value of [undefined, '', 'TRUE', '1', ' true ', 'false']) assert.equal(parseExactTrueFeatureFlag(value), false);
        assert.equal(parseExactTrueFeatureFlag('true'), true);
    } finally { f.service.destroy(); }
});

test('readiness는 target/계정/콜백 128byte/계약기관/실제 SEED 지원을 모두 요구한다', async () => {
    for (const invalid of [
        { databaseTarget: '' }, { databaseTarget: 'development' }, { mid: '' }, { apiKey: '' }, { seedIv: '' },
        { callbackBaseUrl: 'http://example.com/api/identity-verification/callback' },
        { callbackBaseUrl: 'https://example.com/api/identity-verification/callback?x=1' },
        { callbackBaseUrl: 'https://a-very-long-subdomain.example.com/api/identity-verification/callback' },
        { idProviders: [] }, { idProviders: ['PASS'] }, { idProviders: ['SMS', 'SMS'] },
    ]) {
        const f = await fixture({ config: invalid });
        assert.equal(f.service.getReadiness('production').available, false);
        f.service.destroy();
    }
    const { KgInicisService } = await import('../src/services/kg-inicis.service');
    const service = new KgInicisService(config);
    assert.equal(service.getReadiness('production').available, crypto.getCiphers().includes('seed-cbc'));
    service.destroy();
});

test('공식 요청 userBirth/userHash와 고정사용자 Y/N 및 128byte 콜백 규격을 만든다', async () => {
    const f = await fixture();
    try {
        const tx = f.start();
        assert.match(tx.mTxId, /^[a-f0-9]{20}$/);
        assert.equal(tx.state.length, 22);
        assert.equal(tx.formParams.flgFixedUser, 'Y');
        assert.equal(tx.formParams.userBirth, expected.birthday);
        assert.equal(tx.formParams.userBirthday, undefined);
        assert.equal(tx.formParams.userHash, crypto.createHash('sha256').update(expected.name + config.mid + expected.phone + tx.mTxId + expected.birthday + '03').digest('hex'));
        assert.ok(Buffer.byteLength(tx.formParams.successUrl) <= 128);
        const noBirth = f.start({ reqSvcCd: '03', expectedIdentity: { name: expected.name, phone: expected.phone } } as typeof request);
        assert.equal(noBirth.formParams.flgFixedUser, 'N');
        assert.equal(noBirth.formParams.userHash, undefined);
        assert.equal(noBirth.formParams.userName, undefined);
        assert.throws(() => f.start({ ...request, reqSvcCd: '02' as '03' }), coded('INVALID_PARAMS'));
        assert.throws(() => f.start({ ...request, expectedIdentity: { ...expected, birthday: '20000230' } }), coded('INVALID_PARAMS'));
    } finally { f.service.destroy(); }
});

test('A2 사용자/조합/환경/총회/목적이 다른 상태조회 및 소비는 거부한다', async () => {
    const f = await fixture();
    try {
        const tx = f.start(); f.callback(tx);
        for (const difference of [{ userId: 'other' }, { unionId: 'other' }, { assemblyId: 'other' }, { purpose: 'VOTE' as const }]) {
            const other = { ...owner, ...difference };
            assert.throws(() => f.service.getTxStatus(tx.mTxId, other), coded('IDENTITY_VERIFICATION_NOT_FOUND'));
            await assert.rejects(f.service.queryResult(tx.mTxId, other, expected), coded('IDENTITY_VERIFICATION_NOT_FOUND'));
        }
        await assert.rejects(f.service.queryResult(tx.mTxId, { ...owner, databaseTarget: 'development' }, expected), coded('IDENTITY_VERIFICATION_UNAVAILABLE'));
        assert.equal(f.calls(), 0);
    } finally { f.service.destroy(); }
});

test('A3 결과 URL은 정확한 공식 HTTPS 호스트만 허용한다', async () => {
    const { validateKgResultUrl } = await import('../src/services/kg-inicis.service');
    for (const host of ['fcsa', 'kssa']) assert.equal(validateKgResultUrl(`https://${host}.inicis.com/api/result`), `https://${host}.inicis.com/api/result`);
    for (const bad of ['http://fcsa.inicis.com/r', 'https://fcsa.inicis.com.evil.example/r', 'https://fcsa.inicis.com:444/r',
        'https://user:pass@fcsa.inicis.com/r', 'https://fcsa.inicis.com/r#f', 'https://127.0.0.1/r', 'https://evil.example/r', 'https://fcsa.inicis.com\\@evil.example/r']) {
        assert.throws(() => validateKgResultUrl(bad), coded('IDENTITY_VERIFICATION_CALLBACK_INVALID'));
    }
});

test('A3/A4 명시적 성공코드, state, token, 콜백 단회성 및 실패 종료를 강제한다', async () => {
    for (const change of [{ resultCode: undefined }, { resultCode: '9999' }, { token: 'bad' }, { authRequestUrl: 'https://evil.example/' }, { txId: '' }]) {
        const f = await fixture();
        try {
            const tx = f.start();
            assert.throws(() => f.callback(tx, change), coded('IDENTITY_VERIFICATION_CALLBACK_INVALID'));
            assert.equal(f.service.getTxStatus(tx.mTxId, owner), 'FAILED');
            assert.throws(() => f.callback(tx), coded('IDENTITY_VERIFICATION_REPLAY'));
            await assert.rejects(f.service.queryResult(tx.mTxId, owner, expected), coded('IDENTITY_VERIFICATION_FAILED'));
            assert.equal(f.calls(), 0);
        } finally { f.service.destroy(); }
    }
    const f = await fixture();
    try {
        const tx = f.start();
        assert.throws(() => f.service.handleCallback(tx.mTxId, 'x'.repeat(22), 'success', {}), coded('IDENTITY_VERIFICATION_CALLBACK_INVALID'));
        assert.equal(f.service.getTxStatus(tx.mTxId, owner), 'REQUESTED');
        f.service.handleCallback(tx.mTxId, tx.state, 'fail', { resultCode: '0000' });
        assert.throws(() => f.callback(tx), coded('IDENTITY_VERIFICATION_REPLAY'));
        assert.equal(f.service.getTxStatus(tx.mTxId, owner), 'FAILED');
    } finally { f.service.destroy(); }
});

test('A3 결과 거래/서비스/기관/신원/암호문/CI 불일치는 모두 실패하며 원시 결과를 노출하지 않는다', async () => {
    for (const change of [{ resultCode: undefined }, { mTxId: 'other' }, { txId: 'other' }, { svcCd: '01' },
        { providerDevCd: 'PASS' }, { providerDevCd: 'TOSS' }, { userName: 'synthetic:다른이름' },
        { userPhone: 'synthetic:01099999999' }, { userBirthday: 'synthetic:20000101' },
        { userName: 'plaintext' }, { userCi: 'synthetic:invalid-ci' }]) {
        const f = await fixture({ change });
        try {
            const tx = f.start(); f.callback(tx);
            await assert.rejects(f.service.queryResult(tx.mTxId, owner, expected), coded('IDENTITY_VERIFICATION_FAILED'));
            assert.equal(f.service.getTxStatus(tx.mTxId, owner), 'FAILED');
        } finally { f.service.destroy(); }
    }
});

test('A4/A5 결과는 1회만 반환하고 인증 개인정보와 token을 반환하거나 거래 캐시에 남기지 않는다', async () => {
    const f = await fixture();
    try {
        const tx = f.start(); f.callback(tx);
        const result = await f.service.queryResult(tx.mTxId, owner, expected);
        assert.deepEqual(Object.keys(result).sort(), ['verified', 'mTxId', 'txId', 'svcCd', 'providerDevCd',
            'verifiedAt', 'assemblyId', 'purpose', 'issuedAt', 'expiresAt', 'expectedSubjectDigest',
            'verifiedSubjectDigest', 'requestPayloadDigest', 'providerEvidenceDigest', 'callbackDigest'].sort());
        assert.equal(result.verified, true);
        assert.equal(result.mTxId, tx.mTxId);
        assert.equal(result.assemblyId, owner.assemblyId);
        assert.equal(result.purpose, owner.purpose);
        assert.equal(result.issuedAt, '2026-09-13T00:00:00.000Z');
        assert.equal(result.expiresAt, tx.expiresAt);
        assert.equal(result.expectedSubjectDigest, result.verifiedSubjectDigest);
        for (const field of ['expectedSubjectDigest', 'verifiedSubjectDigest', 'requestPayloadDigest', 'providerEvidenceDigest', 'callbackDigest'] as const) {
            assert.match(result[field], /^[a-f0-9]{64}$/);
        }
        assert.doesNotMatch(JSON.stringify(result), /userCi|userDi|signedData|token|테스트|01000000000/);
        await assert.rejects(f.service.queryResult(tx.mTxId, owner, expected), coded('IDENTITY_VERIFICATION_NOT_FOUND'));
        assert.equal(f.calls(), 1);
    } finally { f.service.destroy(); }
});

test('A4 await 전 동시 소비 차단, await 후 TTL 재검증을 수행한다', async () => {
    for (const expire of [false, true]) {
        const f = await fixture({ delay: true });
        try {
            const tx = f.start(); f.callback(tx);
            const first = f.service.queryResult(tx.mTxId, owner, expected);
            await assert.rejects(f.service.queryResult(tx.mTxId, owner, expected), coded('IDENTITY_VERIFICATION_NOT_READY'));
            assert.equal(f.calls(), 1);
            if (expire) f.advance(300_000);
            f.release();
            if (expire) await assert.rejects(first, coded('IDENTITY_VERIFICATION_EXPIRED'));
            else assert.equal((await first).verified, true);
        } finally { f.service.destroy(); }
    }
});

test('A4 모든 접근 시 TTL을 적용하고 actor별 요청 저장량을 제한한다', async () => {
    const f = await fixture();
    try {
        const tx = f.start(); f.advance(300_000);
        assert.equal(f.service.getTxStatus(tx.mTxId, owner), 'EXPIRED');
        assert.throws(() => f.callback(tx), coded('IDENTITY_VERIFICATION_EXPIRED'));
        await assert.rejects(f.service.queryResult(tx.mTxId, owner, expected), coded('IDENTITY_VERIFICATION_EXPIRED'));
        for (let i = 0; i < 5; i++) f.start();
        assert.throws(() => f.start(), coded('IDENTITY_VERIFICATION_RATE_LIMITED'));
    } finally { f.service.destroy(); }
});

test('SEED 실제 구현은 RFC4269 B.1 벡터 및 KG Base64/UTF-8/PKCS padding 계약을 검증한다', () => {
    const script = `
        const assert = require('node:assert/strict');
        const crypto = require('node:crypto');
        const { decryptKgSeed } = require('./src/services/kg-inicis.service.ts');
        const key = Buffer.alloc(16), iv = Buffer.alloc(16);
        const cipher = crypto.createCipheriv('seed-cbc', key, iv); cipher.setAutoPadding(false);
        const out = Buffer.concat([cipher.update(Buffer.from('000102030405060708090a0b0c0d0e0f','hex')), cipher.final()]);
        assert.equal(out.toString('hex'), '5ebac6e0054e166819aff1cc6d346cdb');
        const encrypt = bytes => { const c = crypto.createCipheriv('seed-cbc', key, iv); return Buffer.concat([c.update(bytes),c.final()]).toString('base64'); };
        assert.equal(decryptKgSeed(encrypt(Buffer.from('테스트')),key.toString('base64'),iv.toString('utf8')), '테스트');
        assert.throws(() => decryptKgSeed(encrypt(Buffer.from([0xff])),key.toString('base64'),iv.toString('utf8')));
        assert.throws(() => decryptKgSeed('not-base64',key.toString('base64'),iv.toString('utf8')));
        assert.throws(() => decryptKgSeed(encrypt(Buffer.from('x')),'short',iv.toString('utf8')));
        assert.throws(() => decryptKgSeed(encrypt(Buffer.from('x')),key.toString('base64'),'short'));
        assert.throws(() => decryptKgSeed(Buffer.alloc(16).toString('base64'),key.toString('base64'),iv.toString('utf8')));
    `;
    const child = spawnSync(process.execPath, ['--openssl-legacy-provider', '--import', 'tsx', '-e', script], {
        cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(child.status, 0, child.stderr);
});

test('A2 요청 이후 바뀐 현재 프로필은 제공사 호출 전 거래를 실패 종료한다', async () => {
    const noBirthday = { name: expected.name, phone: expected.phone };
    const cases = [
        { initial: expected, current: { ...expected, name: '변경이름' } },
        { initial: expected, current: { ...expected, phone: '01099999999' } },
        { initial: expected, current: { ...expected, birthday: '19900202' } },
        { initial: expected, current: noBirthday },
        { initial: noBirthday, current: expected },
        { initial: expected, current: undefined },
    ];
    for (const { initial, current } of cases) {
        const f = await fixture();
        try {
            const tx = f.start({ reqSvcCd: '03', expectedIdentity: initial } as typeof request);
            f.callback(tx);
            await assert.rejects(f.service.queryResult(tx.mTxId, owner, current as typeof expected), coded('IDENTITY_VERIFICATION_SUBJECT_CHANGED'));
            assert.equal(f.service.getTxStatus(tx.mTxId, owner), 'FAILED');
            assert.equal(f.calls(), 0);
            // 되돌린 프로필이나 재전송으로 이미 실패한 거래를 살릴 수 없다.
            await assert.rejects(f.service.queryResult(tx.mTxId, owner, initial), coded('IDENTITY_VERIFICATION_FAILED'));
            assert.throws(() => f.callback(tx), coded('IDENTITY_VERIFICATION_REPLAY'));
        } finally { f.service.destroy(); }
    }
});

test('A2 동일한 현재 프로필은 생년월일 유무와 무관하게 서버 검증 영수증을 1회 발급한다', async () => {
    for (const identity of [expected, { name: expected.name, phone: expected.phone }]) {
        const f = await fixture();
        try {
            const tx = f.start({ reqSvcCd: '03', expectedIdentity: identity } as typeof request);
            f.callback(tx);
            const result = await f.service.queryResult(tx.mTxId, owner, identity);
            assert.equal(result.verified, true);
            assert.equal(result.expectedSubjectDigest, result.verifiedSubjectDigest);
            assert.equal(f.calls(), 1);
        } finally { f.service.destroy(); }
    }
});
