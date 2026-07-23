import assert from 'node:assert/strict';
import test from 'node:test';
import { GIS_SHARED_ENDPOINTS } from '../src/services/gis-shared/endpoints';

test('GIS_SHARED_ENDPOINTS: Building HUB 4종은 모두 HTTPS + 동일 base URL', () => {
    const base = 'https://apis.data.go.kr/1613000/BldRgstHubService';
    assert.equal(GIS_SHARED_ENDPOINTS.getBrTitleInfo, `${base}/getBrTitleInfo`);
    assert.equal(GIS_SHARED_ENDPOINTS.getBrAtchJibunInfo, `${base}/getBrAtchJibunInfo`);
    assert.equal(GIS_SHARED_ENDPOINTS.getBrExposInfo, `${base}/getBrExposInfo`);
    assert.equal(GIS_SHARED_ENDPOINTS.getBrBasisOulnInfo, `${base}/getBrBasisOulnInfo`);
});

test('GIS_SHARED_ENDPOINTS: V-World NED 2종은 모두 HTTPS + 동일 base URL', () => {
    const base = 'https://api.vworld.kr/ned/data';
    assert.equal(GIS_SHARED_ENDPOINTS.ladfrlList, `${base}/ladfrlList`);
    assert.equal(GIS_SHARED_ENDPOINTS.ldaregList, `${base}/ldaregList`);
});

test('GIS_SHARED_ENDPOINTS: 정의된 모든 URL은 http:// 가 아닌 https:// 로 시작한다', () => {
    for (const [key, url] of Object.entries(GIS_SHARED_ENDPOINTS)) {
        assert.ok(url.startsWith('https://'), `${key} must be https, got: ${url}`);
    }
});
