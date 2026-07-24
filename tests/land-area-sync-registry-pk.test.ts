import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRegistryManagementPk } from '../src/services/land-area-sync/registry-pk';

test('관리 PK: safe nonnegative integer와 digit string을 canonical string으로 정규화한다', () => {
    assert.equal(normalizeRegistryManagementPk(1234567890123), '1234567890123');
    assert.equal(normalizeRegistryManagementPk(' 001234567890123 '), '1234567890123');
    assert.equal(normalizeRegistryManagementPk('000'), '0');
});

test('관리 PK: unsafe number·음수·소수·invalid string을 fail-closed한다', () => {
    for (const value of [
        Number.MAX_SAFE_INTEGER + 1,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        '',
        ' ',
        '-1',
        '1.5',
        '1e3',
        'PK-ROOT',
        null,
        undefined,
    ]) {
        assert.equal(normalizeRegistryManagementPk(value), null, String(value));
    }
});

