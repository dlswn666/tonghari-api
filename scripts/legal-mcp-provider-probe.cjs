'use strict';

// 입력 없는 운영 진단: 고정 공개 조례 두 요청만 수행하고 원문은 메모리에서만 다룬다.
const FIXED_QUERY = '서울특별시 도시 및 주거환경정비 조례';
const FIXED_MST = '2130189';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SAFE_CODES = new Set([
    'AUTH', 'IP_NOT_REGISTERED', 'RATE_LIMITED', 'UPSTREAM_TIMEOUT',
    'UPSTREAM_UNAVAILABLE', 'RESPONSE_TOO_LARGE', 'SCHEMA_DRIFT',
    'SOURCE_MISMATCH', 'INVALID_REQUEST',
]);
const SAFE_FIELDS = new Set([
    '?xml', '#text', 'Law', 'law', '법령', '자치법규', 'ordin',
    'LawSearch', 'lawSearch', 'OrdinSearch', 'ordinSearch',
    'LawService', 'lawService', 'OrdinService', 'ordinService',
    'SearchResult', 'searchResult', 'response', 'Response', 'root', 'Root',
    'header', 'body', 'items', 'results', '목록', '자치법규목록',
    '법령정보', '자치법규정보', '기본정보', '자치법규기본정보',
    '조문', '조문단위', '조문정보', '조문목록', '조문내용', '조내용',
    '조문번호', '조문가지번호', '조문여부', '조문제목', '조제목', '조문시행일자',
    '항', '호', '목', '항번호', '호번호', '목번호', '항내용', '호내용', '목내용',
    '부칙', '부칙단위', '부칙내용', '부칙목록', '부칙공포일자', '부칙공포번호',
    '별표', '별표단위', '별표목록', '별표번호', '별표제목', '별표내용',
    'totalCnt', 'totalCount', '검색결과개수', '검색건수', 'page', '현재페이지', '출력페이지',
    '자치법규일련번호', '자치법규키', '자치법규ID', 'ID', 'MST',
    '자치법규명', '지자체기관명', '전체기관명', '자치법규종류',
    '공포일자', '공포번호', '시행일자', '제개정구분명', '제개정정보', '제개정구분',
    '자치법규상세링크', '상세링크', 'resultCode', 'returnReasonCode',
    'errMsg', 'returnAuthMsg', 'resultMsg', 'msg', 'message',
]);

function safeFailure(error) {
    const code = SAFE_CODES.has(error?.code) ? error.code : 'PROBE_ERROR';
    const locations = [];
    // 함수명·경로·오류 메시지를 복사하지 않고 알려진 parser 파일의 위치만 추출한다.
    if (typeof error?.stack === 'string') {
        for (const line of error.stack.split('\n').slice(1, 15)) {
            const match = line.match(/\/(law-open-api-parser|official-link)\.js:(\d{1,6}):(\d{1,6})\)?$/);
            if (match) locations.push({ file: `${match[1]}.js`, line: Number(match[2]), column: Number(match[3]) });
        }
    }
    return { ok: false, code, locations: locations.slice(0, 5) };
}

function summarizeShape(value) {
    let remaining = 240;
    function visit(node, depth) {
        if (--remaining < 0 || depth > 7) return { kind: 'limited' };
        if (Array.isArray(node)) {
            return { kind: 'array', count: node.length, samples: node.slice(0, 2).map((item) => visit(item, depth + 1)) };
        }
        if (node === null) return { kind: 'null' };
        if (typeof node !== 'object') return { kind: typeof node, populated: node !== '' && node !== undefined };
        const fields = [];
        let unknownFieldCount = 0;
        for (const [key, child] of Object.entries(node)) {
            if (SAFE_FIELDS.has(key)) fields.push({ field: key, shape: visit(child, depth + 1) });
            else unknownFieldCount += 1;
        }
        return { kind: 'object', fields, unknownFieldCount };
    }
    return visit(value, 0);
}

function safeMetadata(record, oc) {
    const result = {};
    const formats = {
        mst: /^\d{1,30}$/,
        ordinanceId: /^\d{1,30}$/,
        promulgationDate: /^\d{8}$/,
        effectiveDate: /^\d{8}$/,
        promulgationNo: /^\d{1,20}$/,
    };
    for (const [key, format] of Object.entries(formats)) {
        const value = record?.[key];
        if (typeof value === 'string' && format.test(value) && !value.includes(oc)) result[key] = value;
    }
    // 제목·기관 등의 임의 문자열도 재출력하지 않는다.
    result.expectedName = record?.name === FIXED_QUERY;
    result.seoulAuthority = record?.authorityName === '서울특별시';
    if (['조례', '규칙'].includes(record?.ordinanceType)) result.ordinanceType = record.ordinanceType;
    return result;
}

