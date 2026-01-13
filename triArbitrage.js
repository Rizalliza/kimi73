
'use strict';

const { D, normalizeType, normalizeDex, shortMint, shortAddr, atomicToHuman } = require('./../utils/_utils');
//const sdk = require('@raydium-io/raydium-sdk', './@meteora-ag/dlmm',); // Broken import
const DLMMAdapter = require('./Q_dlmm');
const { CLMMAdapter } = require('./Q_clmm.fixed');
const { CPMMAdapter } = require('./Q_cpmm.fixed');
const { PublicKey, Keypair, Connection } = require('@solana/web3.js'); // Add imports
const { buildFlashloanTx } = require('../flash/flashloanSwapInstructions.fixed.js');
const { executeRoute } = require('../flash/swapExecutor.fixed.js');
const { symbol } = require('zod');

// Add Flashloan Configuration
// NOTE: In production, load this from environment variables or a secure vault
const PAYER_KEYPAIR = process.env.PAYER_KEYPAIR
    ? Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.PAYER_KEYPAIR)))
    : null; // Warning: Will fail if execution is attempted without a keypair

const FLASHLOAN_OPTS = {
    skipPreflight: true, // often necessary for arb
    maxRetries: 0,       // arb is time-sensitive
    skipConfirm: true    // fire and forget
};

// Mock SDK Wrapper
const sdk = {
    getStats: () => ({}),
    resetStats: () => { },
    quote: async (pool, inputMint, amountInAtomic) => {
        try {
            const type = normalizeType(pool);
            let AdapterClass;

            if (type === 'dlmm') AdapterClass = DLMMAdapter;
            else if (type === 'clmm') AdapterClass = CLMMAdapter;
            else if (type === 'cpmm' || type === 'amm') AdapterClass = CPMMAdapter;
            else AdapterClass = CPMMAdapter;

            const swapForY = (inputMint === pool.baseMint);

            // Use a default connection if none provided in context (this mock sdk doesn't have access to context connection easily without passing it)
            // But we can try to use a dummy or the one from pool if attached?
            // For now, instantiate with a placeholder. The adapters in Q_*.js might need a real connection for init().
            // If they fail, we return null, and simulateLeg falls back to math.
            const connection = new Connection("https://api.mainnet-beta.solana.com");

            const adapter = new AdapterClass(connection, pool.poolAddress || pool.address, pool);

            // Wrap init in try-catch to avoid crashing on network error
            try {
                await adapter.init();
            } catch (err) {
                // console.warn(`SDK Init failed for ${type} ${pool.poolAddress}: ${err.message}. Falling back.`);
                return null;
            }

            const quote = await adapter.quoteExactIn({
                inAmountLamports: amountInAtomic,
                swapForY
            });

            if (!quote || !quote.success) return null;

            return {
                dyAtomic: quote.outAmountRaw,
                priceImpactPct: (quote.priceImpact * 100).toString(),
                feeRate: quote.fee,
                binArrays: quote.binArrays || []
            };

        } catch (e) {
            // console.error("SDK Quote Error:", e);
            return null;
        }
    }
};

async function fetchDecimals(connection, mint) {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const dec = info?.value?.data?.parsed?.info?.decimals;
    if (typeof dec !== 'number') throw new Error(`decimals not found for mint ${mint}`);
    return dec;
}

async function ensurePoolSideDecimals(pool, side, connection) {
    const mintKey = side === 'base' ? 'baseMint' : 'quoteMint';
    const decKey = side === 'base' ? 'baseDecimals' : 'quoteDecimals';

    if (pool[decKey] == null || Number(pool[decKey]) === 0) {
        pool[decKey] = await fetchDecimals(connection, pool[mintKey]);
    } else {
        pool[decKey] = Number(pool[decKey]); // normalize in case it's a string
    }
    return pool[decKey];
}

