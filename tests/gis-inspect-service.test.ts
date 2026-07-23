import assert from 'node:assert/strict';
import test from 'node:test';

// gis-inspect.service는 env를 로드하므로 import 전에 필수 env 스텁
Object.assign(process.env, {
    JWT_SECRET: 'test-jwt-secret',
    ALIGO_API_KEY: 'test-aligo-key',
    ALIGO_USER_ID: 'test-aligo-user',
    ALIGO_SENDER_PHONE: '0212345678',
    DEFAULT_SENDER_KEY: 'test-sender-key',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    VWORLD_API_KEY: 'test-vworld-key',
    VWORLD_API_DOMAIN: 'test.example.com',
    DATA_PORTAL_API_KEY: 'test-data-portal-key',
    VWORLD_ATTR_REQUEST_INTERVAL_MS: '0',
});

const serviceModule = import('../src/services/gis-inspect.service');

test('buildPnuFromKakaoAddress: 정상 지번은 19자리 PNU를 만든다', async () => {
    const { buildPnuFromKakaoAddress } = await serviceModule;
    assert.equal(
        buildPnuFromKakaoAddress({
            roadAddress: '서울 강남구 테헤란로 1',
            jibunAddress: '서울 강남구 역삼동 736-24',
            bcode: '1168010100',
            mainNo: '736',
            subNo: '24',
            mountainYn: 'N',
        }),
        '1168010100107360024'
    );
});

test('buildPnuFromKakaoAddress: 산지는 대지구분 2, 부번 없으면 0000', async () => {
    const { buildPnuFromKakaoAddress } = await serviceModule;
    assert.equal(
        buildPnuFromKakaoAddress({
            roadAddress: '',
            jibunAddress: '경기 광명시 광명동 산 12',
            bcode: '4121010100',
            mainNo: '12',
            subNo: '',
            mountainYn: 'Y',
        }),
        '4121010100200120000'
    );
});

test('buildPnuFromKakaoAddress: bcode가 10자리 숫자가 아니면 null', async () => {
    const { buildPnuFromKakaoAddress } = await serviceModule;
    const base = { roadAddress: '', jibunAddress: '', mainNo: '1', subNo: '', mountainYn: 'N' as const };
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '12345' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '12345abcde' }), null);
});

test('buildPnuFromKakaoAddress: 본번이 없거나 숫자가 아니면 null', async () => {
    const { buildPnuFromKakaoAddress } = await serviceModule;
    const base = { roadAddress: '', jibunAddress: '', bcode: '1168010100', subNo: '', mountainYn: 'N' as const };
    assert.equal(buildPnuFromKakaoAddress({ ...base, mainNo: '' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, mainNo: 'abc' }), null);
});

test('maskSecretParams: key/serviceKey만 마스킹하고 나머지는 유지', async () => {
    const { maskSecretParams } = await serviceModule;
    assert.deepEqual(
        maskSecretParams({ pnu: '123', key: 'secret', serviceKey: 'secret2', format: 'json' }),
        { pnu: '123', key: '***', serviceKey: '***', format: 'json' }
    );
});
