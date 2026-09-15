import assert from 'node:assert/strict';
import test from 'node:test';
import { LegalOpenApiError } from '../src/services/legal-research/errors';
import {
    LawOpenApiClient,
    type LegalOpenApiHttpGet,
    type LegalOpenApiHttpRequest,
} from '../src/services/legal-research/law-open-api-client';

const SECRET_OC = 'never-expose-this-oc';

function caseListXml(count: number): string {
    const cases = Array.from({ length: count }, (_, index) => {
        const id = String(9000 - index);
        return `
          <prec>
            <판례일련번호>${id}</판례일련번호>
            <사건명>정비사업 판례 ${index + 1}</사건명>
            <사건번호>2026두${id}</사건번호>
            <선고일자>202608${String(30 - index).padStart(2, '0')}</선고일자>
            <법원명>대법원</법원명>
            <판례상세링크>http://www.law.go.kr/DRF/lawService.do?OC=${SECRET_OC}&amp;target=prec&amp;ID=${id}</판례상세링크>
          </prec>`;
    }).join('');
    return `<LawSearch><totalCnt>${count}</totalCnt><page>1</page>${cases}</LawSearch>`;
}

const fixtures = {
    lawSearch: `<LawSearch><totalCnt>1</totalCnt><page>1</page><law>
      <법령일련번호>111</법령일련번호><법령ID>222</법령ID>
      <법령명한글>도시 및 주거환경정비법</법령명한글><법령구분명>법률</법령구분명>
      <시행일자>20260801</시행일자><현행연혁코드>현행</현행연혁코드>
      <법령상세링크>http://www.law.go.kr/DRF/lawService.do?OC=${SECRET_OC}&amp;target=eflaw&amp;MST=111&amp;ID=222</법령상세링크>
    </law></LawSearch>`,
    lawDetail: `<법령><기본정보><법령키>111</법령키><법령ID>222</법령ID>
      <법령명_한글>도시 및 주거환경정비법</법령명_한글><시행일자>20260801</시행일자>
    </기본정보><조문><조문단위><조문번호>1</조문번호><조문내용>목적</조문내용></조문단위></조문></법령>`,
    ordinanceSearch: `<LawSearch><totalCnt>1</totalCnt><page>1</page><law>
      <자치법규일련번호>333</자치법규일련번호><자치법규ID>444</자치법규ID>
      <자치법규명>서울특별시 도시 및 주거환경정비 조례</자치법규명><지자체기관명>서울특별시</지자체기관명>
      <시행일자>20260801</시행일자>
      <자치법규상세링크>http://www.law.go.kr/DRF/lawService.do?OC=${SECRET_OC}&amp;target=ordin&amp;MST=333&amp;ID=444</자치법규상세링크>
    </law></LawSearch>`,
    ordinanceDetail: `<자치법규><자치법규일련번호>333</자치법규일련번호><자치법규ID>444</자치법규ID>
      <자치법규명>서울특별시 도시 및 주거환경정비 조례</자치법규명><지자체기관명>서울특별시</지자체기관명>
      <조문><조문단위><조문번호>1</조문번호><조내용>목적</조내용></조문단위></조문>
    </자치법규>`,
    caseDetail: `<PrecService><판례정보일련번호>9000</판례정보일련번호><사건명>정비사업 판례</사건명>
      <사건번호>2026두9000</사건번호><선고일자>20260830</선고일자><법원명>대법원</법원명>
      <판시사항>쟁점</판시사항><판결요지>요지</판결요지><참조조문>도시정비법 제1조</참조조문><판례내용>전문</판례내용>
    </PrecService>`,
};

function createFixtureClient() {
    const calls: Array<{ path: string; request: LegalOpenApiHttpRequest }> = [];
    const httpGet: LegalOpenApiHttpGet = async (path, request) => {
        calls.push({ path, request });
        const target = request.params.target;
        if (path === '/lawSearch.do' && target === 'eflaw') return { data: fixtures.lawSearch };
        if (path === '/lawService.do' && (target === 'eflaw' || target === 'eflawjosub')) {
            return { data: fixtures.lawDetail };
        }
        if (path === '/lawSearch.do' && target === 'ordin') return { data: fixtures.ordinanceSearch };
        if (path === '/lawService.do' && target === 'ordin') return { data: fixtures.ordinanceDetail };
        if (path === '/lawSearch.do' && target === 'prec') return { data: caseListXml(12) };
        if (path === '/lawService.do' && target === 'prec') return { data: fixtures.caseDetail };
        throw new Error('unexpected fixture request');
    };
    return {
        client: new LawOpenApiClient({ oc: SECRET_OC, httpGet }),
        calls,
    };
}