// Return decimals for the leg's input mint; auto-fill if missing.
async function inputDecimals(pool, inputMint, connection) {
    if (inputMint === pool.baseMint) return ensurePoolSideDecimals(pool, 'base', connection);
    if (inputMint === pool.quoteMint) return ensurePoolSideDecimals(pool, 'quote', connection);
    return null; // the pool doesn't even contain that mint (shouldn't happen if orientation is correct)
}

// Keep your guards loud and descriptive
const BN10 = (d) => {
    if (d == null || Number.isNaN(Number(d))) throw new Error(`BN10: missing/invalid decimals (${d})`);
    return BigInt(10) ** BigInt(Number(d));
};
function toAtomicHuman(amountHuman, decimals) {
    if (decimals == null) throw new Error('toAtomicHuman: decimals missing');
    const scale = BigInt(10) ** BigInt(decimals);
    const whole = BigInt(Math.floor(amountHuman));
    const frac = amountHuman - Math.floor(amountHuman);
    const fracAtomic = BigInt(Math.round(frac * Number(scale)));
    return whole * scale + fracAtomic;
}

const toHuman = (amt, dec) => {
    if (dec == null) throw new Error(`toHuman: decimals missing`);
    return Number(amt) / Number(BN10(dec));
};

function short(s) {
    if (typeof s !== 'string') return '';
    return s.slice(0, 6) + '..' + s.slice(-4);
}

function humanToAtomic(dxHuman, decimals) {
    const scale = BigInt(10) ** BigInt(decimals);
    const whole = BigInt(Math.floor(dxHuman));
    const frac = dxHuman - Math.floor(dxHuman);
    const fracAtomic = BigInt(Math.round(frac * Number(scale)));
    return whole * scale + fracAtomic;
}

const dlmmOnly = allPools.filter(p => {
    const t = String(p.type || p.poolType || '').toLowerCase();
    const d = String(p.dex || '').toLowerCase();
    const dt = String(p.dexType || '').toUpperCase();
    return t === 'dlmm' || d === 'meteora' || dt === 'METEORA_DLMM';
});

async function solveTriangleOrientation(pools) {

    const [p1, p2, p3] = pools;
    function tryStart(startMint) {
        let curr = startMint; const inMints = [];
        if (curr === p1.baseMint) { inMints[0] = p1.baseMint; curr = p1.quoteMint; }
        else if (curr === p1.quoteMint) { inMints[0] = p1.quoteMint; curr = p1.baseMint; }
        else return null;
        if (curr === p2.baseMint) { inMints[1] = p2.baseMint; curr = p2.quoteMint; }
        else if (curr === p2.quoteMint) { inMints[1] = p2.quoteMint; curr = p2.baseMint; }
        else return null;
        if (curr === p3.baseMint) { inMints[2] = p3.baseMint; curr = p3.quoteMint; }
        else if (curr === p3.quoteMint) { inMints[2] = p3.quoteMint; curr = p3.baseMint; }
        else return null;
        if (curr !== startMint) return null;
        return { startMint, inMints };
    }
    return tryStart(p1.baseMint) || tryStart(p1.quoteMint);
}

async function validateTriangle(pools) {
    const triangle = await solveTriangleOrientation(pools);
    if (!triangle) throw new Error('Invalid Triangle Orientation');
    return triangle;
}


