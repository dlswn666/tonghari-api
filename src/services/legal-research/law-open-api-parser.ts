import { XMLParser } from 'fast-xml-parser';
import { LegalOpenApiError } from './errors';
import { sanitizeOptionalOfficialLawLink } from './official-link';
import type {
    CaseDetail,
    CaseSummary,
    CurrentLawDetail,
    CurrentLawSummary,
    CurrentOrdinanceDetail,
    CurrentOrdinanceSummary,
    LawArticleHistoryEntry,
    LawAddendum,
    LawAppendix,
    LawArticle,
    LawItem,
    LawParagraph,
    LawSubItem,
    LawVersionHistoryCode,
    LawVersionSummary,
    ProviderSearchPage,
} from './provider-types';

type XmlRecord = Record<string, unknown>;

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
});

function asRecord(value: unknown): XmlRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as XmlRecord;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value).trim();
    }
    if (Array.isArray(value)) {
        return value.map(textValue).filter(Boolean).join('\n').trim();
    }
    const record = asRecord(value);
    if (!record) return '';
    if (record['#text'] !== undefined) return textValue(record['#text']);

    return Object.entries(record)
        .filter(([key]) => !key.startsWith('@_'))
        .map(([, child]) => textValue(child))
        .filter(Boolean)
        .join('\n')
        .trim();
}

function pick(record: XmlRecord | undefined, ...keys: string[]): unknown {
    if (!record) return undefined;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
    }
    return undefined;
}

function pickText(record: XmlRecord | undefined, ...keys: string[]): string {
    return textValue(pick(record, ...keys));
}

function pickRecord(record: XmlRecord | undefined, ...keys: string[]): XmlRecord | undefined {
    return asRecord(pick(record, ...keys));
}

function parseRequiredNonNegativeInteger(value: string): number {
    if (!/^\d+$/.test(value)) throw new LegalOpenApiError('SCHEMA_DRIFT');
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    return parsed;
}

function requiredProviderText(record: XmlRecord | undefined, ...keys: string[]): string {
    const value = pickText(record, ...keys);
    if (!value) throw new LegalOpenApiError('SCHEMA_DRIFT');
    return value;
}

function requiredProviderDate(record: XmlRecord | undefined, ...keys: string[]): string {
    const value = requiredProviderText(record, ...keys);
    if (!/^\d{8}$/.test(value)) throw new LegalOpenApiError('SCHEMA_DRIFT');
    return value;
}

function requiredProviderNumericText(record: XmlRecord | undefined, ...keys: string[]): string {
    const value = requiredProviderText(record, ...keys);
    if (!/^\d+$/.test(value)) throw new LegalOpenApiError('SCHEMA_DRIFT');
    return value;
}

function canonicalProviderJo(record: XmlRecord | undefined, ...keys: string[]): string {
    const value = requiredProviderText(record, ...keys);
    if (!/^\d{1,6}$/.test(value)) throw new LegalOpenApiError('SCHEMA_DRIFT');
    return value.padStart(6, '0');
}

const LAW_VERSION_HISTORY_CODES = new Set<LawVersionHistoryCode>([
    '현행',
    '연혁',
    '시행예정',
]);

function lawVersionHistoryCode(value: string): LawVersionHistoryCode {
    if (!LAW_VERSION_HISTORY_CODES.has(value as LawVersionHistoryCode)) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    return value as LawVersionHistoryCode;
}

function classifyProviderFailure(text: string): never {
    const normalized = text.toLowerCase();
    if (/ip|아이피/.test(normalized) && /등록|허용|승인/.test(normalized)) {
        throw new LegalOpenApiError('IP_NOT_REGISTERED');
    }
    if (/호출.{0,8}(제한|초과)|too many|rate.?limit/.test(normalized)) {
        throw new LegalOpenApiError('RATE_LIMITED');
    }
    if (/인증|인증키|인증값|oc|unauthori[sz]ed|forbidden/.test(normalized)) {
        throw new LegalOpenApiError('AUTH');
    }
    throw new LegalOpenApiError('UPSTREAM_UNAVAILABLE');
}

