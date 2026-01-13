#!/usr/bin/env node
'use strict';
/**
 * _reserveEnricher.js - Reserve Enrichment for Pools
 * 
 * Takes metadata pools and enriches them with fresh reserves from RPC.
 * Produces "math-ready" pools for the arbitrage engine.
 * 
 * CRITICAL INVARIANT:
 *   xVault/xReserve MUST correspond to baseMint/baseDecimals
 *   yVault/yReserve MUST correspond to quoteMint/quoteDecimals
 * 
 * Usage:
 *  node _enrich_reserves.js --input=pools_canonical.json --output=custom_pools_enriched.json --sdk --minLp=750_000 
 * 
 * --output=pools_enriched_sdk.json --output= --force-refresh
 *  
 *
 *   node _enrich_reserves.js --input= --output= custom_pools_enriched.json custom_pools_READY.json
 *
 * Example usage:
 *    node _reserveEnricher.js output/shape_triangle_cpmm.json --output=output/shape_TriangleCPMM_Enrich.json
 * 
 * Options:
 *   --output=<file>    Output file (default: pools_enriched.json)
 *   --rpc=<url>        RPC endpoint
 *   --batch-size=<n>   Batch size for RPC calls (default: 100)
 * 
 * node -e "
const pools=require('./poolsEnriched/metaEnriched.json');
const byType={}; const withVaults={}; const withAtomicRes={};
for (const p of pools){
  const t=(p.type||'').toLowerCase(); byType[t]=(byType[t]||0)+1;
  const v=!!(p.vaults&&p.vaults.xVault&&p.vaults.yVault); if(v) withVaults[t]=(withVaults[t]||0)+1;
  const xr=typeof p.xReserve==='string'||typeof p.xReserve==='number';
  const yr=typeof p.yReserve==='string'||typeof p.yReserve==='number';
  if(xr&&yr) withAtomicRes[t]=(withAtomicRes[t]||0)+1;
}
console.log({total:pools.length, byType, withVaults, withReservesFields:withAtomicRes});


 node poolfetch_meta.js --in ./custom_pools.json outpools=custom_pools_READY.json --amount=10 --sdk --minLp=1500_000  --out ./mData_enrich.json --minUsdc --includeSOL --keepRaw

export ALCHEMY_RPC_URL = "https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy"
node _enrich_reserves.js --input /in/sampleShapePool.json --output= /custom_enriched.json --rpcUrl= https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy --force-fresh



 * 
 * cat > pools_enriched.json <<'EOF'

[
  {
  "poolAddress": "...",
  "dex": "raydium",
  "type": "cpmm",
  "baseMint": "...",
  "quoteMint": "...",
  "baseDecimals": 9,
  "quoteDecimals": 6,
  "fee": 0.0025,
  "vaults": { "xVault": "TOKEN_ACCOUNT_A", "yVault": "TOKEN_ACCOUNT_B" }
},
{
  "poolAddress": "...",
  "dex": "meteora",
  "type": "dlmm",
  "baseMint": "...",
  "quoteMint": "...",
  "baseDecimals": 9,
  "quoteDecimals": 6,
  "fee": 0.003,
  "xVaults": "..."
  "YVaults": "..."
  "binStep": 80
},
{
  "poolAddress": "...",
  "dex": "orca",
  "type": "whirlpool",
  "baseMint": "...",
  "quoteMint": "...",
  "baseDecimals": 9,
  "quoteDecimals": 6,
  "fee": 0.003,
  "tickSpacing": 64
},
{
  "poolAddress": "...",
  "dex": "raydium",
  "type": "clmm",
  "baseMint": "...",
  "quoteMint": "...",
  "baseDecimals": 9,
  "quoteDecimals": 6,
  "fee": 0.0005,
  "tickSpacing": 64
}
]  



EOF

 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const { hydratePoolsOnDemand } = require('./utils/example_reserveFetcher_usage');


// ============================================================================
// CONSTANTS
// ============================================================================

const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiter state
 */
const rateLimiter = {
  lastCall: 0,
  minDelay: 50,
  backoffUntil: 0,
  consecutive429s: 0
};

/**
 * Wait respecting rate limits and backoff
 */
