import {
    FULL_GIS_SOURCE_IDS,
    FULL_GIS_SOURCE_META,
    FullGisStepSchema,
    LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME,
    LookupFullGisPublicDataInputV1Schema,
    emptyFullGisStep,
    type FullGisClient,
    type FullGisData,
    type FullGisSourceId,
    type FullGisSourceQuery,
    type FullGisStep,
    type LookupFullGisPublicDataInputV1,
} from './full-lookup-contract';
import {
    PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES,
    type PublicDataMcpResultV1,
} from './policy';

const PNU_PATTERN = /^\d{10}[12]\d{8}$/;
const SINGLETON_IDS = new Set<FullGisSourceId>(FULL_GIS_SOURCE_IDS.slice(0, 3));
const DEPENDENT_IDS = FULL_GIS_SOURCE_IDS.slice(3);
const MAX_CONCURRENT_SOURCES = 3;

function abortCode(signal: AbortSignal): string {
    const reason = signal.reason;
    return reason === 'REQUEST_DEADLINE_EXCEEDED'
        || reason === 'LOOKUP_DEADLINE_EXCEEDED'
        || (reason instanceof Error && reason.name === 'TimeoutError')
        ? 'REQUEST_DEADLINE_EXCEEDED'
        : 'REQUEST_ABORTED';
}