function computeLegMetrics(pool, inputMint, dxAtomic, dyAtomic) {
    const dirXY = inputMint === pool.baseMint;
    const inDec = dirXY ? pool.baseDecimals : pool.quoteDecimals;
    const outDec = dirXY ? pool.quoteDecimals : pool.baseDecimals;
    `
        const dxH = Number(dxAtomic) / Number(BN10(inDec));`
    const dyH = Number(dyAtomic) / Number(BN10(outDec));
    const execPx = dyH / Math.max(dxH, 1e-18);
    const feeBps = Math.round((pool.feeRate || 0) * 1e4);

    // mid price in SAME units as execPx
    let midPx = null;
    if ((pool.type === 'cpmm' || pool.poolType === 'cpmm') && pool.xReserve && pool.yReserve) {
        const xH = Number(pool.xReserve) / Number(BN10(pool.baseDecimals));
        const yH = Number(pool.yReserve) / Number(BN10(pool.quoteDecimals));
        midPx = dirXY ? (yH / xH) : (xH / yH);
    } else if (pool.midPrice) {
        const midYperX = Number(pool.midPrice);
        midPx = dirXY ? midYperX : (midYperX > 0 ? 1 / midYperX : null);
    }

    let slipVsMidBps = null, impactBps = null;
    if (midPx && midPx > 0) {
        const slip = ((execPx / midPx) - 1) * 1e4;
        slipVsMidBps = slip;
        impactBps = feeBps != null ? (slip - feeBps) : slip;
    }

    return {
        dex: pool.dex || pool.type,
        pool: short(pool.address || pool.poolAddress),
        dir: dirXY ? 'X->Y' : 'Y->X',
        execPx, feeBps,
        midPx, impactBps, slipVsMidBps,
        inAtomic: dxAtomic, outAtomic: dyAtomic,
    };
}
// Stats tracking
let stats = {
    sdkCalls: 0,
    sdkSuccess: 0,
    mathCalls: 0,
    mathSuccess: 0,
    failures: 0
};

/**
 * Simulate a single swap leg
 * @param {Object} params
 * @param {Object} params.pool - Pool object
 * @param {string} params.inputMint - Input token mint
 * @param {string} params.outputMint - Output token mint
 * @param {string} params.dxAtomic - Input amount in atomic units
 * @param {boolean} params.preferSdk - Prefer SDK over math (default true)
 * @param {boolean} params.log - Enable logging
 * @returns {Promise<Object>} { ok, dyAtomic, via, priceImpactPct, ... }
 */


async function simulateLeg({ pool, inputMint, outputMint, dxAtomic, preferSdk = true, log = false, Connection = null }) {
    const type = normalizeType(pool);
    const dex = normalizeDex(pool);
    const dxA = D(dxAtomic).floor();

    if (dxA.lte(0)) {
        return { ok: false, reason: 'dxAtomic <= 0' };
    }

    const sdkAvailable = await sdk.quote(
        pool,
        inputMint,
        dxA.toString(),
        outputMint
    );
    //const mathAvailable = canSimulateMath(pool);

    // Try SDK first for DLMM, Whirlpool, CLMM, or if explicitly preferred
    if (preferSdk && sdkAvailable) {
        stats.sdkCalls++;

        const quote = await sdk.quote(pool, inputMint, dxA.toString());

        if (quote?.dyAtomic && D(quote.dyAtomic).gt(0)) {
            stats.sdkSuccess++;

            const inDec = pool.baseDecimals || 9;
            const outDec = pool.quoteDecimals || 6;
            const dxHuman = atomicToHuman(dxA, inDec);
            const dyHuman = atomicToHuman(D(quote.dyAtomic), outDec);

            if (log) {
                console.log(`[sim] ${shortMint(inputMint)} → ${shortMint(outputMint)} | ${shortAddr(pool.poolAddress)} | SDK-${type}`);
                console.log(`      dx=${dxHuman.toFixed(6)} dy=${dyHuman.toFixed(6)}`);
            }

            return {
                ok: true,
                via: `sdk-${type}`,
                poolAddress: pool.poolAddress,
                type,
                dex,
                dxAtomic: dxA.toString(),
                dxHuman: dxHuman.toString(),
                dyAtomic: quote.dyAtomic,
                dyHuman: dyHuman.toString(),
                inDecimals: inDec,
                outDecimals: outDec,
                priceImpactPct: quote.priceImpactPct || '0',
                feeRate: quote.feeRate?.toString() || pool.fee?.toString() || '0.003',
                isSdkVerified: true,
                // Pass through bin arrays for execution
                binArrays: quote.binArrays || quote.binArraysPubkey
            };
        }
        // If SDK fails for specific complex types, we might want to return failure or fallthrough
        // For simple types, fallthrough to math is fine.
        if (type === 'whirlpool' || type === 'clmm') {
            stats.failures++;
            return { ok: false, reason: `${type}-sdk-failed`, poolAddress: pool.poolAddress };
        }
    }
    // Try CPMM math (for cpmm pools, or dlmm fallback)
    const mathAvailable = false; // DLMM-first: disable math fallback entirely
    // const mathAvailable = Boolean(pool?.type === 'cpmm' && pool?.xReserve && pool?.yReserve);

    if (mathAvailable) {
        if (log) console.log(`[sim] ${shortMint(inputMint)} → ${shortMint(outputMint)} | ${shortAddr(pool.poolAddress)} | math`);

        stats.mathCalls++;

        const result = simulateCpmm({
            pool,
            inputMint,
            outputMint,
            dxAtomic: dxA.toString(),
            //applyDiscount: (type === 'dlmm') // 50% discount for DLMM approximation
        });

        if (result.ok) {
            stats.mathSuccess++;

            if (log) {
                const discountNote = result.isApproximation ? ` (${result.discountApplied}% discount)` : '';
                console.log(`[sim] ${shortMint(inputMint)} → ${shortMint(outputMint)} | ${shortAddr(pool.poolAddress)} | ${result.via}${discountNote}`);
                console.log(`      dx=${D(result.dxHuman).toFixed(6)} dy=${D(result.dyHuman).toFixed(6)} impact=${D(result.priceImpactPct).toFixed(4)}%`);
            }
            return {
                ...result,
                type,
                dex,
                isSdkVerified: false
            };
        }

        stats.failures++;
        return result;
    }
    // No simulation method available
    stats.failures++;
    return {
        ok: false,
        reason: `no-simulation-method: type=${type}, sdk=${sdkAvailable}, math=${mathAvailable}`,
        poolAddress: pool.poolAddress
    };
}

