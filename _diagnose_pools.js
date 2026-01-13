#!/usr/bin/env node
'use strict';
/**
 * _diagnose_pools.js - Understand why pool types aren't in routes
 * 
 * Usage: node _diagnose_pools.js ./
 * Usage: node _diagnose_pools.js ./custom_pools_enriched.json
 */

const fs = require('fs');
const path = require('path');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function shortMint(m) {
  return m ? `${m.slice(0, 6)}...${m.slice(-4)}` : '???';
}

function normalizeType(pool) {
  const t = (pool?.type || pool?.poolType || '').toLowerCase();
  const dex = (pool?.dex || '').toLowerCase();

  if (t.includes('dlmm') || dex.includes('dlmm')) return 'dlmm';
  if (t.includes('whirlpool') || dex.includes('orca') || dex.includes('whirlpool')) return 'whirlpool';
  if (t.includes('clmm') || dex.includes('clmm')) return 'clmm';
  if (t.includes('cpmm') || t.includes('amm') || dex.includes('raydium')) return 'cpmm'; // Default Raydium to CPMM if not CLMM
  return 'cpmm';
}

function hasReserves(pool) {
  // CPMM/General reserves
  const x = parseFloat(pool?.xReserve || pool?.reserve_x_amount || pool?.tokenAAmount || 0);
  const y = parseFloat(pool?.yReserve || pool?.reserve_y_amount || pool?.tokenBAmount || 0);

  // DLMM/CLMM liquidity
  const liq = parseFloat(pool?.liquidity || 0);

  return (x > 0 && y > 0) || liq > 0;
}

// Check if pool has explicit vault addresses if that's what we are looking for
function hasVaults(pool) {
  if (pool.type === 'dlmm') {
    // Some DLMM dumps might use reserveX/Y as vault amounts, but here we might check for vault accounts?
    // Let's assume having reserves is enough for now, or check specific fields if known.
    // Referring to the broken code, it looked for xVault/yVault.
    return (pool.xVault || pool.tokenXVault) && (pool.yVault || pool.tokenYVault);
  }
  return false;
}

