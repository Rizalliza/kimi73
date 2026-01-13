// _runner_triArbitrage.js
const fs = require('fs');
const path = require('path');
const { simulateTriangularRoute } = require('./engine/triArbitrage');

// Configuration
const POOLS_FILE = './ALL_e.json';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Load Pools
console.log(`Loading pools from ${POOLS_FILE}...`);
if (!fs.existsSync(POOLS_FILE)) {
    console.error(`File ${POOLS_FILE} not found.`);
    process.exit(1);
}
let poolsData;
try {
    poolsData = JSON.parse(fs.readFileSync(POOLS_FILE, 'utf8'));
} catch (e) {
    console.error(`Failed to parse JSON: ${e.message}`);
    process.exit(1);
}

const pools = Array.isArray(poolsData) ? poolsData : (poolsData.pools || []);
console.log(`Loaded ${pools.length} pools.`);

// Helpers
function getOtherToken(pool, token) {
    return pool.baseMint === token ? pool.quoteMint : pool.baseMint;
}

// Strategy:
// 1. Find all SOL/USDC pools (Leg 1)
// 2. Find all USDC/X pools (Leg 2)
// 3. Find all X/SOL pools (Leg 3)
// Pick one triangle and run.

console.log('Searching for a valid triangle (SOL -> USDC -> X -> SOL)...');

const leg1Pools = pools.filter(p =>
    (p.baseMint === SOL_MINT && p.quoteMint === USDC_MINT) ||
    (p.baseMint === USDC_MINT && p.quoteMint === SOL_MINT)
);

if (leg1Pools.length === 0) {
    console.error('No SOL/USDC pools found.');
    process.exit(1);
}

// We just need one working example.
// Let's iterate through leg1 pools, find leg2 pools, then leg3.
let triangle = null;

// Sort leg1 pools by liquidity/reserves if possible to get a "good" one, or just take first.
// Heuristic: check xReserve/yReserve exist.
const validLeg1 = leg1Pools.filter(p => p.xReserve || p.liquidity);
if (validLeg1.length === 0) {
    console.log('Warning: No SOL/USDC pools with obvious reserves. Trying all.');
}
const startPools = validLeg1.length > 0 ? validLeg1 : leg1Pools;

searchLoop:
for (const pool1 of startPools) {
    // Determine direction for Leg 1: SOL -> USDC

    // Leg 2: USDC -> X
    // Find pools containing USDC (but not SOL)
    const candidatesLeg2 = pools.filter(p =>
        (p.baseMint === USDC_MINT || p.quoteMint === USDC_MINT) &&
        (p.baseMint !== SOL_MINT && p.quoteMint !== SOL_MINT)
    );

    for (const pool2 of candidatesLeg2) {
        const tokenX = getOtherToken(pool2, USDC_MINT);

        // Leg 3: X -> SOL
        const pool3 = pools.find(p =>
            (p.baseMint === tokenX && p.quoteMint === SOL_MINT) ||
            (p.baseMint === SOL_MINT && p.quoteMint === tokenX)
        );

        if (pool3) {
            triangle = {
                pools: [pool1, pool2, pool3],
                tokenA: SOL_MINT,
                tokenB: USDC_MINT,
                tokenC: tokenX
            };
            break searchLoop;
        }
    }
}

if (!triangle) {
    console.error('Could not find a complete triangle.');
    process.exit(1);
}

console.log('Triangle found:');
console.log(`  Leg 1 (SOL->USDC): ${triangle.pools[0].poolAddress} (${triangle.pools[0].type})`);
console.log(`  Leg 2 (USDC->${triangle.tokenC}): ${triangle.pools[1].poolAddress} (${triangle.pools[1].type})`);
console.log(`  Leg 3 (${triangle.tokenC}->SOL): ${triangle.pools[2].poolAddress} (${triangle.pools[2].type})`);

// Run Simulation
async function main() {
    const inputAmount = '10000000000'; // 10 SOL
    console.log(`\nSimulating with input: ${inputAmount} atomic units (1 SOL)...`);

    try {
        const result = await simulateTriangularRoute({
            pools: triangle.pools,
            tokenA: triangle.tokenA,
            tokenB: triangle.tokenB,
            tokenC: triangle.tokenC,
            dxAtomic: inputAmount,
            log: true
        });

        console.log('\nSimulation Result:');
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('Simulation failed:', err);
    }
}

main();

// node _runner_triArbitrage.js 10  pools.json
