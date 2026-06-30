export interface GeocodePnuResult {
    pnu: string;
    x: string;
    y: string;
}

export interface ParsedPnuResult {
    pnu: string;
}

export interface GisAddressResolutionDeps {
    getPNUFromAddress(address: string): Promise<GeocodePnuResult | null>;
    generatePNUFromAddress(address: string): Promise<ParsedPnuResult | null>;
}

export interface GisAddressResolution {
    pnu: string;
    x: string | null;
    y: string | null;
    source: 'geocoder' | 'parsed';
}

export async function resolveGisAddressData(
    address: string,
    deps: GisAddressResolutionDeps
): Promise<GisAddressResolution | null> {
    let geocodeData: GeocodePnuResult | null = null;
    try {
        geocodeData = await deps.getPNUFromAddress(address);
    } catch {
        geocodeData = null;
    }

    if (geocodeData?.pnu) {
        return {
            pnu: geocodeData.pnu,
            x: geocodeData.x || null,
            y: geocodeData.y || null,
            source: 'geocoder',
        };
    }

    const parsedData = await deps.generatePNUFromAddress(address);
    if (!parsedData?.pnu) return null;

    return {
        pnu: parsedData.pnu,
        x: geocodeData?.x || null,
        y: geocodeData?.y || null,
        source: 'parsed',
    };
}