/** 취소를 무시하는 주입 client도 다음 source를 시작하지 않게 한다. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
        if (signal.aborted) onAbort();
    });
}

function validSourceResult(step: FullGisStep, query: FullGisSourceQuery): boolean {
    const page = step.pagination;
    if (page.offset !== query.offset || page.limit !== query.limit
        || page.returned !== step.records.length || page.returned > query.limit) return false;
    if (!page.hasMore && page.nextOffset !== null) return false;
    if (page.hasMore && (page.nextOffset === null || page.nextOffset < page.offset)) return false;
    if (step.status === 'NO_DATA') {
        return step.records.length === 0 && page.total === 0 && !page.hasMore;
    }
    if (step.status !== 'SUCCESS') return true;
    if (page.total === null || page.total === 0) return false;
    if (page.offset < page.total && step.records.length === 0) return false;
    if (step.records.length > 0 && page.offset + page.returned > page.total) return false;
    const expectedHasMore = page.offset + page.returned < page.total;
    return page.hasMore === expectedHasMore
        && (!page.hasMore || page.nextOffset === page.offset + page.returned);
}

function completeStep(step: FullGisStep): boolean {
    return step.status === 'SUCCESS' || step.status === 'NO_DATA';
}

function resultStatus(data: FullGisData): PublicDataMcpResultV1['status'] {
    if (data.steps.every((step) => step.status === 'NO_DATA')) return 'NO_DATA';
    if (data.allRecordsReturned) return 'SUCCESS';
    return data.steps.some((step) => step.status === 'SUCCESS'
        || step.status === 'PARTIAL' || step.records.length > 0)
        ? 'PARTIAL'
        : 'INCOMPLETE';
}

export function createFullGisLookupProvider(dependencies: {
    client?: FullGisClient;
    now?: () => number;
} = {}): {
    execute(
        input: LookupFullGisPublicDataInputV1,
        context: { signal: AbortSignal },
    ): Promise<PublicDataMcpResultV1>;
} {
    let client = dependencies.client;
    const clock = dependencies.now ?? Date.now;
    const now = () => {
        const value = clock();
        return Number.isFinite(value) ? value : 0;
    };

    return {
        async execute(candidate, { signal }) {
            const input = LookupFullGisPublicDataInputV1Schema.parse(candidate);
            const year = input.year ?? new Date(now()).getUTCFullYear();
            const steps = new Map<FullGisSourceId, FullGisStep>();
            const queried = new Set<FullGisSourceId>();
            let resolvedPnu: string | undefined = input.pnu;
            let coordinates: FullGisSourceQuery['coordinates'];
            let mismatch = false;

            const queryFor = (id: FullGisSourceId): FullGisSourceQuery => ({
                ...(input.address ? { address: input.address } : {}),
                ...(resolvedPnu ? { pnu: resolvedPnu } : {}),
                ...(coordinates ? { coordinates } : {}),
                ...(input.buildingHo ? { buildingHo: input.buildingHo } : {}),
                year,
                // 주소 의존성은 다음 페이지에서도 같은 좌표/PNU를 확보해야 한다.
                offset: SINGLETON_IDS.has(id) ? 0 : input.offsets?.[id] ?? input.offset,
                limit: input.limit,
            });
            const empty = (id: FullGisSourceId, status: FullGisStep['status'], code: string) => {
                const step = emptyFullGisStep(id, queryFor(id), status, code, now);
                steps.set(id, step);
                return step;
            };
            const lookup = async (id: FullGisSourceId): Promise<FullGisStep> => {
                if (signal.aborted) return empty(id, 'INCOMPLETE', abortCode(signal));
                const query = queryFor(id);
                try {
                    client ??= (require('./full-lookup-client') as {
                        createFullGisClient(): FullGisClient;
                    }).createFullGisClient();
                    queried.add(id);
                    const raw = await withAbort(client.lookup(id, query, signal), signal);
                    if (signal.aborted) return empty(id, 'INCOMPLETE', abortCode(signal));
                    const parsed = FullGisStepSchema.safeParse(raw);
                    if (!parsed.success || parsed.data.id !== id
                        || !validSourceResult(parsed.data, query)) {
                        return empty(id, 'INCOMPLETE', 'PROVIDER_RESPONSE_INVALID');
                    }
                    const step = { ...parsed.data, ...FULL_GIS_SOURCE_META[id] };
                    // 순환 객체 등 직렬화 불가능한 응답은 다른 source와 격리한다.
                    JSON.stringify(step);
                    steps.set(id, step);
                    return step;
                } catch {
                    return empty(id, signal.aborted ? 'INCOMPLETE' : 'FAILED',
                        signal.aborted ? abortCode(signal) : 'PROVIDER_REQUEST_FAILED');
                }
            };

            if (input.address) {
                const geocode = await lookup('geocode');
                const point = geocode.records[0];
                if (geocode.status === 'SUCCESS'
                    && typeof point?.longitude === 'number' && Number.isFinite(point.longitude)
                    && Math.abs(point.longitude) <= 180
                    && typeof point.latitude === 'number' && Number.isFinite(point.latitude)
                    && Math.abs(point.latitude) <= 90 && point.crs === 'EPSG:4326') {
                    coordinates = { longitude: point.longitude, latitude: point.latitude };
                    const [pnuStep] = await Promise.all([
                        lookup('coord_to_pnu'), lookup('reverse_geocode'),
                    ]);
                    const coordinatePnu = pnuStep.records[0]?.pnu;
                    if (pnuStep.status === 'SUCCESS' && typeof coordinatePnu === 'string'
                        && PNU_PATTERN.test(coordinatePnu)) {
                        mismatch = Boolean(input.pnu && input.pnu !== coordinatePnu);
                        resolvedPnu = mismatch ? undefined : coordinatePnu;
                    } else if (pnuStep.status === 'SUCCESS') {
                        empty('coord_to_pnu', 'INCOMPLETE', 'PROVIDER_RESPONSE_INVALID');
                    }
                } else {
                    if (geocode.status === 'SUCCESS') {
                        empty('geocode', 'INCOMPLETE', 'PROVIDER_RESPONSE_INVALID');
                    }
                    for (const id of ['coord_to_pnu', 'reverse_geocode'] as const) {
                        empty(id, signal.aborted ? 'INCOMPLETE' : 'SKIPPED',
                            signal.aborted ? abortCode(signal) : 'COORDINATES_REQUIRED');
                    }
                }
            } else {
                for (const id of FULL_GIS_SOURCE_IDS.slice(0, 3)) {
                    empty(id, 'SKIPPED', 'ADDRESS_REQUIRED');
                }
            }

            if (resolvedPnu && !mismatch) {
                let next = 0;
                await Promise.all(Array.from({ length: MAX_CONCURRENT_SOURCES }, async () => {
                    while (next < DEPENDENT_IDS.length) {
                        const id = DEPENDENT_IDS[next++];
                        await lookup(id);
                    }
                }));
            } else {
                for (const id of DEPENDENT_IDS) {
                    empty(id, signal.aborted ? 'INCOMPLETE' : 'SKIPPED', signal.aborted
                        ? abortCode(signal) : mismatch ? 'PNU_MISMATCH' : 'PNU_REQUIRED');
                }
            }

            const buildResult = (): PublicDataMcpResultV1 => {
                const ordered = FULL_GIS_SOURCE_IDS.map((id) => steps.get(id)!);
                const allSourcesQueried = queried.size === FULL_GIS_SOURCE_IDS.length
                    && ordered.every((step) => step.status !== 'SKIPPED');
                const hasMore = ordered.some((step) => step.pagination.hasMore);
                const data: FullGisData = {
                    pnu: resolvedPnu ?? null,
                    steps: ordered,
                    allSourcesQueried,
                    allRecordsReturned: allSourcesQueried && input.offset === 0
                        && ordered.every((step) => completeStep(step) && step.pagination.offset === 0)
                        && !hasMore,
                    hasMore,
                };
                const status = mismatch ? 'INCOMPLETE' : resultStatus(data);
                return {
                    contractVersion: 'TonghariPublicGisResultV1',
                    tool: LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME,
                    status,
                    ...(mismatch ? { code: 'PNU_MISMATCH' as const }
                        : status === 'PARTIAL' ? { code: 'FULL_GIS_PARTIAL' as const }
                            : status === 'INCOMPLETE' ? { code: 'FULL_GIS_INCOMPLETE' as const }
                                : status === 'NO_DATA' ? { code: 'NO_DATA' as const } : {}),
                    provider: 'VWorld, 공공데이터포털 건축HUB',
                    source: [...new Set(FULL_GIS_SOURCE_IDS.map((id) => FULL_GIS_SOURCE_META[id].source))].join(', '),
                    asOf: new Date(now()).toISOString(),
                    attribution: '국토교통부 VWorld 및 건축HUB 공공데이터를 이용했습니다.',
                    query: { address: input.address ?? null, pnu: input.pnu ?? null, year,
                        offset: input.offset, offsets: input.offsets ?? {}, limit: input.limit,
                        buildingHo: input.buildingHo ?? null },
                    data,
                    warnings: ['DATA_REFERENCE_DATE_MUST_BE_CONFIRMED',
                        'PUBLIC_RECORD_DOES_NOT_CONFIRM_REGISTERED_RIGHTS',
                        'OFFICIAL_PRICE_IS_NOT_APPRAISAL'],
                };
            };

            let result = buildResult();
            // 큰 source의 행만 제외하고 다른 source의 증거와 재조회 offset을 보존한다.
            const largestFirst = [...steps.values()].filter((step) => step.records.length > 0)
                .sort((a, b) => Buffer.byteLength(JSON.stringify(b.records), 'utf8')
                    - Buffer.byteLength(JSON.stringify(a.records), 'utf8'));
            for (const step of largestFirst) {
                if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES) break;
                steps.set(step.id, {
                    ...step, status: 'INCOMPLETE', code: 'OUTPUT_TOO_LARGE', records: [],
                    pagination: { ...step.pagination, returned: 0, hasMore: true,
                        nextOffset: step.pagination.offset },
                });
                result = buildResult();
            }
            return result;
        },
    };
}
