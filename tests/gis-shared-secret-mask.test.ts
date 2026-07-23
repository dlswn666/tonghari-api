import assert from 'node:assert/strict';
import test from 'node:test';
import { maskSecretParams } from '../src/services/gis-shared/secret-mask';

test('maskSecretParams: key/serviceKey만 마스킹하고 나머지는 유지', () => {
    assert.deepEqual(
        maskSecretParams({ pnu: '123', key: 'secret', serviceKey: 'secret2', format: 'json' }),
        { pnu: '123', key: '***', serviceKey: '***', format: 'json' }
    );
});

test('maskSecretParams: 대소문자와 무관하게 key 계열 파라미터를 마스킹한다', () => {
    assert.deepEqual(
        maskSecretParams({ Key: 'secret', SERVICEKEY: 'secret2' }),
        { Key: '***', SERVICEKEY: '***' }
    );
});

test('maskSecretParams: 빈 객체는 빈 객체를 반환한다', () => {
    assert.deepEqual(maskSecretParams({}), {});
});

test('maskSecretParams: 원본 객체를 변경하지 않는다', () => {
    const original = { key: 'secret', pnu: '123' };
    const masked = maskSecretParams(original);
    assert.equal(original.key, 'secret');
    assert.notEqual(masked, original);
});