function diagnose(filePath) {
  console.log('═'.repeat(70));
  console.log('POOL COMPOSITION DIAGNOSTIC');
  console.log('═'.repeat(70));

  // Load pools
  let raw;
  try {
    if (fs.lstatSync(filePath).isDirectory()) {
      // If directory, maybe look for json files?
      console.error("Provided path is a directory. Please provide a JSON file.");
      return;
    }
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`Failed to read file: ${e.message}`);
    return;
  }

  const pools = Array.isArray(raw) ? raw : (raw.pools || raw.data || Object.values(raw));

  console.log(`\nLoaded ${pools.length} pools\n`);

  // Group by type
  const byType = { dlmm: [], whirlpool: [], clmm: [], cpmm: [] };

  for (const p of pools) {
    const type = normalizeType(p);
    if (byType[type]) {
      byType[type].push(p);
    } else {
      // Fallback or unknown
      byType.cpmm.push(p);
    }
  }

  const cpmmPools = byType.cpmm;
  const dlmmPools = byType.dlmm;
  const clmmPools = byType.clmm;
  const whirlpoolPools = byType.whirlpool;

  // =========================================================================
  // 1. Overview
  // =========================================================================
  console.log('[1] POOL COUNT BY TYPE');
  console.log('-'.repeat(70));
  for (const [type, arr] of Object.entries(byType)) {
    console.log(`  ${type.toUpperCase()}: ${arr.length} pools`);
  }

  // =========================================================================
  // 2. SOL/USDC availability per type
  // =========================================================================
  console.log('\n[2] SOL/USDC PAIRS PER TYPE');
  console.log('-'.repeat(70));

  for (const [type, arr] of Object.entries(byType)) {
    if (arr.length === 0) continue;

    const withSol = arr.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const withUsdc = arr.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
    const solUsdc = arr.filter(p =>
      (p.baseMint === SOL && p.quoteMint === USDC) ||
      (p.baseMint === USDC && p.quoteMint === SOL)
    );
    const withReserves = arr.filter(hasReserves);

    console.log(`\n  ${type.toUpperCase()} (${arr.length} pools):`);
    console.log(`    With reserves/liq: ${withReserves.length}`);
    console.log(`    With SOL: ${withSol.length}`);
    console.log(`    With USDC: ${withUsdc.length}`);
    console.log(`    SOL/USDC direct: ${solUsdc.length}`);

    if (withSol.length === 0 && withUsdc.length === 0) {
      console.log(`    ⚠️  NO SOL OR USDC PAIRS - cannot form triangular routes!`);
    }
  }

  // =========================================================================
  // 3. Sample pools per type
  // =========================================================================
  console.log('\n[3] SAMPLE POOLS PER TYPE');
  console.log('-'.repeat(70));

  for (const [type, arr] of Object.entries(byType)) {
    if (arr.length === 0) continue;

    console.log(`\n  ${type.toUpperCase()} samples:`);

    // Show up to 3 samples
    for (const p of arr.slice(0, 3)) {
      const base = shortMint(p.baseMint);
      const quote = shortMint(p.quoteMint);
      const addr = shortMint(p.poolAddress || p.address || p.pubkey);
      console.log(`    ${addr} | ${base} / ${quote}`);
    }
  }

  // =========================================================================
  // 4. CPMM Deep Dive
  // =========================================================================
  if (cpmmPools.length > 0) {
    console.log('\n[4] CPMM DEEP DIVE');
    console.log('-'.repeat(70));

    // Get all unique tokens in CPMM
    const cpmmTokens = new Set();
    for (const p of cpmmPools) {
      if (p.baseMint) cpmmTokens.add(p.baseMint);
      if (p.quoteMint) cpmmTokens.add(p.quoteMint);
    }

    console.log(`  Unique tokens in CPMM pools: ${cpmmTokens.size}`);
    console.log(`  Has SOL: ${cpmmTokens.has(SOL) ? 'YES' : 'NO'}`);
    console.log(`  Has USDC: ${cpmmTokens.has(USDC) ? 'YES' : 'NO'}`);

    const cpmmWithReserves = cpmmPools.filter(hasReserves);
    console.log(`\n  CPMM with reserves: ${cpmmWithReserves.length}/${cpmmPools.length}`);

    if (cpmmWithReserves.length === 0) {
      console.log(`  ❌ NO CPMM pools have reserves - they can't be simulated!`);
      const sample = cpmmPools[0];
      console.log(`  Sample pool reserves:`);
      console.log(`    xReserve: ${sample.xReserve}`);
      console.log(`    yReserve: ${sample.yReserve}`);
    }
  }
  /*
    // =========================================================================
    // 4. whirlpools Deep Dive
    // =========================================================================
    if (whirlpoolPools.length > 0) {
      console.log('\n[4] CPMM DEEP DIVE');
      console.log('-'.repeat(70));
  
      // Get all unique tokens in CPMM
      const whirlpoolTokens = new Set();
      for (const p of whirlpoolPools) {
        if (p.baseMint) whirlpoolTokens.add(p.baseMint);
        if (p.quoteMint) whirlpoolTokens.add(p.quoteMint);
      }
  
      console.log(`  Unique tokens in whirlpool pools: ${whirlpoolTokens.size}`);
      console.log(`  Has SOL: ${whirlpoolTokens.has(SOL) ? 'YES' : 'NO'}`);
      console.log(`  Has USDC: ${whirlpoolTokens.has(USDC) ? 'YES' : 'NO'}`);
  
      const whirlpoolWithReserves = whirlpoolPools.filter(hasReserves);
      console.log(`\n  whirlpool with reserves: ${whirlpoolWithReserves.length}/${whirlpoolPools.length}`);
  
      if (whirlpoolWithReserves.length === 0) {
        console.log(`  ❌ NO whirlpool pools have reserves - they can't be simulated!`);
        const sample = whirlpoolPools[0];
        console.log(`  Sample pool reserves:`);
        console.log(`    xReserve: ${sample.xReserve}`);
        console.log(`    yReserve: ${sample.yReserve}`);
      }
    }
  */
  // =========================================================================
  // 5. DLMM Deep Dive
  // =========================================================================
  if (dlmmPools.length > 0) {
    console.log('\n[5] DLMM DEEP DIVE');
    console.log('-'.repeat(70));

    // Check reserves
    const dlmmWithVaults = dlmmPools.filter(hasVaults);
    console.log(`  DLMM with reserves/liq: ${dlmmWithVaults.length}/${dlmmPools.length}`);

    if (dlmmWithVaults.length === 0) {
      console.log(`  ❌ NO DLMM pools have reserves!`);
      const Vaults = dlmmPools[0];
      console.log('Sample pool keys:', Object.keys(Vaults).join(', '));
    }
  }

  // =========================================================================
  // 6. RECOMMENDATIONS
  // =========================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('RECOMMENDATIONS');
  console.log('═'.repeat(70));

  const issues = [];

  // Check CPMM
  if (cpmmPools.length > 0) {
    const cpmmWithSol = cpmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const cpmmWithUsdc = cpmmPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
    const cpmmWithReserves = cpmmPools.filter(hasReserves);

    if (cpmmWithSol.length === 0 && cpmmWithUsdc.length === 0) {
      issues.push('CPMM pools have NO SOL or USDC pairs - fetch Raydium pools with SOL/USDC');
    } else if (cpmmWithReserves.length === 0) {
      issues.push('CPMM pools have no reserves - check _loader.js reserve extraction');
    }
  }

  // Check CLMM
  if (clmmPools.length > 0) {
    const clmmWithSol = clmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    if (clmmWithSol.length === 0) {
      issues.push('CLMM pools have no SOL pairs - fetch Raydium CLMM pools with SOL');
    }
  }

  // Check DLMM
  if (dlmmPools.length === 0) {
    issues.push('No DLMM pools in data - fetch from Meteora API');
  } else {
    const dlmmWithSOL = dlmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const dlmmWithUsdc = dlmmPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);


    if (dlmmWithSOL.length === 0 && dlmmWithUsdc.length === 0) {
      issues.push('DLMM pools have NO SOL or USDC pairs - fetch Meteora DLMM pools with SOL/USDC');
    }

  }

  // Check Whirlpool
  if (whirlpoolPools.length === 0) {
    issues.push('No Whirlpool pools in data - fetch from Orca API');
  }

  if (issues.length === 0) {
    console.log('\n✓ Pool data looks complete for triangular arbitrage');
  } else {
    console.log('\n🔴 Issues preventing cross-DEX routes:\n');
    for (const issue of issues) {
      console.log(`   • ${issue}`);
    }
    console.log('\n💡 Solution: Fetch additional pool data that includes:');
    console.log('   - Raydium CPMM: SOL/X and X/USDC pools');
    console.log('   - Raydium CLMM: SOL/X and X/USDC pools');
    console.log('   - Orca Whirlpool: SOL/X and X/USDC pools');
    console.log('   - Meteora DLMM: SOL/X and X/USDC pools');
  }

  console.log('\n' + '═'.repeat(70));
}

// Run
const filePath = process.argv[2];
if (!filePath) {
  console.log('Usage: node _diagnose_pools.js <json_file>');
  process.exit(1);
}

diagnose(filePath);

//. node _diagnose_pools.js in/custom_rawMeta.json

//. //. node _diagnose_pools.js custom_raw.json