/**
 * @param {Object} params
 * @param {Object} params.pools - Array of 3 pools [poolAB, poolBC, poolCA]
 * @param {string} params.tokenA - Token A mint
 * @param {string} params.tokenB - Token B mint (intermediate)
 * @param {string} params.tokenC - Token C mint
 * @param {string} params.dxAtomic - Input amount of token A
 * @param {number} params.maxImpactPct - Max price impact per leg
 * @param {boolean} params.log - Enable logging
 * @param {boolean} params.execute - Execute if profitable
 * @param {Connection} params.connection - Connection required for execution
 * @returns {Promise<Object>} { ok, legs, profitPct, ... }
 */

async function simulateTriangularRoute({ pools, tokenA, tokenB, tokenC, dxAtomic, maxImpactPct = 5, log = false, execute = false, connection = null }) {

    pools[1], pools[2], pools[3] = pools;
    const dxA = D(dxAtomic).floor();
    // Validate triangle orientation
    const triangle = await validateTriangle(pools);
    const { startMint, inMints } = triangle;
    const [poolAB, poolBC, poolCA] = pools;
    const [inAB, inBC, inCA] = inMints;
    if (!pools || pools.length !== 3) {
        return { ok: false, reason: 'need-3-pools' };
    }
    if (![tokenA, tokenB, tokenC].every(t => typeof t === 'string')) {
        return { ok: false, reason: 'missing-mints' };
    }
    if (dxAtomic == null || Number.isNaN(Number(dxAtomic))) {
        return { ok: false, reason: 'missing-dx' };
    }
    if (maxImpactPct == null || Number.isNaN(maxImpactPct)) {
        return { ok: false, reason: 'missing-max-impact' };
    }


    const leg1 = await simulateLeg({
        pool: pools[0],
        inputMint: tokenA,
        outputMint: tokenB,
        dxAtomic: leg2.dyAtomic,
        preferSdk: true,
        log
    });

    const leg2 = await simulateLeg({
        pool: pools[1],
        inputMint: tokenB,
        outputMint: tokenC,
        dxAtomic: leg2.dyAtomic,
        preferSdk: true,
        log
    });

    const leg3 = await simulateLeg({
        pool: pools[2],
        inputMint: tokenC,
        outputMint: tokenA,
        dxAtomic: leg3.dyAtomic,
        preferSdk: true,
        log
    });
    return { ok: false, reason: 'need-3-pools' };

}


