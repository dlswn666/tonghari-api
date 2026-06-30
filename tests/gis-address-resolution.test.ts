import assert from 'node:assert/strict';
import { resolveGisAddressData } from '../src/services/gis-address-resolution';

(async () => {
    {
    let parserCalled = false;
    const resolved = await resolveGisAddressData('서울특별시 강북구 미아동 701-28', {
        getPNUFromAddress: async () => null,
        generatePNUFromAddress: async () => {
            parserCalled = true;
            return {
                pnu: '1130510100107010028',
                sido: '서울특별시',
                sigungu: '강북구',
                dong: '미아동',
                bjdCode: '1130510100',
                mainNum: '701',
                subNum: '28',
            };
        },
    });

    assert.equal(parserCalled, true);
    assert.deepEqual(resolved, {
        pnu: '1130510100107010028',
        x: null,
        y: null,
        source: 'parsed',
    });
    }

    {
    let parserCalled = false;
    const resolved = await resolveGisAddressData('서울특별시 강북구 미아동 701-28', {
        getPNUFromAddress: async () => ({
            pnu: '1130510100107010028',
            x: '127.0',
            y: '37.0',
        }),
        generatePNUFromAddress: async () => {
            parserCalled = true;
            return null;
        },
    });

    assert.equal(parserCalled, false);
    assert.deepEqual(resolved, {
        pnu: '1130510100107010028',
        x: '127.0',
        y: '37.0',
        source: 'geocoder',
    });
    }

    {
        const resolved = await resolveGisAddressData('서울특별시 강북구 미아동 701-28', {
            getPNUFromAddress: async () => ({
            pnu: '',
            x: '127.0',
            y: '37.0',
        }),
        generatePNUFromAddress: async () => ({
            pnu: '1130510100107010028',
            sido: '서울특별시',
            sigungu: '강북구',
            dong: '미아동',
            bjdCode: '1130510100',
            mainNum: '701',
            subNum: '28',
        }),
        });

        assert.deepEqual(resolved, {
            pnu: '1130510100107010028',
            x: '127.0',
            y: '37.0',
            source: 'parsed',
        });
    }

    {
        const resolved = await resolveGisAddressData('서울특별시 강북구 미아동 701-28', {
            getPNUFromAddress: async () => {
                throw new Error('VWORLD_API_KEY is not configured.');
            },
            generatePNUFromAddress: async () => ({
                pnu: '1130510100107010028',
                sido: '서울특별시',
                sigungu: '강북구',
                dong: '미아동',
                bjdCode: '1130510100',
                mainNum: '701',
                subNum: '28',
            }),
        });

        assert.deepEqual(resolved, {
            pnu: '1130510100107010028',
            x: null,
            y: null,
            source: 'parsed',
        });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