function summarizeParsed(parsed, kind, oc) {
    if (kind === 'search') {
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        return {
            totalCount: Number.isSafeInteger(parsed?.totalCount) ? parsed.totalCount : null,
            page: Number.isSafeInteger(parsed?.page) ? parsed.page : null,
            itemCount: items.length,
            items: items.slice(0, 20).map((item) => safeMetadata(item, oc)),
        };
    }
    return {
        ...safeMetadata(parsed, oc),
        articleCount: Array.isArray(parsed?.articles) ? parsed.articles.length : null,
        addendumCount: Array.isArray(parsed?.addenda) ? parsed.addenda.length : null,
        appendixCount: Array.isArray(parsed?.appendices) ? parsed.appendices.length : null,
    };
}

async function runProviderProbe({ oc, request, parsers, XMLParser }) {
    if (typeof oc !== 'string' || !oc.trim()) return { probe: 'seoul-ordinance', ok: false, code: 'AUTH', requests: [] };
    const credential = oc.trim();
    const signal = AbortSignal.timeout(40_000);
    const specifications = [
        { kind: 'search', path: '/lawSearch.do', params: { target: 'ordin', nw: 1, query: FIXED_QUERY, search: 1, display: 100, page: 1, org: '6110000' } },
        { kind: 'detail', path: '/lawService.do', params: { target: 'ordin', MST: FIXED_MST } },
    ];
    const results = [];
    for (const specification of specifications) {
        const result = { kind: specification.kind };
        try {
            const response = await request(`https://www.law.go.kr/DRF${specification.path}`, {
                params: { OC: credential, ...specification.params, type: 'XML' },
                timeout: 15_000,
                signal,
                responseType: 'text',
                transformResponse: [(value) => value],
                maxContentLength: MAX_RESPONSE_BYTES,
                maxBodyLength: MAX_RESPONSE_BYTES,
                maxRedirects: 0,
                headers: { 'User-Agent': 'tonghari-legal-research/1.0' },
            });
            result.httpStatus = Number.isInteger(response?.status) ? response.status : null;
            if (response?.status >= 400) {
                result.transport = { ok: false, code: 'UPSTREAM_UNAVAILABLE', locations: [] };
            } else if (typeof response?.data !== 'string') {
                result.transport = { ok: false, code: 'SCHEMA_DRIFT', locations: [] };
            } else if (Buffer.byteLength(response.data, 'utf8') > MAX_RESPONSE_BYTES) {
                result.transport = { ok: false, code: 'RESPONSE_TOO_LARGE', locations: [] };
            } else {
                result.transport = { ok: true };
                try {
                    const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: false });
                    result.shape = summarizeShape(xmlParser.parse(response.data));
                } catch {
                    result.shape = { kind: 'invalid_xml' };
                }
                try {
                    const parse = specification.kind === 'search'
                        ? parsers.parseCurrentOrdinanceSearchXml
                        : parsers.parseCurrentOrdinanceDetailXml;
                    result.parser = { ok: true, summary: summarizeParsed(parse(response.data), specification.kind, credential) };
                } catch (error) {
                    result.parser = safeFailure(error);
                }
            }
        } catch (error) {
            // axios 오류에는 인증 파라미터가 있으므로 메시지·config·cause를 읽지 않는다.
            result.transport = { ok: false, code: error?.code === 'ECONNABORTED' || error?.code === 'ERR_CANCELED' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', locations: [] };
        }
        results.push(result);
    }
    return { probe: 'seoul-ordinance', fixedMst: FIXED_MST, ok: results.every((result) => result.parser?.ok), requests: results };
}

async function main() {
    try {
        const axios = require('axios');
        const { XMLParser } = require('fast-xml-parser');
        const parsers = require('./dist/services/legal-research/law-open-api-parser');
        const report = await runProviderProbe({ oc: process.env.LAW_API_OC, request: axios.get, parsers, XMLParser });
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (!report.ok) process.exitCode = 1;
    } catch {
        process.stdout.write('{"probe":"seoul-ordinance","ok":false,"code":"PROBE_ERROR"}\n');
        process.exitCode = 1;
    }
}

module.exports = { runProviderProbe, safeFailure, summarizeShape };
if (require.main === module || module.id === '[stdin]') void main();