function collectNamedText(value: unknown, wantedKeys: ReadonlySet<string>, output: string[]): void {
    if (Array.isArray(value)) {
        value.forEach((child) => collectNamedText(child, wantedKeys, output));
        return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
        if (wantedKeys.has(key.toLowerCase())) {
            const text = textValue(child);
            if (text) output.push(text);
        }
        collectNamedText(child, wantedKeys, output);
    }
}

function parseXml(xml: string): XmlRecord {
    const trimmed = xml.trim();
    if (!trimmed) throw new LegalOpenApiError('SCHEMA_DRIFT');
    if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) classifyProviderFailure(trimmed);

    let root: unknown;
    try {
        root = xmlParser.parse(trimmed);
    } catch (error) {
        throw new LegalOpenApiError('SCHEMA_DRIFT', { cause: error });
    }
    const rootRecord = asRecord(root);
    if (!rootRecord) throw new LegalOpenApiError('SCHEMA_DRIFT');

    const failureParts: string[] = [];
    collectNamedText(
        rootRecord,
        new Set(['errmsg', 'returnauthmsg', 'resultmsg', 'msg', 'message']),
        failureParts,
    );
    const resultCodeParts: string[] = [];
    collectNamedText(rootRecord, new Set(['resultcode', 'returnreasoncode']), resultCodeParts);
    const failureText = failureParts.join(' ');
    const hasFailureCode = resultCodeParts.some((code) => code && code !== '00' && code !== '0');
    if (hasFailureCode || /실패|오류|등록되지|unauthori[sz]ed|forbidden|rate.?limit/i.test(failureText)) {
        classifyProviderFailure(`${resultCodeParts.join(' ')} ${failureText}`);
    }
    return rootRecord;
}

function unwrapSingleRoot(root: XmlRecord): XmlRecord {
    const values = Object.entries(root).filter(([key]) => key !== '?xml');
    if (values.length === 1) return asRecord(values[0][1]) ?? root;
    return root;
}

function findRecordByKeys(value: unknown, keys: ReadonlySet<string>, depth = 0): XmlRecord | undefined {
    if (depth > 5) return undefined;
    const record = asRecord(value);
    if (!record) return undefined;
    for (const [key, child] of Object.entries(record)) {
        if (keys.has(key.toLowerCase())) {
            const found = asRecord(Array.isArray(child) ? child[0] : child);
            if (found) return found;
        }
    }
    for (const child of Object.values(record)) {
        const candidates = Array.isArray(child) ? child : [child];
        for (const candidate of candidates) {
            const found = findRecordByKeys(candidate, keys, depth + 1);
            if (found) return found;
        }
    }
    return undefined;
}

function searchContainer(root: XmlRecord): XmlRecord {
    const known = findRecordByKeys(
        root,
        new Set(['lawsearch', 'ordinsearch', 'precsearch', 'searchresult']),
    );
    return known ?? unwrapSingleRoot(root);
}

function itemRecords(container: XmlRecord, keys: string[]): XmlRecord[] {
    const direct = pick(container, ...keys);
    if (direct !== undefined) {
        return toArray(direct).map(asRecord).filter((item): item is XmlRecord => Boolean(item));
    }
    const nested = pickRecord(container, 'items', '목록', 'results');
    const nestedItems = pick(nested, ...keys);
    return toArray(nestedItems).map(asRecord).filter((item): item is XmlRecord => Boolean(item));
}

function searchPage<T>(container: XmlRecord, items: T[]): ProviderSearchPage<T> {
    const totalText = pickText(container, 'totalCnt', 'totalCount', '검색결과개수', '검색건수');
    const pageText = pickText(container, 'page', '현재페이지', '출력페이지');
    const totalCount = parseRequiredNonNegativeInteger(totalText);
    const page = parseRequiredNonNegativeInteger(pageText);
    if (
        page < 1
        || totalCount < items.length
        || (totalCount > 0 && items.length === 0)
    ) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    return {
        totalCount,
        page,
        items,
    };
}

