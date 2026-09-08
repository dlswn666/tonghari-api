import * as z from 'zod/v4';

export const LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME = 'lookup_building_footprints_v1' as const;
export const BUILDING_FOOTPRINTS_SOURCE = 'https://api.vworld.kr/req/data';
export const BUILDING_FOOTPRINTS_LAYER = 'LT_C_BLDGINFO' as const;
export const BUILDING_FOOTPRINTS_DOCUMENTATION = 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=bldginfo';
export const BUILDING_FOOTPRINTS_ATTRIBUTION = '국토교통부 VWorld 건축물정보를 이용했습니다.';
export const BUILDING_FOOTPRINTS_MAX_AREA_M2 = 2_000_000;
export const BUILDING_FOOTPRINTS_MAX_POINTS = 1_000;

// 극지/날짜변경선과 가늘고 지나치게 긴 검색 창을 허용하지 않는 지역 조회 계약이다.
export const BuildingFootprintsBboxSchema = z.tuple([
    z.number().min(-180).max(180), z.number().min(-85).max(85),
    z.number().min(-180).max(180), z.number().min(-85).max(85),
]).refine(([west, south, east, north]) => {
    if (east <= west || north <= south || east - west > 0.05 || north - south > 0.05) return false;
    const closestLatitude = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));
    const upperArea = (east - west) * (north - south) * 111_320 ** 2 * Math.cos(closestLatitude * Math.PI / 180);
    return upperArea <= BUILDING_FOOTPRINTS_MAX_AREA_M2;
}, 'BBOX는 각 축 0.05도 이하, 면적 2km² 이하의 올바른 지역 범위여야 합니다.');

export const LookupBuildingFootprintsInputV1Schema = z.object({
    bbox: BuildingFootprintsBboxSchema,
    page: z.number().int().min(1).max(10_000).default(1),
    limit: z.number().int().min(1).max(100).default(20),
}).strict();
export type LookupBuildingFootprintsInputV1 = z.infer<typeof LookupBuildingFootprintsInputV1Schema>;

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const ring = z.array(position).min(4).max(BUILDING_FOOTPRINTS_MAX_POINTS).refine((points) => {
    const first = points[0]; const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) return false;
    // 퇴화한 링은 건물 윤곽으로 제공하지 않는다. 좌표를 이동해 소수점 상쇄를 줄인다.
    // 이것은 위상 검증이 아니다. 후속 저장에서는 ST_IsValid로 자기교차·홀 관계 등을 별도 확인한다.
    let twiceArea = 0;
    for (let i = 0; i < points.length - 1; i++) {
        twiceArea += (points[i][0] - first[0]) * (points[i + 1][1] - first[1])
            - (points[i + 1][0] - first[0]) * (points[i][1] - first[1]);
    }
    return Math.abs(twiceArea) > 0;
}, '닫힌 비퇴화 도형 링이어야 합니다.');
const polygon = z.array(ring).min(1).max(BUILDING_FOOTPRINTS_MAX_POINTS / 4);
export const BuildingFootprintGeometrySchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('Polygon'), coordinates: polygon }).strict(),
    z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(polygon).min(1).max(250) }).strict(),
]).refine((geometry) => {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.reduce((sum, rings) => sum + rings.reduce((count, points) => count + points.length, 0), 0)
        <= BUILDING_FOOTPRINTS_MAX_POINTS;
}, '도형별 좌표 상한을 초과했습니다.');

// 2026-09-08 공식 LT_C_BLDGINFO 속성표. PNU와 건축물대장 PK는 이 레이어의 필드가 아니다.
export const BUILDING_FOOTPRINTS_PROPERTY_KEYS = [
    'bld_nm', 'dong_nm', 'usability', 'strct_cd', 'grnd_flr', 'ugrnd_flr',
    'archarea', 'height', 'vl_rat', 'bc_rat', 'totalarea', 'platarea', 'useapr_day',
] as const;
const scalar = z.union([z.string().max(300), z.number(), z.null()]);
export const BuildingFootprintPropertiesSchema = z.object({
    bld_nm: scalar.optional(), dong_nm: scalar.optional(), usability: scalar.optional(),
    strct_cd: scalar.optional(), grnd_flr: scalar.optional(), ugrnd_flr: scalar.optional(),
    archarea: scalar.optional(), height: scalar.optional(), vl_rat: scalar.optional(),
    bc_rat: scalar.optional(), totalarea: scalar.optional(), platarea: scalar.optional(),
    useapr_day: scalar.optional(),
}).strict();
export const BuildingFootprintFeatureSchema = z.object({
    type: z.literal('Feature'),
    id: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
    properties: BuildingFootprintPropertiesSchema,
    geometry: BuildingFootprintGeometrySchema,
}).strict();
export const BuildingFootprintsDataSchema = z.object({
    layer: z.literal(BUILDING_FOOTPRINTS_LAYER),
    crs: z.literal('EPSG:4326'),
    type: z.literal('FeatureCollection'),
    features: z.array(BuildingFootprintFeatureSchema).max(100),
}).strict();
export type BuildingFootprintFeature = z.infer<typeof BuildingFootprintFeatureSchema>;
export interface BuildingFootprintsPage {
    features: BuildingFootprintFeature[];
    total: number;
}
export interface BuildingFootprintsClient {
    lookup(input: LookupBuildingFootprintsInputV1, signal: AbortSignal): Promise<BuildingFootprintsPage>;
}