async function waitForRateLimit() {
  const now = Date.now();

  if (rateLimiter.backoffUntil > now) {
    const waitMs = rateLimiter.backoffUntil - now;
    console.warn(`[enricher] Rate limited. Backing off ${waitMs}ms`);
    await sleep(waitMs);
  }

  const elapsed = now - rateLimiter.lastCall;
  if (elapsed < rateLimiter.minDelay) {
    await sleep(rateLimiter.minDelay - elapsed);
  }

  rateLimiter.lastCall = Date.now();
}

function handle429() {
  rateLimiter.consecutive429s++;
  const backoff = Math.min(60000, 250 * Math.pow(2, Math.min(10, rateLimiter.consecutive429s)));
  rateLimiter.backoffUntil = Date.now() + backoff;
  console.warn(`[enricher] Hit 429. Backing off ${backoff}ms (attempt ${rateLimiter.consecutive429s})`);
}

function handleSuccess() {
  rateLimiter.consecutive429s = 0;
}

/**
 * Parse SPL Token Account data to extract balance
 * SPL Token Account layout: amount is u64 at offset 64
 */
function parseSplTokenAmount(data) {
  if (!data || !Buffer.isBuffer(data) || data.length < 72) {
    return null;
  }

  try {
    // Amount is at bytes 64-72 (u64 little-endian)
    const amount = data.readBigUInt64LE(64);
    return amount.toString();
  } catch (e) {
    return null;
  }
}

const pools = require('./custom_pools.json');

/**
 * Extract vault addresses from pool (handles various field names)
 */
function getVaultAddresses(pool) {
  // Try various field names used by different DEXes
  const xVault =
    pool.vaults?.xVault ||
    pool.vaults?.aVault ||
    pool.vaultX ||
    pool.vaultA ||
    pool.tokenVaultA ||
    pool.reserveXVault ||
    pool.raw?.reserve_x ||
    pool.raw?.vault_x ||
    pool.raw?.vault_a ||
    pool._raw?.reserve_x ||
    pool._raw?.vaultA ||
    null;

  const yVault =
    pool.vaults?.yVault ||
    pool.vaults?.bVault ||
    pool.vaultY ||
    pool.vaultB ||
    pool.tokenVaultB ||
    pool.reserveYVault ||
    pool.raw?.reserve_y ||
    pool.raw?.vault_y ||
    pool.raw?.vault_b ||
    pool._raw?.reserve_y ||
    pool._raw?.vaultB ||
    null;

  return { xVault, yVault };
}

const byType = {}; const withVaults = {}; const withAtomicRes = {};
for (const p of pools) {
  const t = (p.type || '').toLowerCase(); byType[t] = (byType[t] || 0) + 1;
  const v = !!(p.vaults && p.vaults.xVault && p.vaults.yVault); if (v) withVaults[t] = (withVaults[t] || 0) + 1;
  const xr = typeof p.xReserve === 'string' || typeof p.xReserve === 'number';
  const yr = typeof p.yReserve === 'string' || typeof p.yReserve === 'number';
  if (xr && yr) withAtomicRes[t] = (withAtomicRes[t] || 0) + 1;
}
/**
 * Check if pool already has valid reserves
 * Handles both atomic (integer) and human (decimal) formats
 */
function hasValidReserves(pool) {
  try {
    const x = parseFloat(pool.xReserve || 0);
    const y = parseFloat(pool.yReserve || 0);
    return x > 0 && y > 0 && isFinite(x) && isFinite(y);
  } catch {
    return false;
  }
}

// ============================================================================
// BATCH FETCHER
// ============================================================================

/**
 * Fetch multiple accounts in batches with rate limiting
 */
async function fetchAccountsBatched(connection, pubkeys, batchSize = 100) {
  const results = new Array(pubkeys.length).fill(null);
  let retries = 0;
  const maxRetries = 3;

  for (let i = 0; i < pubkeys.length; i += batchSize) {
    const batch = pubkeys.slice(i, i + batchSize);
    const validBatch = [];
    const validIndices = [];

    // Filter out null pubkeys
    for (let j = 0; j < batch.length; j++) {
      if (batch[j]) {
        validBatch.push(batch[j]);
        validIndices.push(i + j);
      }
    }

    if (validBatch.length === 0) continue;

    let success = false;
    retries = 0;

    while (!success && retries < maxRetries) {
      try {
        await waitForRateLimit();
        const accounts = await connection.getMultipleAccountsInfo(validBatch);

        for (let j = 0; j < accounts.length; j++) {
          results[validIndices[j]] = accounts[j];
        }

        handleSuccess();
        success = true;
      } catch (e) {
        if (e.message?.includes('429')) {
          handle429();
          retries++;
          if (retries < maxRetries) {
            console.warn(`[enricher] Batch ${Math.floor(i / batchSize)}: 429 received. Retry ${retries}/${maxRetries}`);
          }
        } else {
          console.warn(`[enricher] Batch ${Math.floor(i / batchSize)} failed: ${e.message}`);
          break;
        }
      }
    }
  }

  return results;
}