function urlQueryValue(url: string | undefined, keys: readonly string[]): string {
    if (!url) return '';
    const parsed = new URL(url);
    const lowered = new Set(keys.map((key) => key.toLowerCase()));
    for (const [key, value] of parsed.searchParams.entries()) {
        if (lowered.has(key.toLowerCase())) return value;
    }
    return '';
}

export function parseCurrentLawSearchXml(xml: string): ProviderSearchPage<CurrentLawSummary> {
    const container = searchContainer(parseXml(xml));
    const items = itemRecords(container, ['law', '법령']).map((record) => {
        const rawLink = pickText(record, '법령상세링크', '상세링크');
        const preliminaryUrl = sanitizeOptionalOfficialLawLink(rawLink || undefined);
        const mst = pickText(record, '법령일련번호', 'MST')
            || urlQueryValue(preliminaryUrl, ['MST', 'lsiSeq']);
        const lawId = pickText(record, '법령ID', 'LID', 'ID');
        const name = pickText(record, '법령명한글', '법령명_한글', '법령명');
        if (!mst || !lawId || !name) throw new LegalOpenApiError('SCHEMA_DRIFT');
        const currentHistoryCode = pickText(record, '현행연혁코드') || undefined;
        if (currentHistoryCode !== undefined && currentHistoryCode !== '현행') {
            // 현행법령 전용 응답에 연혁 법령이 섞인 경우
            // 조용히 필터링하지 않고 provider schema drift로 닫는다.
            throw new LegalOpenApiError('SCHEMA_DRIFT');
        }
        const officialUrl = preliminaryUrl
            ? sanitizeOptionalOfficialLawLink(preliminaryUrl, {
                identifiers: [
                    { value: mst, queryKeys: ['MST', 'lsiSeq'] },
                    { value: lawId, queryKeys: ['ID', 'LID', 'lawId'] },
                ],
            })
            : undefined;
        return {
            mst,
            lawId,
            name,
            shortName: pickText(record, '법령약칭명') || undefined,
            lawType: pickText(record, '법령구분명', '법종구분') || undefined,
            ministry: pickText(record, '소관부처명', '소관부처') || undefined,
            promulgationDate: pickText(record, '공포일자') || undefined,
            promulgationNo: pickText(record, '공포번호') || undefined,
            effectiveDate: pickText(record, '시행일자') || undefined,
            revisionType: pickText(record, '제개정구분명', '제개정구분') || undefined,
            currentHistoryCode,
            officialUrl,
        } satisfies CurrentLawSummary;
    });
    return searchPage(container, items);
}

/**
 * 시행일 기준 법령 버전 목록을 상태 손실 없이 파싱합니다.
 * 현행 전용 parser와 달리 연혁/시행예정도 정상적인 provider 값으로 보존합니다.
 */
