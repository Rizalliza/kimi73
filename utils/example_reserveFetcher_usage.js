'use strict';
/**
 * example_reserveFetcher_usage.js
 * 
 * Demonstrates how to use the ReserveFetcher to hydrate incomplete pool data
 * from on-chain sources (Meteora DLMM, Orca Whirlpool, Raydium CLMM/CPMM).
 * 
 * This solves the problem of pools without reserve data being filtered out.
 */
require('dotenv').config();
const fs = require('fs');
const { Connection } = require('@solana/web3.js');
const { ReserveFetcher, hydratePoolsOnDemand } = require('./example_reserveFetcher_usage.js');
const tri = require('../engine/triArbitrage.js');

// ============================================================================
// SETUP
// ============================================================================

const RPC_URL = process.env.RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy';
const connection = new Connection(RPC_URL, 'confirmed');

// ============================================================================
// EXAMPLE 1: Simple one-shot hydration
// ============================================================================

async function example1_SimpleHydration() {
  console.log('\n=== EXAMPLE 1: Simple One-Shot Hydration ===\n');

  const pools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));
  console.log(`Starting with ${pools.length} pools`);

  const hydrated = await hydratePoolsOnDemand(connection, pools, {
    log: true,
    batchSize: 20,
    cacheTTL: 600000
  });

  console.log(`\n✅ Hydration complete: ${hydrated.length} pools processed`);
  return hydrated;
}

// ============================================================================
// EXAMPLE 2: Detailed fetcher with progress tracking
// ============================================================================

async function example2_DetailedFetcher() {
  console.log('\n=== EXAMPLE 2: Detailed Fetcher with Progress ===\n');

  const pools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  const fetcher = new ReserveFetcher(connection, {
    log: true,
    batchSize: 10,
    cacheTTL: 600000,
    rpcTimeout: 15000
  });

  console.log('Initializing SDKs...');
  await fetcher.initialize();

  console.log(`\nHydrating ${pools.length} pools...`);
  const hydrated = await fetcher.hydratePoolsWithReserves(pools, (progress) => {
    process.stdout.write(`\r  ${progress.current}/${progress.total} pools processed (hydrated: ${progress.hydrated}, failed: ${progress.failed})`);
  });

  console.log('\n');
  const stats = fetcher.getStats();
  console.log('Statistics:');
  console.log(`  Total: ${stats.total}`);
  console.log(`  Newly hydrated: ${stats.hydrated}`);
  console.log(`  From cache: ${stats.cached}`);
  console.log(`  Already complete: ${stats.skipped}`);
  console.log(`  Failed: ${stats.failed}`);
  console.log(`  Success rate: ${stats.successRate}`);
  console.log(`  By type: ${JSON.stringify(stats.byType)}`);

  return hydrated;
}

// ============================================================================
// EXAMPLE 3: Hydrate then filter for arbitrage
// ============================================================================

async function example3_HydrateThenFilter() {
  console.log('\n=== EXAMPLE 3: Hydrate + Filter for Arbitrage ===\n');

  const pools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  console.log(`Step 1: Hydrating ${pools.length} pools...`);
  const hydrated = await hydratePoolsOnDemand(connection, pools, {
    log: true,
    batchSize: 20
  });

  console.log(`\nStep 2: Filtering for arbitrage...`);
  const usable = tri.filterUsablePools(hydrated, true);

  console.log(`\n📊 Results:`);
  console.log(`  Input pools: ${pools.length}`);
  console.log(`  After hydration: ${hydrated.length}`);
  console.log(`  Usable for arbitrage: ${usable.length}`);
  console.log(`  Improvement: ${((usable.length - 4) / 4 * 100).toFixed(1)}% more pools`);

  return usable;
}

// ============================================================================
// EXAMPLE 4: Compare hydrated vs non-hydrated
// ============================================================================

