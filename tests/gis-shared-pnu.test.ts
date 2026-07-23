import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPnuFromKakaoAddress } from '../src/services/gis-shared/pnu';

test('buildPnuFromKakaoAddress: 정상 지번은 19자리 PNU를 만든다', () => {
    assert.equal(
        buildPnuFromKakaoAddress({
            bcode: '1168010100',
            mainNo: '736',
            subNo: '24',
            mountainYn: 'N',
        }),
        '1168010100107360024'
    );
});

test('buildPnuFromKakaoAddress: 산지는 대지구분 2, 부번 없으면 0000', () => {
    assert.equal(
        buildPnuFromKakaoAddress({
            bcode: '4121010100',
            mainNo: '12',
            subNo: '',
            mountainYn: 'Y',
        }),
        '4121010100200120000'
    );
});

test('buildPnuFromKakaoAddress: bcode가 10자리 숫자가 아니면 null', () => {
    const base = { mainNo: '1', subNo: '', mountainYn: 'N' as const };
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '12345' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, bcode: '12345abcde' }), null);
});

test('buildPnuFromKakaoAddress: 본번이 없거나 숫자가 아니면 null', () => {
    const base = { bcode: '1168010100', subNo: '', mountainYn: 'N' as const };
    assert.equal(buildPnuFromKakaoAddress({ ...base, mainNo: '' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, mainNo: 'abc' }), null);
});

test('buildPnuFromKakaoAddress: 본번/부번이 4자리를 초과하면 null', () => {
    const base = { bcode: '1168010100', mountainYn: 'N' as const };
    assert.equal(buildPnuFromKakaoAddress({ ...base, mainNo: '12345', subNo: '' }), null);
    assert.equal(buildPnuFromKakaoAddress({ ...base, mainNo: '1', subNo: '12345' }), null);
});