// ============================================================================
// MAIN ENRICHER
// ============================================================================

/**
 * Enrich pools with fresh reserves from RPC
 * 
 * @param {Array} pools - Normalized pools from _poolFetcher
 * @param {Connection} connection - Solana RPC connection
 * @param {Object} options
 * @returns {Promise<Array>} Enriched pools
 */
async function enrichReserves(pools, connection, options = {}) {
  const { batchSize = 100, log = true } = options;

  if (log) {
    console.log(`[enricher] Starting reserve enrichment for ${pools.length} pools`);
  }

  // Build vault -> pool mapping
  const vaultMap = new Map(); // vaultAddress -> [{ pool, side: 'x' | 'y' }]
  const pubkeyList = [];
  const pubkeySet = new Set();
  const sdkPools = []; // Pools that need SDK hydration (missing vaults)

  for (const pool of pools) {
    // Skip if already has valid reserves and no refresh needed
    if (hasValidReserves(pool) && !options.forceRefresh) {
      pool.reserveSource = 'cache';
      pool.hasReserves = true;
      pool.isMathReady = true;
      continue;
    }

    const { xVault, yVault } = getVaultAddresses(pool);

    if (!xVault || !yVault) {
      // Check if this pool type can be handled by SDK
      const t = (pool.type || '').toLowerCase();
      if (t.includes('clmm') || t.includes('whirlpool') || t.includes('dlmm') || t.includes('concentrated')) {
        sdkPools.push(pool);
        continue;
      }

      pool.reserveSource = 'none';
      pool.hasReserves = false;
      pool.isMathReady = false;
      continue;
    }

    // Add X vault
    try {
      const xPubkey = new PublicKey(xVault);
      const xAddr = xPubkey.toBase58();

      if (!pubkeySet.has(xAddr)) {
        pubkeySet.add(xAddr);
        pubkeyList.push(xPubkey);
      }

      if (!vaultMap.has(xAddr)) vaultMap.set(xAddr, []);
      vaultMap.get(xAddr).push({ pool, side: 'x' });
    } catch (e) {
      // Invalid pubkey
    }

    // Add Y vault
    try {
      const yPubkey = new PublicKey(yVault);
      const yAddr = yPubkey.toBase58();

      if (!pubkeySet.has(yAddr)) {
        pubkeySet.add(yAddr);
        pubkeyList.push(yPubkey);
      }

      if (!vaultMap.has(yAddr)) vaultMap.set(yAddr, []);
      vaultMap.get(yAddr).push({ pool, side: 'y' });
    } catch (e) {
      // Invalid pubkey
    }
  }

  let freshCount = 0;
  let failedCount = 0;

  if (pubkeyList.length > 0) {
    if (log) {
      console.log(`[enricher] Fetching ${pubkeyList.length} vault accounts...`);
    }

    // Fetch all vault accounts
    const accounts = await fetchAccountsBatched(connection, pubkeyList, batchSize);

    // Process results
    for (let i = 0; i < pubkeyList.length; i++) {
      const account = accounts[i];
      const addr = pubkeyList[i].toBase58();
      const targets = vaultMap.get(addr) || [];

      if (!account?.data) {
        failedCount += targets.length;
        continue;
      }

      const amount = parseSplTokenAmount(account.data);
      if (amount === null) {
        failedCount += targets.length;
        continue;
      }

      // Update all pools that use this vault
      for (const { pool, side } of targets) {
        if (side === 'x') {
          pool.xReserve = amount;
        } else {
          pool.yReserve = amount;
        }
        pool.reserveSource = 'fresh';
        freshCount++;
      }
    }
  }

  // Handle SDK pools
  if (sdkPools.length > 0) {
    if (log) console.log(`[enricher] Attempting SDK hydration for ${sdkPools.length} pools missing vaults...`);
    try {
      const hydrated = await hydratePoolsOnDemand(connection, sdkPools, { ...options, log: log });

      // Merge results
      for (const hPool of hydrated) {
        // Find original pool object to update (references are shared)
        const original = sdkPools.find(p => p.poolAddress === hPool.poolAddress);
        if (original) {
          Object.assign(original, hPool);
          if (original.xReserve && original.yReserve) {
            freshCount++;
          } else {
            failedCount++;
          }
        }
      }
    } catch (e) {
      console.warn(`[enricher] SDK hydration failed: ${e.message}`);
      failedCount += sdkPools.length;
    }
  }

  // Final pass: mark all pools
  for (const pool of pools) {
    if (!pool.reserveSource) {
      pool.reserveSource = pool.xReserve && pool.yReserve ? 'partial' : 'none';
    }

    // Handle both atomic and human format reserves
    const x = parseFloat(pool.xReserve || 0);
    const y = parseFloat(pool.yReserve || 0);

    pool.hasReserves = x > 0 && y > 0 && isFinite(x) && isFinite(y);

    // Math readiness depends on pool type
    // CPMM/DLMM need reserves for math
    // CLMM/Whirlpool can use SDK without reserves
    const type = (pool.type || '').toLowerCase();
    if (type === 'cpmm' || type === 'dlmm' || 'whirlpool') {
      pool.isMathReady = pool.hasReserves;
    } else {
      // CLMM/Whirlpool - SDK can work without reserves
      pool.isMathReady = true;
    }
  }

  if (log) {
    console.log(`[enricher] Fresh reserves: ${freshCount} updated, ${failedCount} failed`);

    const withReserves = pools.filter(p => p.hasReserves).length;
    const mathReady = pools.filter(p => p.isMathReady).length;
    console.log(`[enricher] With reserves: ${withReserves}/${pools.length}`);
    console.log(`[enricher] Math ready: ${mathReady}/${pools.length}`);
  }

  return pools;
}