export function parseLawVersionSearchXml(xml: string): ProviderSearchPage<LawVersionSummary> {
    const container = searchContainer(parseXml(xml));
    const items = itemRecords(container, ['law', '법령']).map((record) => {
        const rawLink = pickText(record, '법령상세링크', '상세링크');
        const preliminaryUrl = sanitizeOptionalOfficialLawLink(rawLink || undefined);
        const mst = pickText(record, '법령일련번호', 'MST')
            || urlQueryValue(preliminaryUrl, ['MST', 'lsiSeq']);
        if (!/^\d+$/.test(mst)) throw new LegalOpenApiError('SCHEMA_DRIFT');
        const lawId = requiredProviderText(record, '법령ID', 'LID', 'ID');
        const name = requiredProviderText(record, '법령명한글', '법령명_한글', '법령명');
        const currentHistoryCode = lawVersionHistoryCode(
            requiredProviderText(record, '현행연혁코드'),
        );
        const promulgationDate = requiredProviderDate(record, '공포일자');
        const promulgationNo = requiredProviderText(record, '공포번호');
        const effectiveDate = requiredProviderDate(record, '시행일자');
        const officialUrl = preliminaryUrl
            ? sanitizeOptionalOfficialLawLink(preliminaryUrl, {
                identifiers: [
                    { value: mst, queryKeys: ['MST', 'lsiSeq'] },
                    { value: lawId, queryKeys: ['ID', 'LID', 'lawId'] },
                ],
                requireIdentifier: true,
            })
            : undefined;
        return {
            mst,
            lawId,
            name,
            shortName: pickText(record, '법령약칭명') || undefined,
            lawType: pickText(record, '법령구분명', '법종구분') || undefined,
            ministry: pickText(record, '소관부처명', '소관부처') || undefined,
            promulgationDate,
            promulgationNo,
            effectiveDate,
            revisionType: pickText(record, '제개정구분명', '제개정구분') || undefined,
            currentHistoryCode,
            officialUrl,
        } satisfies LawVersionSummary;
    });
    return searchPage(container, items);
}