// Calculate profit
const outA = D(leg3.dyAtomic);
const profitA = outA.minus(dxA);
const profitPct = profitA.div(dxA).mul(100);

console.log(`simulateTriangularRoute called with:`);
console.log(` tokenA: ${symbol(tokenA)}, tokenB: ${symbol(tokenB)}, tokenC: ${symbol(tokenC)}`);
console.log(` dxAtomic: ${dxAtomic}, maxImpactPct: ${maxImpactPct}`);
console.log(` Leg 1: ${JSON.stringify(leg1, null, 2)}`);
console.log(` Leg 2: ${JSON.stringify(leg2, null, 2)}`);
console.log(` Leg 3: ${JSON.stringify(leg3, null, 2)}`);
console.log(`[SIM] Profit: ${profitPct.toFixed(4)}%`);
console.log(`[SIM] Legs:`);
console.log(` validateTriangle returned: ${JSON.stringify(triangle, null, 2)}`)

// Check for unrealistic profit (likely bad data)
if (!profitPct.isFinite() || profitPct.abs().gt(50)) {
    return {
        ok: false,
        reason: 'unrealistic-profit',
        profitPct: profitPct.toString(),
        legs: [leg1, leg2, leg3]
    };
}

const isSdkVerified = leg1.isSdkVerified || leg2.isSdkVerified || leg3.isSdkVerified;

const result = {
    ok: true,
    legs: [leg1, leg2, leg3],
    tokenA: symbol(tokenA),
    tokenB: symbol(tokenB),
    tokenC: symbol(tokenC),
    dxAtomic: dxA.toString(),
    outAtomic: outA.toString(),
    profitAtomic: profitA.toString(),
    profitPct: profitPct.toString(),
    isSdkVerified,
    pools: pools.map(p => p.poolAddress),
    types: pools.map(p => normalizeType(p)),
    vias: [leg1.via, leg2.via, leg3.via]
};


// HOOK: Execution Trigger
if (execute && D(profitPct).gt(0) && connection && PAYER_KEYPAIR) {
    try {
        console.log(`[EXEC] Attempting execution for profit ${profitPct.toFixed(4)}%...`);
        const txSig = await executeFlashloan({
            connection,
            payer: PAYER_KEYPAIR,
            legs: [
                { ...leg1, inputMint: tokenA, outputMint: tokenB, poolAddress: poolAB.address || poolAB.poolAddress },
                { ...leg2, inputMint: tokenB, outputMint: tokenC, poolAddress: poolBC.address || poolBC.poolAddress },
                { ...leg3, inputMint: tokenC, outputMint: tokenA, poolAddress: poolCA.address || poolCA.poolAddress }
            ],
            loanAmount: dxA.toString(),
            loanMint: tokenA
        });
        result.txSignature = txSig;
        console.log(`[EXEC] SUCCESS: ${txSig}`);
    } catch (e) {
        console.error(`[EXEC] FAILED: ${e.message}`);
        result.execError = e.message;

    } if (execute && (!connection || !PAYER_KEYPAIR)) {
        console.warn("[EXEC] Execution requested but missing connection or payer keypair");
    }


    return result;
}

/**
 * Executes a flashloan transaction based on the simulated legs
 */