// ============================================================================
// POOL VALIDATOR
// ============================================================================

/**
 * Validate and filter pools for engine use
 */
function validatePools(pools, options = {}) {
  const { log = true } = options;

  const valid = [];
  const issues = {
    noAddress: 0,
    noMints: 0,
    noDecimals: 0,
    noReserves: 0,
  };

  for (const pool of pools) {
    // Must have address
    if (!pool.poolAddress) {
      issues.noAddress++;
      continue;
    }

    // Must have mints
    if (!pool.baseMint || !pool.quoteMint) {
      issues.noMints++;
      continue;
    }

    // Must have decimals
    if (pool.baseDecimals === undefined || pool.quoteDecimals === undefined) {
      issues.noDecimals++;
      continue;
    }

    // For CPMM/DLMM, must have reserves
    const type = (pool.type || '').toLowerCase();
    if ((type === 'cpmm' || type === 'dlmm') && !pool.hasReserves) {
      issues.noReserves++;
      continue;
    }

    valid.push(pool);
  }

  if (log) {
    console.log(`[validator] Valid pools: ${valid.length}/${pools.length}`);
    if (issues.noAddress > 0) console.log(`  - No address: ${issues.noAddress}`);
    if (issues.noMints > 0) console.log(`  - No mints: ${issues.noMints}`);
    if (issues.noDecimals > 0) console.log(`  - No decimals: ${issues.noDecimals}`);
    if (issues.noReserves > 0) console.log(`  - No reserves (CPMM/DLMM/whirlpools): ${issues.noReserves}`);
  }

  return valid;
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(args) {
  const opts = {
    input: null,
    output: 'pools_enriched.json',
    rpcUrl: process.env.RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy',
    batchSize: 100,
    forceRefresh: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');

      switch (key) {
        case 'output':
          opts.output = val;
          break;
        case 'rpc':
          opts.rpcUrl = val;
          break;
        case 'batch-size':
          opts.batchSize = parseInt(val);
          break;
        case 'force-refresh':
          opts.forceRefresh = true;
          break;
      }
    } else if (!arg.startsWith('-') && !opts.input) {
      opts.input = arg;
    }
  }

  return opts;
}