/** 조문별 변경이력 API는 실응답에서 page를 생략할 수 있어 요청 page를 함께 받습니다. */
export function parseLawArticleHistoryXml(
    xml: string,
    requestedPage = 1,
): ProviderSearchPage<LawArticleHistoryEntry> {
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    const container = searchContainer(parseXml(xml));
    const lawId = requiredProviderText(container, '법령ID', 'LID', 'ID');
    const lawName = requiredProviderText(container, '법령명한글', '법령명_한글', '법령명');
    const items = itemRecords(container, ['law', '법령']).map((record) => {
        const lawInfo = pickRecord(record, '법령정보') ?? record;
        const articleInfo = pickRecord(record, '조문정보') ?? record;
        const mst = requiredProviderNumericText(lawInfo, '법령일련번호', 'MST');
        const articleNumber = canonicalProviderJo(articleInfo, '조문번호', '조번호');
        const promulgationDate = requiredProviderDate(lawInfo, '공포일자');
        const promulgationNo = requiredProviderText(lawInfo, '공포번호');
        const effectiveDate = requiredProviderDate(lawInfo, '시행일자');
        const changeReason = requiredProviderText(articleInfo, '변경사유');
        const changeDate = requiredProviderDate(articleInfo, '조문변경일', '조문개정일');
        const rawLink = pickText(articleInfo, '조문링크', '조문변경이력상세링크', '상세링크');
        const preliminaryUrl = sanitizeOptionalOfficialLawLink(rawLink || undefined);
        const officialUrl = preliminaryUrl
            ? sanitizeOptionalOfficialLawLink(preliminaryUrl, {
                identifiers: [
                    { value: mst, queryKeys: ['MST', 'lsiSeq'] },
                    { value: articleNumber, queryKeys: ['JO', 'joNo'] },
                ],
                requireIdentifier: true,
            })
            : undefined;
        return {
            mst,
            lawId,
            lawName,
            articleNumber,
            promulgationDate,
            promulgationNo,
            effectiveDate,
            revisionType: pickText(lawInfo, '제개정구분명', '제개정구분') || undefined,
            lawType: pickText(lawInfo, '법령구분명', '법종구분') || undefined,
            ministry: pickText(lawInfo, '소관부처명', '소관부처') || undefined,
            changeReason,
            changeDate,
            officialUrl,
        } satisfies LawArticleHistoryEntry;
    });

    const totalCount = parseRequiredNonNegativeInteger(
        requiredProviderText(container, 'totalCnt', 'totalCount', '검색결과개수', '검색건수'),
    );
    const responsePageText = pickText(container, 'page', '현재페이지', '출력페이지');
    if (responsePageText) {
        const responsePage = parseRequiredNonNegativeInteger(responsePageText);
        if (responsePage !== requestedPage) throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    if (totalCount < items.length || (totalCount > 0 && items.length === 0)) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    return { totalCount, page: requestedPage, items };
}

export function parseCurrentOrdinanceSearchXml(
    xml: string,
): ProviderSearchPage<CurrentOrdinanceSummary> {
    const container = searchContainer(parseXml(xml));
    const items = itemRecords(container, ['law', 'ordin', '자치법규']).map((record) => {
        const rawLink = pickText(record, '자치법규상세링크', '상세링크');
        const preliminaryUrl = sanitizeOptionalOfficialLawLink(rawLink || undefined);
        const mst = pickText(record, '자치법규일련번호', '자치법규키', 'MST')
            || urlQueryValue(preliminaryUrl, ['MST', 'lsiSeq']);
        const ordinanceId = pickText(record, '자치법규ID', 'ID');
        const name = pickText(record, '자치법규명');
        if (!mst || !ordinanceId || !name) throw new LegalOpenApiError('SCHEMA_DRIFT');
        const officialUrl = preliminaryUrl
            ? sanitizeOptionalOfficialLawLink(preliminaryUrl, {
                identifiers: [
                    { value: mst, queryKeys: ['MST', 'lsiSeq'] },
                    { value: ordinanceId, queryKeys: ['ID', 'ordinId'] },
                ],
            })
            : undefined;
        return {
            mst,
            ordinanceId,
            name,
            authorityName: pickText(record, '지자체기관명', '전체기관명') || undefined,
            ordinanceType: pickText(record, '자치법규종류') || undefined,
            promulgationDate: pickText(record, '공포일자') || undefined,
            promulgationNo: pickText(record, '공포번호') || undefined,
            effectiveDate: pickText(record, '시행일자') || undefined,
            revisionType: pickText(record, '제개정구분명', '제개정정보') || undefined,
            officialUrl,
        } satisfies CurrentOrdinanceSummary;
    });
    return searchPage(container, items);
}

export function parseCaseSearchXml(xml: string): ProviderSearchPage<CaseSummary> {
    const container = searchContainer(parseXml(xml));
    const items = itemRecords(container, ['prec', '판례']).map((record) => {
        const caseSerialId = pickText(record, '판례일련번호', '판례정보일련번호', 'ID');
        const caseName = pickText(record, '사건명', '판례명');
        if (!caseSerialId || !caseName) throw new LegalOpenApiError('SCHEMA_DRIFT');
        const rawLink = pickText(record, '판례상세링크', '상세링크');
        const officialUrl = sanitizeOptionalOfficialLawLink(rawLink || undefined, {
            identifiers: [{ value: caseSerialId, queryKeys: ['ID', 'precId'] }],
        });
        return {
            caseSerialId,
            caseName,
            caseNumber: pickText(record, '사건번호') || undefined,
            decisionDate: pickText(record, '선고일자') || undefined,
            courtName: pickText(record, '법원명') || undefined,
            courtTypeCode: pickText(record, '법원종류코드') || undefined,
            caseTypeName: pickText(record, '사건종류명') || undefined,
            judgmentType: pickText(record, '판결유형') || undefined,
            decision: pickText(record, '선고') || undefined,
            dataSourceName: pickText(record, '데이터출처명') || undefined,
            officialUrl,
        } satisfies CaseSummary;
    });
    return searchPage(container, items);
}

function parseSubItem(record: XmlRecord): LawSubItem {
    return {
        number: pickText(record, '목번호', '목가지번호'),
        content: pickText(record, '목내용'),
    };
}

function parseItem(record: XmlRecord): LawItem {
    const subItems = toArray(pick(record, '목', '목단위'))
        .map(asRecord)
        .filter((item): item is XmlRecord => Boolean(item))
        .map(parseSubItem);
    return {
        number: pickText(record, '호번호'),
        content: pickText(record, '호내용'),
        subItems,
    };
}

function parseParagraph(record: XmlRecord): LawParagraph {
    const items = toArray(pick(record, '호', '호단위'))
        .map(asRecord)
        .filter((item): item is XmlRecord => Boolean(item))
        .map(parseItem);
    return {
        number: pickText(record, '항번호'),
        content: pickText(record, '항내용'),
        items,
    };
}

function parseArticle(record: XmlRecord): LawArticle {
    const paragraphs = toArray(pick(record, '항', '항단위'))
        .map(asRecord)
        .filter((item): item is XmlRecord => Boolean(item))
        .map(parseParagraph);
    const branchNumber = pickText(record, '조문가지번호');
    const articleFlag = pickText(record, '조문여부');
    return {
        articleNumber: pickText(record, '조문번호', '조번호'),
        branchNumber: branchNumber && branchNumber !== '0' ? branchNumber : undefined,
        title: pickText(record, '조문제목', '조제목') || undefined,
        content: pickText(record, '조문내용', '조내용'),
        effectiveDate: pickText(record, '조문시행일자') || undefined,
        isArticle: !articleFlag || articleFlag === 'Y' || articleFlag === '조문',
        paragraphs,
    };
}

function parseOrdinanceArticle(record: XmlRecord): LawArticle {
    const article = parseArticle(record);
    if (!article.isArticle) return article;
    const heading = article.content.match(/^제\s*(\d+)\s*조(?:의\s*(\d+))?(?=[\s(（]|$)/);
    if (!heading) return article;

    const explicitBranch = pickText(record, '조문가지번호');
    const numericParts = [article.articleNumber, heading[1], heading[2] ?? '0'];
    if (explicitBranch) numericParts.push(explicitBranch);
    if (numericParts.some((value) => !/^\d{1,30}$/.test(value))) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    const rawNumber = BigInt(article.articleNumber);
    const mainNumber = BigInt(heading[1]);
    const branchNumber = BigInt(heading[2] ?? '0');
    const suppliedBranch = explicitBranch ? BigInt(explicitBranch) : undefined;
    if (mainNumber === 0n || (heading[2] !== undefined && branchNumber === 0n)
        || (suppliedBranch !== undefined && suppliedBranch !== branchNumber)) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }

    // 조례의 실측 복합 코드(main * 100 + branch)는 원문 표제와 일치할 때만
    // 분리한다. 기존 단순 번호는 별도 가지번호까지 맞는 경우 그대로 인정한다.
    const matchesLegacy = rawNumber === mainNumber && (suppliedBranch ?? 0n) === branchNumber;
    const matchesComposite = rawNumber === mainNumber * 100n + branchNumber;
    if (!matchesLegacy && !matchesComposite) throw new LegalOpenApiError('SCHEMA_DRIFT');
    return {
        ...article,
        articleNumber: mainNumber.toString(),
        branchNumber: branchNumber === 0n ? undefined : branchNumber.toString(),
    };
}

function parseAddendum(record: XmlRecord): LawAddendum {
    return {
        promulgationDate: pickText(record, '부칙공포일자') || undefined,
        promulgationNo: pickText(record, '부칙공포번호') || undefined,
        content: pickText(record, '부칙내용'),
    };
}

function sanitizeAppendixLink(value: string): string | undefined {
    return sanitizeOptionalOfficialLawLink(value || undefined);
}

function parseAppendix(record: XmlRecord): LawAppendix {
    const branchNumber = pickText(record, '별표가지번호');
    return {
        number: pickText(record, '별표번호'),
        branchNumber: branchNumber && branchNumber !== '0' ? branchNumber : undefined,
        kind: pickText(record, '별표구분', '별표종류') || undefined,
        title: pickText(record, '별표제목', '별표명') || undefined,
        content: pickText(record, '별표내용') || undefined,
        fileName: pickText(record, '별표첨부파일명') || undefined,
        fileUrl: sanitizeAppendixLink(pickText(record, '별표서식파일링크')),
        pdfUrl: sanitizeAppendixLink(pickText(record, '별표서식PDF파일링크', 'PDF파일링크')),
        effectiveDate: pickText(record, '별표시행일자') || undefined,
    };
}

function unitsFromContainer(
    root: XmlRecord,
    containerKeys: string[],
    unitKeys: string[],
): XmlRecord[] {
    const container = pickRecord(root, ...containerKeys);
    const value = pick(container, ...unitKeys) ?? pick(root, ...unitKeys);
    return toArray(value).map(asRecord).filter((item): item is XmlRecord => Boolean(item));
}

function lawLikeNode(parsedRoot: XmlRecord, keys: string[]): XmlRecord {
    const found = findRecordByKeys(parsedRoot, new Set(keys.map((key) => key.toLowerCase())));
    return found ?? unwrapSingleRoot(parsedRoot);
}

function parseOrdinanceAddenda(node: XmlRecord): LawAddendum[] {
    const container = pickRecord(node, '부칙');
    const fields = ['부칙공포일자', '부칙공포번호', '부칙내용'] as const;
    const values = fields.map((field) => pick(container, field));
    if (!values.some(Array.isArray)) {
        return unitsFromContainer(node, ['부칙'], ['부칙단위', '부칙']).map(parseAddendum);
    }

    // 실측 자치법규 XML은 같은 필드가 순서대로 반복된다. 날짜·번호·본문을
    // 하나로 합치지 않고 같은 index끼리 연결하되 불완전한 대응은 거부한다.
    if (pick(container, '부칙단위', '부칙') !== undefined) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    const columns = values.map((value) => {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new LegalOpenApiError('SCHEMA_DRIFT');
        }
        return value as string[];
    });
    const count = columns[0].length;
    if (count === 0 || columns.some((column) => column.length !== count)) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    return Array.from({ length: count }, (_, index) => parseAddendum(
        Object.fromEntries(fields.map((field, column) => [field, columns[column][index]])),
    ));
}

