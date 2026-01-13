'use strict';

const fs = require('fs');
const path = require('path');

// ---- permissive pool loader (unchanged)
function loadPoolsFromAny(raw) {
    const arr = Array.isArray(raw) ? raw : (raw?.pools || raw?.data || []);
    const out = [];

    const readReserve = (v) => {
        if (v == null) return { atomic: undefined, human: undefined };
        const s = String(v).trim();
        if (s === '') return { atomic: undefined, human: undefined };
        if (s.includes('.')) return { atomic: undefined, human: s }; // human decimal
        try { return { atomic: BigInt(s), human: undefined }; }
        catch { return { atomic: undefined, human: s }; }
    };

    for (const it of arr) {
        const t = String(it?.type || it?.poolType || it?.ammType || '').toLowerCase();
        if (!t) continue;

        if (t.includes('cpmm') || t.includes('dlmm')) {
            const xr = readReserve(it?.xReserve ?? it?.reserve_x ?? it?.x_reserve);
            const yr = readReserve(it?.yReserve ?? it?.reserve_y ?? it?.y_reserve);

            out.push({
                type: t.includes('cpmm') ? 'cpmm' : 'dlmm',
                dex: it?.dex || (t.includes('dlmm') ? 'meteora' : 'raydium'),
                address: String(it?.address || it?.poolAddress || it?.id || ''),
                baseMint: String(it?.baseMint || it?.mint_x || it?.tokenA || it?.mintA || ''),
                quoteMint: String(it?.quoteMint || it?.mint_y || it?.tokenB || it?.mintB || ''),
                baseDecimals: Number(it?.baseDecimals ?? it?.decimalsA ?? 0),
                quoteDecimals: Number(it?.quoteDecimals ?? it?.decimalsB ?? 0),
                feeRate: Number(it?.feeRate ?? it?.fee ?? (it?.feeBps != null ? Number(it.feeBps) / 1e4 : 0)),
                feeBps: Number(it?.feeBps ?? (it?.feeRate != null ? Math.round(Number(it.feeRate) * 1e4) : 0)),

                // reserves (atomic if integer; else keep human as string)
                xReserve: xr.atomic,
                yReserve: yr.atomic,
                xReserveHuman: xr.human,   // string like "33469.558628029"
                yReserveHuman: yr.human,

                midPrice: it?.midPrice || it?.price || undefined,
            });
        }
    }
    return out;
}

module.exports = { loadPoolsFromAny };
