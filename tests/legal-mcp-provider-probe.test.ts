import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import * as parsers from '../src/services/legal-research/law-open-api-parser';

const require = createRequire(import.meta.url);
const { runProviderProbe, safeFailure } = require('../scripts/legal-mcp-provider-probe.cjs');
const script = readFileSync(join(process.cwd(), 'scripts/legal-mcp-provider-probe.cjs'), 'utf8');
const workflow = readFileSync(join(process.cwd(), '.github/workflows/legal-mcp-provider-probe.yml'), 'utf8');
const oc = 'PRIVATE_OC_NEVER_OUTPUT';
const query = '서울특별시 도시 및 주거환경정비 조례';
const listXml = `<LawSearch><totalCnt>1</totalCnt><page>1</page><law>
  <자치법규일련번호>2130189</자치법규일련번호><자치법규ID>1234</자치법규ID>
  <자치법규명>${query}</자치법규명><지자체기관명>서울특별시</지자체기관명>
  <시행일자>20260518</시행일자><공포번호>10117</공포번호>
</law></LawSearch>`;
const detailXml = `<자치법규><기본정보>
  <자치법규일련번호>2130189</자치법규일련번호><자치법규ID>1234</자치법규ID>
  <자치법규명>${query}</자치법규명><지자체기관명>서울특별시</지자체기관명>
  <시행일자>20260518</시행일자><공포번호>10117</공포번호></기본정보>
  <조문><조문단위><조문번호>2</조문번호><조문제목>정의</조문제목>
  <조문내용>PRIVATE_RAW_ARTICLE ${oc}</조문내용></조문단위></조문>
</자치법규>`;

test('운영 parser로 고정 조례 검색·상세를 각각 한 번 호출하고 공개 요약만 반환한다', async () => {
    const calls: Array<{ url: string; options: Record<string, any> }> = [];
    const report = await runProviderProbe({
        oc,
        XMLParser,
        parsers,
        request: async (url: string, options: Record<string, any>) => {
            calls.push({ url, options });
            return { status: 200, data: calls.length === 1 ? listXml : detailXml };
        },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://www.law.go.kr/DRF/lawSearch.do');
    assert.deepEqual(calls[0].options.params, {
        OC: oc, target: 'ordin', nw: 1, query, search: 1, display: 100, page: 1, org: '6110000', type: 'XML',
    });
    assert.equal(calls[1].url, 'https://www.law.go.kr/DRF/lawService.do');
    assert.deepEqual(calls[1].options.params, { OC: oc, target: 'ordin', MST: '2130189', type: 'XML' });
    assert.equal(calls[0].options.maxRedirects, 0);
    assert.equal(calls[0].options.timeout, 15_000);
    assert.equal(calls[0].options.signal, calls[1].options.signal);
    assert.equal(report.ok, true);
    assert.equal(report.requests[0].parser.summary.itemCount, 1);
    assert.equal(report.requests[1].parser.summary.articleCount, 1);
    assert.equal(report.requests[1].parser.summary.mst, '2130189');
    assert.equal(report.requests[1].parser.summary.expectedName, true);
    const printed = JSON.stringify(report);
    assert.ok(printed.includes('기본정보'));
    assert.ok(printed.includes('조문단위'));
    assert.ok(!printed.includes(oc));
    assert.ok(!printed.includes('PRIVATE_RAW_ARTICLE'));
    assert.ok(!printed.includes('https://'));
});

test('검색 parser가 실패해도 상세는 한 번 조회하고 XML의 허용된 필드 존재를 보존한다', async () => {
    let count = 0;
    const report = await runProviderProbe({
        oc, XMLParser, parsers,
        request: async () => ({ status: 200, data: ++count === 1 ? listXml.replace('<자치법규ID>1234</자치법규ID>', '') : detailXml }),
    });
    assert.equal(count, 2);
    assert.equal(report.ok, false);
    assert.equal(report.requests[0].parser.code, 'SCHEMA_DRIFT');
    assert.equal(report.requests[1].parser.ok, true);
    assert.ok(JSON.stringify(report.requests[0].shape).includes('자치법규일련번호'));
    assert.ok(!JSON.stringify(report.requests[0].shape).includes('자치법규ID'));
});

test('임의 태그·속성·본문·provider 오류를 출력하지 않는다', async () => {
    const xml = `<LawSearch><totalCnt>1</totalCnt><page>1</page>
      <${oc}>hidden</${oc}><body arbitrary="${oc}"><message>PRIVATE_MESSAGE ${oc}</message></body>
      <law><자치법규명>PRIVATE_TITLE ${oc}</자치법규명><자치법규ID>${oc}</자치법규ID></law>
    </LawSearch>`;
    const report = await runProviderProbe({ oc, XMLParser, parsers, request: async () => ({ status: 200, data: xml }) });
    const printed = JSON.stringify(report);
    assert.ok(printed.includes('unknownFieldCount'));
    assert.ok(printed.includes('message'));
    for (const forbidden of [oc, 'PRIVATE_MESSAGE', 'PRIVATE_TITLE', 'arbitrary', 'hidden']) {
        assert.ok(!printed.includes(forbidden), forbidden);
    }
});

test('오류 stack은 허용된 parser 파일의 숫자 위치만 반환한다', () => {
    const failure = safeFailure({
        code: 'SCHEMA_DRIFT', message: oc, cause: { config: { OC: oc } },
        stack: `Error: ${oc}\n at ${oc} (/app/dist/services/legal-research/law-open-api-parser.js:423:19)\n at unsafe (/app/${oc}.js:1:2)\n at link (/app/dist/services/legal-research/official-link.js:81:3)`,
    });
    assert.deepEqual(failure, {
        ok: false,
        code: 'SCHEMA_DRIFT',
        locations: [
            { file: 'law-open-api-parser.js', line: 423, column: 19 },
            { file: 'official-link.js', line: 81, column: 3 },
        ],
    });
    assert.deepEqual(safeFailure({ code: oc, stack: oc }), { ok: false, code: 'PROBE_ERROR', locations: [] });
});

test('axios 오류의 URL·config·cause는 감추며 재시도하지 않는다', async () => {
    let count = 0;
    const report = await runProviderProbe({
        oc, XMLParser, parsers,
        request: async () => {
            count += 1;
            throw { code: 'ECONNABORTED', message: oc, config: { url: `https://law.go.kr/?OC=${oc}` }, cause: oc };
        },
    });
    assert.equal(count, 2);
    assert.equal(report.ok, false);
    assert.ok(report.requests.every((result: any) => result.transport.code === 'UPSTREAM_TIMEOUT'));
    assert.ok(!JSON.stringify(report).includes(oc));
    assert.ok(!JSON.stringify(report).includes('https://'));
});

test('인증값이 없으면 외부 요청 없이 고정 AUTH 오류만 반환한다', async () => {
    let count = 0;
    const report = await runProviderProbe({ oc: '', XMLParser, parsers, request: async () => { count += 1; } });
    assert.equal(count, 0);
    assert.deepEqual(report, { probe: 'seoul-ordinance', ok: false, code: 'AUTH', requests: [] });
});

test('큰 응답·객체 응답·HTTP 실패는 원문을 파싱하거나 출력하지 않는다', async () => {
    for (const response of [
        { status: 200, data: 'x'.repeat(8 * 1024 * 1024 + 1) },
        { status: 200, data: { token: oc } },
        { status: 403, data: oc },
    ]) {
        let parsed = 0;
        const report = await runProviderProbe({
            oc, XMLParser,
            parsers: { parseCurrentOrdinanceSearchXml: () => { parsed += 1; }, parseCurrentOrdinanceDetailXml: () => { parsed += 1; } },
            request: async () => response,
        });
        assert.equal(parsed, 0);
        assert.equal(report.ok, false);
        assert.ok(!JSON.stringify(report).includes(oc));
    }
});

test('workflow는 main 전용 무입력 dispatch와 기존 지문 인증을 유지한다', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:\n/m);
    assert.doesNotMatch(workflow, /inputs:|pull_request:|push:|schedule:/);
    assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /refs\/heads\/main is required/);
    assert.match(workflow, /timeout-minutes: 3/);
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.match(workflow, /StrictHostKeyChecking=yes/);
    assert.match(workflow, /fingerprint.*EC2_SSH_FINGERPRINT/);
    assert.match(workflow, /persist-credentials: false/);
    assert.doesNotMatch(workflow, /set -x|printenv|scp |docker (?:run|cp|restart|stop|rm)|--env|\.env/);
});