function parseLawLikeDetail(parsedRoot: XmlRecord, ordinance: boolean): CurrentLawDetail | CurrentOrdinanceDetail {
    const node = lawLikeNode(
        parsedRoot,
        ordinance ? ['자치법규', 'ordinservice'] : ['법령', 'lawservice'],
    );
    const basic = pickRecord(node, '기본정보')
        ?? (ordinance ? pickRecord(node, '자치법규기본정보') : undefined)
        ?? node;
    const articles = unitsFromContainer(node, ['조문'], ordinance ? ['조문단위', '조', '조문'] : ['조문단위', '조문'])
        .map(ordinance ? parseOrdinanceArticle : parseArticle);
    const addenda = ordinance
        ? parseOrdinanceAddenda(node)
        : unitsFromContainer(node, ['부칙'], ['부칙단위', '부칙']).map(parseAddendum);
    const appendices = unitsFromContainer(node, ['별표'], ['별표단위', '별표'])
        .map(parseAppendix);

    if (ordinance) {
        const detail: CurrentOrdinanceDetail = {
            mst: pickText(basic, '자치법규일련번호', '자치법규키', 'MST') || undefined,
            ordinanceId: pickText(basic, '자치법규ID', 'ID') || undefined,
            name: pickText(basic, '자치법규명') || undefined,
            authorityName: pickText(basic, '지자체기관명', '전체기관명') || undefined,
            ordinanceType: pickText(basic, '자치법규종류') || undefined,
            promulgationDate: pickText(basic, '공포일자') || undefined,
            promulgationNo: pickText(basic, '공포번호') || undefined,
            effectiveDate: pickText(basic, '시행일자') || undefined,
            revisionType: pickText(basic, '제개정정보', '제개정구분') || undefined,
            articles,
            addenda,
            appendices,
        };
        if (!detail.ordinanceId && !detail.mst && !detail.name) {
            throw new LegalOpenApiError('SCHEMA_DRIFT');
        }
        return detail;
    }

    const detail: CurrentLawDetail = {
        // 법령키는 법령ID+공포일+공포번호 복합키일 수 있으므로 MST로 사용하지 않는다.
        mst: pickText(basic, '법령일련번호', 'MST') || undefined,
        lawId: pickText(basic, '법령ID', 'ID') || undefined,
        name: pickText(basic, '법령명_한글', '법령명한글', '법령명') || undefined,
        nameHanja: pickText(basic, '법령명_한자') || undefined,
        lawType: pickText(basic, '법종구분', '법령구분명') || undefined,
        ministry: pickText(basic, '소관부처', '소관부처명') || undefined,
        promulgationDate: pickText(basic, '공포일자') || undefined,
        promulgationNo: pickText(basic, '공포번호') || undefined,
        effectiveDate: pickText(basic, '시행일자') || undefined,
        revisionType: pickText(basic, '제개정구분') || undefined,
        articles,
        addenda,
        appendices,
    };
    if (!detail.lawId && !detail.mst && !detail.name) {
        throw new LegalOpenApiError('SCHEMA_DRIFT');
    }
    return detail;
}