async function executeFlashloan({ connection, payer, legs, loanAmount, loanMint }) {
    if (!connection || !payer || !legs || legs.length !== 3) {


        const txSig = await executeRoute({
            connection,
            payerKeypair: payer,
            routeLegs: legs,
            loanMint,
            loanAmountAtomic: loanAmount,
            flashloanInstructionBuilder: async () => { },
            opts: FLASHLOAN_OPTS
        });
        return txSig;
    }
    if (!connection || !payer || !legs || legs.length !== 3) {
        throw new Error("Invalid parameters for flashloan execution");
    }

    // 1. Prepare Route Legs for Builder
    // The builder expects: { inputMint, outputMint, amountInAtomic, minOutAtomic, poolAddress, dexType, binArrays... }
    const routeLegs = legs.map(leg => ({
        inputMint: leg.inputMint,
        outputMint: leg.outputMint,
        amountInAtomic: leg.dxAtomic,
        minOutAtomic: leg.dyAtomic, // Strict setting: min out is what we simulated
        poolAddress: leg.poolAddress,
        dexType: resolveDexType(leg), // Map 'via'/'type'/'dex' to 'dexType'
        binArrays: leg.binArrays // Pass binArrays if available (for DLMM)
    }));

    // 2. Build Transaction
    // NOTE: You need a flashloanInstructionBuilder (e.g., from Solend or another provider)
    // For now, we assume a placeholder or that you import a specific one.
    // As the original file didn't include a specific flashloan provider, I'll assume standard structure.

    // Placeholder for actual flashloan builder integration
    const flashloanBuilder = async ({ callbackIxs }) => {
        // In a real scenario, this wraps the callbackIxs in a flashloan instruction
        // returning the instruction.
        // For testing WITHOUT actual flashloans (atomic swap), just return null or throw.
        throw new Error("Flashloan provider not configured in triArbitrage.js");
    };

    const { tx, signers } = await buildFlashloanTx({
        connection,
        payerKeypair: payer,
        loanMint,
        loanAmount: loanAmount,   // correct key
        route: routeLegs,         // correct key
        flashloanInstructionBuilder: flashloanBuilder,
        borrowerProgramId: SOME_PROGRAM_ID, // if your builder needs it

        opts: { slippageBps: 500 }
    });

    // 3. Send & Confirm
    // Using simple sendTransaction for now; typically use a Jito bundle or similar for MEV
    tx.sign(...signers);
    const rawTx = tx.serialize();

    const sig = await connection.sendRawTransaction(rawTx, FLASHLOAN_OPTS);
    return sig;
}


function getStats() {
    const sdkStats = sdk.getStats();
    return {
        ...stats,
        sdkDetail: sdkStats
    };
}
function resetStats() {
    stats = {
        sdkCalls: 0,
        sdkSuccess: 0,
        mathCalls: 0,
        mathSuccess: 0,
        failures: 0
    };
    sdk.resetStats();
}

function resolveDexType(leg) {
    // 1. Try explicit type from simulation
    const type = leg.type || '';
    const via = leg.via || '';
    const dex = leg.dex || '';

    if (type === 'dlmm' || via.includes('dlmm')) return 'METEORA_DLMM';
    if (type === 'whirlpool' || via.includes('whirlpool')) return 'ORCA_WHIRLPOOL';
    if (type === 'clmm' || via.includes('clmm')) return 'RAYDIUM_CLMM';

    // 2. CPMM / Standard AMM
    if (type === 'cpmm' || via.includes('cpmm') || via.includes('amm')) {
        if (dex === 'raydium') return 'RAYDIUM_CPMM';
        // If it's Meteora but not DLMM (unlikely given dlmm check above covers most), 
        // fallback or handle if needed. For now assume Raydium for standard CPMM.
        return 'RAYDIUM_CPMM';
    }

    return 'UNKNOWN';
}

module.exports = {
    simulateLeg,
    simulateTriangularRoute,
    getStats,
    resetStats
};

const TOKENS = {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

// node engine/triArbitrage.js --tokenA SOL --tokenB USDC --tokenC MNGO --amount 100000000