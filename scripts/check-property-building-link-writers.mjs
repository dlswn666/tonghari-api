import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const scopedForbiddenFragments = [
    {
        file: 'src/services/member.queue.service.ts',
        fragments: [
            "from('buildings')",
            "from('building_units')",
            "from('building_land_lots')",
            'findOrCreateBuildingUnit',
            'processSyncPropertiesJob',
        ],
    },
    {
        file: 'src/services/supabase.service.ts',
        fragments: [
            "from('property_units')",
            'linkPropertyUnitsToBuildingUnits',
            'linkPropertyUnitsForIndividualHousing',
        ],
    },
    {
        file: 'src/services/gis.queue.service.ts',
        fragments: [
            'linkPropertyUnitsToBuildingUnits',
            'linkPropertyUnitsForIndividualHousing',
        ],
    },
];

const globalWriterPatterns = [
    { label: 'building_unit_id payload writer', pattern: /\bbuilding_unit_id\s*:/g },
    { label: 'buildingUnitId payload writer', pattern: /\bbuildingUnitId\s*:/g },
    { label: 'building_unit_id dynamic writer', pattern: /\bupdateData\.building_unit_id\b/g },
    {
        label: 'building-derived dong/ho property writer',
        pattern: /\bupdateData\.(?:dong|ho)\s*=\s*matchedUnit\.(?:dong|ho)\b/g,
    },
    {
        label: 'property-building link RPC writer',
        pattern: /\.rpc\(\s*['"][^'"]*(?:link[^'"]*property|property[^'"]*building|sync_properties)[^'"]*['"]/gi,
    },
];

async function listTypeScriptFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listTypeScriptFiles(path));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            files.push(path);
        }
    }

    return files;
}

export async function findPropertyBuildingLinkWriterViolations() {
    const violations = [];

    for (const rule of scopedForbiddenFragments) {
        const source = await readFile(rule.file, 'utf8');
        for (const fragment of rule.fragments) {
            if (source.includes(fragment)) {
                violations.push(`${rule.file}: forbidden fragment: ${fragment}`);
            }
        }
    }

    const sourceFiles = await listTypeScriptFiles('src');
    for (const file of sourceFiles) {
        const source = await readFile(file, 'utf8');
        for (const { label, pattern } of globalWriterPatterns) {
            pattern.lastIndex = 0;
            if (pattern.test(source)) {
                violations.push(`${file}: forbidden ${label}`);
            }
        }
    }

    const memberRoute = await readFile('src/routes/member.ts', 'utf8');
    if (!memberRoute.includes("code: 'FEATURE_DISABLED_PHASE_F'")) {
        violations.push('src/routes/member.ts: SYNC_PROPERTIES feature-disabled response is missing');
    }
    if (!memberRoute.includes('return res.status(409).json')) {
        violations.push('src/routes/member.ts: SYNC_PROPERTIES must return HTTP 409');
    }

    return violations;
}

const violations = await findPropertyBuildingLinkWriterViolations();
if (violations.length > 0) {
    console.error(['Phase 0-S property-building writer guard failed:', ...violations].join('\n'));
    process.exitCode = 1;
} else {
    console.log('Phase 0-S property-building writer guard passed.');
}