async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (!opts.input) {
    console.log('Usage: node _reserveEnricher.js <input.json> [options]');
    console.log('\nOptions:');
    console.log('  --output=<file>      Output file (default: pools_enriched.json)');
    console.log('  --rpc=<url>          RPC endpoint');
    console.log('  --batch-size=<n>     Batch size for RPC calls (default: 100)');
    console.log('  --force-refresh      Refresh all reserves even if cached');
    process.exit(1);
  }

  console.log('═'.repeat(60));
  console.log('POOL RESERVE ENRICHER');
  console.log('═'.repeat(60));

  // Load input pools
  const inputPath = path.resolve(opts.input);
  console.log(`\n📦 Loading pools from: ${inputPath}`);

  const content = fs.readFileSync(inputPath, 'utf8');
  let pools = JSON.parse(content);

  // Handle various JSON formats
  if (!Array.isArray(pools)) {
    if (pools.pools) pools = pools.pools;
    else if (pools.data) pools = pools.data;
    else pools = Object.values(pools);
  }

  console.log(`[enricher] Loaded ${pools.length} pools`);

  // Connect to RPC
  console.log(`\n🔌 Connecting to RPC: ${opts.rpcUrl.slice(0, 30)}...`);
  const connection = new Connection(opts.rpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 30000,
  });

  // Enrich reserves
  console.log('\n💧 Enriching reserves...');
  await enrichReserves(pools, connection, {
    batchSize: opts.batchSize,
    forceRefresh: opts.forceRefresh,
    log: true,
  });

  // Validate pools
  console.log('\n✅ Validating pools...');
  const validPools = validatePools(pools, { log: true });

  // Summary statistics
  console.log('\n📊 Summary:');

  const byDex = {};
  const byType = {};
  for (const p of validPools) {
    byDex[p.dex] = (byDex[p.dex] || 0) + 1;
    byType[p.type] = (byType[p.type] || 0) + 1;
  }

  console.log(`   By DEX: ${JSON.stringify(byDex)}`);
  console.log(`   By type: ${JSON.stringify(byType)}`);

  // SOL/USDC breakdown
  const solPools = validPools.filter(p =>
    p.baseMint === TOKENS.SOL || p.quoteMint === TOKENS.SOL
  );
  const usdcPools = validPools.filter(p =>
    p.baseMint === TOKENS.USDC || p.quoteMint === TOKENS.USDC
  );

  console.log(`   SOL pairs: ${solPools.length}`);
  console.log(`   USDC pairs: ${usdcPools.length}`);

  // SOL/USDC by type
  const solByType = { dlmm: 0, whirlpool: 0, clmm: 0, cpmm: 0 };
  const usdcByType = { dlmm: 0, whirlpool: 0, clmm: 0, cpmm: 0 };

  for (const p of solPools) {
    solByType[p.type] = (solByType[p.type] || 0) + 1;
  }
  for (const p of usdcPools) {
    usdcByType[p.type] = (usdcByType[p.type] || 0) + 1;
  }

  console.log(`   SOL by type: ${JSON.stringify(solByType)}`);
  console.log(`   USDC by type: ${JSON.stringify(usdcByType)}`);

  // Save output
  const outputPath = path.resolve(opts.output);
  fs.writeFileSync(outputPath, JSON.stringify(validPools, null, 2));
  console.log(`\n✅ Saved ${validPools.length} enriched pools to ${outputPath}`);

  console.log('\n' + '═'.repeat(60));
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  });
}
// Exports
module.exports = {
  enrichReserves,
  validatePools,
  getVaultAddresses,
  parseSplTokenAmount,
  hasValidReserves,
};
/*
node - e 
const pools = require('./pools_enriched.json');
const byType = {}; const withVaults = {}; const withAtomicRes = {};
for (const p of pools) {
  const t = (p.type || '').toLowerCase(); byType[t] = (byType[t] || 0) + 1;
  const v = !!(p.vaults && p.vaults.xVault && p.vaults.yVault); if (v) withVaults[t] = (withVaults[t] || 0) + 1;
  const xr = typeof p.xReserve === 'string' || typeof p.xReserve === 'number';
  const yr = typeof p.yReserve === 'string' || typeof p.yReserve === 'number';
  if (xr && yr) withAtomicRes[t] = (withAtomicRes[t] || 0) + 1;
} 
 */