export function parseCurrentLawDetailXml(xml: string): CurrentLawDetail {
    return parseLawLikeDetail(parseXml(xml), false) as CurrentLawDetail;
}

export function parseCurrentOrdinanceDetailXml(xml: string): CurrentOrdinanceDetail {
    return parseLawLikeDetail(parseXml(xml), true) as CurrentOrdinanceDetail;
}

export function parseCaseDetailXml(xml: string): CaseDetail {
    const parsed = parseXml(xml);
    const documentEntries = Object.entries(parsed)
        .filter(([key]) => key !== '?xml');
    const exactMissingEnvelope = documentEntries.length === 1
        && documentEntries[0][0] === 'Law'
        && typeof documentEntries[0][1] === 'string'
        && documentEntries[0][1].replace(/\s+/g, ' ').trim()
            === '일치하는 판례가 없습니다. 판례명을 확인하여 주십시오.';
    if (exactMissingEnvelope) {
        // 판례 검색 목록에 노출된 ID를 상세 API가 아직 제공하지 않는 실응답을
        // 일반 schema drift와 구분한다. XML 선언 외 sibling·attribute·nested node가
        // 없는 exact envelope만 허용하며 나머지는 계속 SCHEMA_DRIFT로 닫힌다.
        throw new LegalOpenApiError('CASE_DETAIL_NOT_FOUND');
    }
    const node = lawLikeNode(parsed, ['precservice', '판례', '판례정보']);
    const caseSerialId = pickText(node, '판례정보일련번호', '판례일련번호', 'ID');
    const caseName = pickText(node, '사건명', '판례명');
    if (!caseSerialId || !caseName) throw new LegalOpenApiError('SCHEMA_DRIFT');

    return {
        caseSerialId,
        caseName,
        caseNumber: pickText(node, '사건번호') || undefined,
        decisionDate: pickText(node, '선고일자') || undefined,
        decision: pickText(node, '선고') || undefined,
        courtName: pickText(node, '법원명') || undefined,
        courtTypeCode: pickText(node, '법원종류코드') || undefined,
        caseTypeName: pickText(node, '사건종류명') || undefined,
        caseTypeCode: pickText(node, '사건종류코드') || undefined,
        judgmentType: pickText(node, '판결유형') || undefined,
        holdings: pickText(node, '판시사항') || undefined,
        summary: pickText(node, '판결요지') || undefined,
        referenceProvisions: pickText(node, '참조조문') || undefined,
        referencedCases: pickText(node, '참조판례') || undefined,
        fullText: pickText(node, '판례내용') || undefined,
    };
}