async function example4_Comparison() {
  console.log('\n=== EXAMPLE 4: Before/After Hydration Comparison ===\n');

  const pools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  // Without hydration
  console.log('WITHOUT HYDRATION:');
  const usableNoHydration = tri.filterUsablePools(pools, false);
  console.log(`  Input: ${pools.length}`);
  console.log(`  Usable: ${usableNoHydration.length}`);

  // With hydration
  console.log('\nWITH HYDRATION:');
  const hydrated = await hydratePoolsOnDemand(connection, pools, { log: false });
  const usableWithHydration = tri.filterUsablePools(hydrated, false);
  console.log(`  Input: ${pools.length}`);
  console.log(`  After hydration: ${hydrated.length}`);
  console.log(`  Usable: ${usableWithHydration.length}`);

  console.log(`\n📈 Improvement:`);
  console.log(`  Additional usable pools: ${usableWithHydration.length - usableNoHydration.length}`);
  console.log(`  % increase: ${((usableWithHydration.length - usableNoHydration.length) / usableNoHydration.length * 100).toFixed(1)}%`);
}

// ============================================================================
// EXAMPLE 5: Use with the engine's hydration function
// ============================================================================

async function example5_EngineIntegration() {
  console.log('\n=== EXAMPLE 5: Using Engine.filterUsablePoolsWithHydration ===\n');

  const pools = JSON.parse(fs.readFileSync('./custom_enriched.json', 'utf8'));

  console.log(`Input: ${pools.length} pools`);
  const usable = await tri.filterUsablePoolsWithHydration(pools, connection, {
    log: true,
    batchSize: 20
  });

  console.log(`\n✅ Result: ${usable.length} usable pools ready for arbitrage`);
  return usable;
}

// ============================================================================
// EXAMPLE 6: Check which pools lack reserves
// ============================================================================

async function example6_DiagnoseReserves() {
  console.log('\n=== EXAMPLE 6: Diagnose Missing Reserves ===\n');

  const pools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  const { hasReserves } = require('./_utils');

  const noReserves = pools.filter(p => !hasReserves(p));
  const hasReserves_ = pools.filter(p => hasReserves(p));

  console.log(`Pools with reserves: ${hasReserves_.length} (${(hasReserves_.length / pools.length * 100).toFixed(1)}%)`);
  console.log(`Pools without reserves: ${noReserves.length} (${(noReserves.length / pools.length * 100).toFixed(1)}%)`);

  if (noReserves.length > 0) {
    console.log(`\nSample of pools without reserves:`);
    noReserves.slice(0, 5).forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.poolAddress?.slice(0, 8)} | DEX: ${p.dex} | Type: ${p.type}`);
    });

    console.log(`\n💡 Solution: Use ReserveFetcher to fetch these reserves from on-chain`);
    console.log(`   Example: await fetcher.hydratePoolsWithReserves(pools)`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    const example = process.argv[2] || 'all';

    if (example === '1' || example === 'all') await example1_SimpleHydration();
    if (example === '2' || example === 'all') await example2_DetailedFetcher();
    if (example === '3' || example === 'all') await example3_HydrateThenFilter();
    if (example === '4' || example === 'all') await example4_Comparison();
    if (example === '5' || example === 'all') await example5_EngineIntegration();
    if (example === '6' || example === 'all') await example6_DiagnoseReserves();

    console.log('\n✅ Examples complete!');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  };
}
/*
modules.exports = {
  example1_SimpleHydration,
  example2_DetailedFetcher,
  example3_HydrateThenFilter,
  example4_Comparison,
  example5_EngineIntegration,
  example6_DiagnoseReserves
};

*/
if (require.main === module) {
  main(),
    example1_SimpleHydration,
    example2_DetailedFetcher,
    example3_HydrateThenFilter,
    example4_Comparison,
    example5_EngineIntegration,
    example6_DiagnoseReserves;
}

/*
USAGE:
  node example_reserveFetcher_usage.js 1    # Run example 1 only
  node example_reserveFetcher_usage.js 2    # Run example 2 only
  node example_reserveFetcher_usage.js 3    # Run example 3 only
  node example_reserveFetcher_usage.js 5    # Run example 5 only
  node example_reserveFetcher_usage.js all  # Run all examples (default)

EXPECTED OUTPUT:
  - Hydration stats (how many pools were missing reserves)
  - Progress tracking
  - Cache statistics
  - Success rate
  - Comparison showing improvement in usable pools

  node _reserveFetcher.js all

  node example_reserveFetcher_usage.js 5
  node --trace-warnings example_reserveFetcher_usage.js 5
  node _reserveFetcher.js 1
  node _reserveFetcher.js 2
  node _reserveFetcher.js 3
  node _reserveFetcher.js 4
  node _reserveFetcher.js 5
*/