test('원격 실행은 기존 production lock을 읽기로 잠그고 stdin만 컨테이너로 전달한다', () => {
    assert.match(workflow, /\.tonghari-api-production\.lock/);
    assert.match(workflow, /-f "\$\{lock_path\}" && ! -L/);
    assert.match(workflow, /stat -c '%u:%a'/);
    assert.match(workflow, /exec 9<"\$\{lock_path\}"/);
    assert.match(workflow, /flock -s -w 15 9/);
    assert.match(workflow, /stat -Lc '%d:%i'/);
    assert.match(workflow, /docker exec -i --workdir \/app alimtalk-proxy node -/);
    assert.match(workflow, /< scripts\/legal-mcp-provider-probe\.cjs/);
    assert.doesNotMatch(workflow, /9>>|9>|registry|\.Config\.Env/);
    assert.deepEqual([...script.matchAll(/process\.env\.([A-Z_]+)/g)].map((match) => match[1]), ['LAW_API_OC']);
    assert.match(script, /require\('\.\/dist\/services\/legal-research\/law-open-api-parser'\)/);
    assert.match(script, /module.id === '\[stdin\]'/);
});

test('runner·원격 shell과 stdin Node 프로그램의 구문이 유효하다', () => {
    const marker = '        run: |\n';
    const embedded = workflow.slice(workflow.indexOf(marker) + marker.length).replace(/^ {10}/gm, '');
    const shell = spawnSync('bash', ['-n'], { input: embedded, encoding: 'utf8' });
    assert.equal(shell.status, 0, shell.stderr);
    const remote = embedded.match(/remote_script="\$\(cat <<'REMOTE'\n([\s\S]+?)\nREMOTE\n/)?.[1];
    assert.ok(remote);
    const remoteShell = spawnSync('bash', ['-n'], { input: remote, encoding: 'utf8' });
    assert.equal(remoteShell.status, 0, remoteShell.stderr);
    const node = spawnSync(process.execPath, ['--check'], { input: script, encoding: 'utf8' });
    assert.equal(node.status, 0, node.stderr);
});