test('현행 법령 provider는 eflaw/nw=3 정책을 외부 입력보다 우선한다', async () => {
    const { client, calls } = createFixtureClient();
    const result = await client.searchCurrentLaws({
        query: '도시 및 주거환경정비법',
        target: 'law',
        nw: 1,
        sort: 'ldes',
        count: 1,
        url: 'https://example.com',
    } as never);

    const params = calls[0].request.params;
    assert.equal(params.target, 'eflaw');
    assert.equal(params.nw, 3);
    assert.equal(params.display, 100);
    assert.equal('sort' in params, false);
    assert.equal(result.items[0].name, '도시 및 주거환경정비법');
    assert.equal(JSON.stringify(result).includes(SECRET_OC), false);
    assert.match(result.items[0].officialUrl ?? '', /^https:\/\/www\.law\.go\.kr\//);
});

test('현행 법령 본문과 조항호목은 target을 각각 eflaw와 eflawjosub로 고정한다', async () => {
    const { client, calls } = createFixtureClient();
    await client.getCurrentLawDetail({ lawId: '222' });
    await client.getCurrentLawProvision({
        lawId: '222',
        articleNumber: '제45조의2',
        paragraphNumber: '제1항',
        itemNumber: '제2호',
        subItemNumber: '가목',
    });

    assert.deepEqual(calls[0].request.params, {
        OC: SECRET_OC,
        target: 'eflaw',
        ID: '222',
        type: 'XML',
    });
    assert.equal(calls[1].request.params.target, 'eflawjosub');
    assert.equal(calls[1].request.params.JO, '004502');
    assert.equal(calls[1].request.params.HANG, '000100');
    assert.equal(calls[1].request.params.HO, '000200');
    assert.equal(calls[1].request.params.MOK, '가');
});

test('현행 법령 상세 응답이 MST를 생략해도 법령ID와 시행일을 보존한다', async () => {
    const detailWithoutMst = `<법령><기본정보><법령ID>222</법령ID>
      <법령명_한글>도시 및 주거환경정비법</법령명_한글><시행일자>20260801</시행일자>
    </기본정보><조문><조문단위><조문번호>1</조문번호><조문내용>목적</조문내용></조문단위></조문></법령>`;
    const httpGet: LegalOpenApiHttpGet = async () => ({ data: detailWithoutMst });
    const client = new LawOpenApiClient({ oc: SECRET_OC, httpGet });

    const result = await client.getCurrentLawDetail({ lawId: '222' });

    assert.equal(result.lawId, '222');
    assert.equal(result.mst, undefined);
    assert.equal(result.effectiveDate, '20260801');
});

test('현행 자치법규 provider는 ordin/nw=1과 정확한 org/sborg를 고정한다', async () => {
    const { client, calls } = createFixtureClient();
    const result = await client.searchCurrentOrdinances({
        query: '도시 및 주거환경정비 조례',
        org: '6110000',
        sborg: '3220000',
        target: 'law',
        nw: 2,
        count: 1,
    } as never);

    assert.equal(calls[0].request.params.target, 'ordin');
    assert.equal(calls[0].request.params.nw, 1);
    assert.equal(calls[0].request.params.org, '6110000');
    assert.equal(calls[0].request.params.sborg, '3220000');
    assert.equal(result.items[0].authorityName, '서울특별시');
    assert.equal(JSON.stringify(result).includes(SECRET_OC), false);
});

test('실측 조례 상세 구조를 읽어도 요청 MST와 ID의 불일치를 계속 거부한다', async () => {
    // 2026-09-15 운영 probe에서 확인한 구조이며 조문 내용은 합성 테스트 값이다.
    const xml = `<LawService><자치법규기본정보>
      <자치법규일련번호>2130189</자치법규일련번호><자치법규ID>2001619</자치법규ID>
      <자치법규명>서울특별시 도시 및 주거환경정비 조례</자치법규명>
      <지자체기관명>서울특별시</지자체기관명><시행일자>20260518</시행일자>
      </자치법규기본정보><조문><조><조문번호>000200</조문번호><조문여부>Y</조문여부>
      <조제목>정의</조제목><조내용>제2조(정의) 합성 조문 내용</조내용></조></조문></LawService>`;
    const client = new LawOpenApiClient({ oc: SECRET_OC, httpGet: async () => ({ data: xml }) });

    const byMst = await client.getCurrentOrdinanceDetail({ mst: '2130189' });
    const byId = await client.getCurrentOrdinanceDetail({ ordinanceId: '2001619' });
    assert.equal(byMst.ordinanceId, '2001619');
    assert.equal(byId.mst, '2130189');
    assert.equal(byMst.articles[0].articleNumber, '2');
    assert.equal(byMst.articles[0].content, '제2조(정의) 합성 조문 내용');
    assert.equal(byMst.effectiveDate, '20260518');

    for (const input of [{ mst: '9999999' }, { ordinanceId: '9999999' }]) {
        await assert.rejects(
            client.getCurrentOrdinanceDetail(input),
            (error: unknown) => error instanceof LegalOpenApiError && error.code === 'SOURCE_MISMATCH',
        );
    }
});

test('판례 provider는 prec/ddes 후보 100건을 고정하고 JO와 본문검색을 분리한다', async () => {
    const { client, calls } = createFixtureClient();
    const byLaw = await client.searchCases({
        referenceLawName: '도시 및 주거환경정비법',
        target: 'anything',
        sort: 'dasc',
        count: 100,
        display: 1,
        maxCases: 1,
    } as never);
    const byIssue = await client.searchCases({ query: '조합설립인가', searchScope: 2 });

    assert.equal(byLaw.items.length, 12);
    assert.equal(calls[0].request.params.target, 'prec');
    assert.equal(calls[0].request.params.sort, 'ddes');
    assert.equal(calls[0].request.params.display, 100);
    assert.equal(calls[0].request.params.JO, '도시 및 주거환경정비법');
    assert.equal('query' in calls[0].request.params, false);
    assert.equal(calls[1].request.params.query, '조합설립인가');
    assert.equal(calls[1].request.params.search, 2);
    assert.equal('JO' in calls[1].request.params, false);
    assert.equal(JSON.stringify(byIssue).includes(SECRET_OC), false);
});

test('판례 상세 ID가 요청과 다르면 SOURCE_MISMATCH로 닫힌다', async () => {
    const httpGet: LegalOpenApiHttpGet = async () => ({ data: fixtures.caseDetail });
    const client = new LawOpenApiClient({ oc: SECRET_OC, httpGet });
    await assert.rejects(
        client.getCaseDetail({ caseSerialId: '9999' }),
        (error: unknown) => error instanceof LegalOpenApiError && error.code === 'SOURCE_MISMATCH',
    );
});

test('판례 상세 ID의 선행 0·전각 숫자는 동일 숫자일 때만 허용한다', async (t) => {
    for (const [label, detailId] of [
        ['선행 0', '0009000'],
        ['전각 숫자', '９０００'],
    ] as const) {
        await t.test(label, async () => {
            const detailXml = fixtures.caseDetail.replace(
                '<판례정보일련번호>9000</판례정보일련번호>',
                `<판례정보일련번호>${detailId}</판례정보일련번호>`,
            );
            const client = new LawOpenApiClient({
                oc: SECRET_OC,
                httpGet: async () => ({ data: detailXml }),
            });

            const detail = await client.getCaseDetail({ caseSerialId: '9000' });

            assert.equal(detail.caseSerialId, detailId);
        });
    }
});

test('검색 목록 판례의 상세 없음 exact 응답만 별도 누락으로 분류한다', async () => {
    const listedButUnavailable = '<?xml version="1.0" encoding="utf-8"?>'
        + '<Law>일치하는 판례가 없습니다.  판례명을 확인하여 주십시오.</Law>';
    const client = new LawOpenApiClient({
        oc: SECRET_OC,
        httpGet: async () => ({ data: listedButUnavailable }),
    });

    await assert.rejects(
        client.getCaseDetail({ caseSerialId: '622797' }),
        (error: unknown) => error instanceof LegalOpenApiError
            && error.code === 'CASE_DETAIL_NOT_FOUND'
            && error.retryable === false,
    );
});

test('exact 누락 문구라도 envelope가 다르면 계속 SCHEMA_DRIFT로 닫힌다', async (t) => {
    const malformedResponses = [
        '<Law>예상하지 못한 응답입니다.</Law>',
        '<Law code="missing">일치하는 판례가 없습니다. 판례명을 확인하여 주십시오.</Law>',
        '<Law>일치하는 판례가 없습니다. 판례명을 확인하여 주십시오.</Law><Unexpected>x</Unexpected>',
        '<Law><Message>일치하는 판례가 없습니다. 판례명을 확인하여 주십시오.</Message></Law>',
        '<Law>prefix 일치하는 판례가 없습니다. 판례명을 확인하여 주십시오.</Law>',
        '<Law>일치하는 판례가 없습니다. 판례명을 확인하여 주십시오. suffix</Law>',
    ];

    for (const [index, response] of malformedResponses.entries()) {
        await t.test(`변형 ${index + 1}`, async () => {
            const client = new LawOpenApiClient({
                oc: SECRET_OC,
                httpGet: async () => ({ data: response }),
            });
            await assert.rejects(
                client.getCaseDetail({ caseSerialId: '622797' }),
                (error: unknown) => error instanceof LegalOpenApiError
                    && error.code === 'SCHEMA_DRIFT',
            );
        });
    }
});

test('호출 취소 signal을 HTTP 계층까지 전달하고 취소를 upstream partial 오류로 바꾸지 않는다', async () => {
    const controller = new AbortController();
    const abortReason = new Error('caller cancelled');
    const httpGet: LegalOpenApiHttpGet = async (_path, request) => {
        assert.equal(request.signal, controller.signal);
        controller.abort(abortReason);
        throw { code: 'ERR_CANCELED' };
    };
    const client = new LawOpenApiClient({ oc: SECRET_OC, httpGet });

    await assert.rejects(
        client.searchCurrentLaws({ query: '도시정비법' }, controller.signal),
        (error: unknown) => error === abortReason
    );
});

test('timeout, size, 인증 오류는 OC와 원시 upstream 메시지를 노출하지 않는다', async (t) => {
    await t.test('timeout', async () => {
        const httpGet: LegalOpenApiHttpGet = async () => {
            throw { code: 'ETIMEDOUT', message: `OC=${SECRET_OC}` };
        };
        const client = new LawOpenApiClient({ oc: SECRET_OC, httpGet });
        await assert.rejects(
            client.searchCurrentLaws({ query: '도시정비법' }),
            (error: unknown) => {
                assert.ok(error instanceof LegalOpenApiError);
                assert.equal(error.code, 'UPSTREAM_TIMEOUT');
                assert.equal(error.retryable, true);
                assert.equal(error.message.includes(SECRET_OC), false);
                return true;
            },
        );
    });

    await t.test('response size', async () => {
        const httpGet: LegalOpenApiHttpGet = async () => ({ data: 'x'.repeat(101) });
        const client = new LawOpenApiClient({ oc: SECRET_OC, httpGet, maxResponseBytes: 100 });
        await assert.rejects(
            client.searchCurrentLaws({ query: '도시정비법' }),
            (error: unknown) => error instanceof LegalOpenApiError && error.code === 'RESPONSE_TOO_LARGE',
        );
    });

    await t.test('missing OC', async () => {
        const previous = process.env.LAW_API_OC;
        delete process.env.LAW_API_OC;
        try {
            const client = new LawOpenApiClient({ httpGet: async () => ({ data: '' }) });
            await assert.rejects(
                client.searchCurrentLaws({ query: '도시정비법' }),
                (error: unknown) => error instanceof LegalOpenApiError && error.code === 'AUTH',
            );
        } finally {
            if (previous === undefined) delete process.env.LAW_API_OC;
            else process.env.LAW_API_OC = previous;
        }
    });
});
