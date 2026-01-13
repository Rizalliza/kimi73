#!/usr/bin/env node
'use strict';

/**
 * poolfetch_meta_solusdc.js
 *
 * Build a minimal, normalized metadata file for SOL/USDC pools from multiple DEX metadata JSON files.
 *
 * Supported sources (auto-detected):
 *  - Raydium CPMM + CLMM metadata objects (e.g. Raydium API v3 pool list entries)
 *  - Orca Whirlpool metadata objects (e.g. Orca whirlpool list entries)
 *  - Meteora DLMM metadata objects (e.g. Meteora DLMM pairs list entries)
 *
 * Output is intentionally "thin": enough to (a) enrich later via RPC/SDK, (b) avoid runtime guesswork.
 *
 * Usage:
 *   node solana_poolfetchers/poolfetch_meta_solusdc.js --inDir ./rawMeta/meta_solusdc.json --out ./rawMeta/meta_solusdc.json
 *   node poolfetch_meta_solusdc.js --inDir ./rawMeta --out meta_solusdc.json --minLiquidityUsd 800000
  
{ "poolAddress": "...", "dex": "raydium", "type": "cpmm", "...":"..." },
  { "poolAddress": "...", "dex": "orca", "type": "whirlpool",  "...":"..." },
  { "poolAddress": "...", "dex": "raydium", "type": "clmm", "...":"..." },
{ "poolAddress": "...", "dex": "raydium", "type": "cpmm",  "...":"..." },
  cat > meta_solusdc.json  <<'EOF'
[
  { "poolAddress": "...", "dex": "", "type": "", "...":"..." },
]
EOF

 * 
 * node poolfetch_meta_solusdc.js --inDir ./rawMeta --out ./meta_solusdc.json  --minLiquidityUsd 800000
# optional (only applied when metadata has tvl/liquidity fields):


node poolfetch_meta_solusdc.js --inDir output/ --out ./output/shape_Enrich.json --minLiquidityUsd 1000000

export SOLANA_RPC_URL="https://solana-mainnet.g.alchemy.com/v2/https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy"
node jsonPool/poolfetch_meta.js --in ./jsonPool/all4_M.json --out ./jsonPool/custom.json\
  --minUsdc 1000000 --concurrency 8 --bins 40 --tickArrays 3

  //. node jsonPool/poolfetch_meta.js --inDir jsonPool/all4_M.json --out jsonPool/custom.json--minLiquidityUsd 1000000 --verbose


 */

const fs = require('fs');
const path = require('path');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function parseArgs(argv) {
  const out = { inDir: null, out: null, minLiquidityUsd: 0, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--inDir') out.inDir = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--minLiquidityUsd') out.minLiquidityUsd = Number(argv[++i] || '0');
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usageAndExit(code = 0) {
  console.log(`Usage:
  node poolfetch_meta_solusdc.js --inDir <dir_with_json_files> --out <meta.json> [--minLiquidityUsd 1000000] [--verbose]

Notes:
  - Filters strictly to SOL mint ${SOL_MINT} and USDC mint ${USDC_MINT}.
  - If a record contains a liquidity/tvl field, --minLiquidityUsd is enforced at metadata stage.
  - Otherwise min liquidity filtering happens in the enrich stage.`);
  process.exit(code);
}

function listJsonFilesRec(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJsonFilesRec(p));
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

function loadJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse JSON: ${file}: ${e.message}`);
  }
}

function toArray(x) {
  if (Array.isArray(x)) return x;
  if (!x || typeof x !== 'object') return [];
  // common wrappers
  if (Array.isArray(x.pools)) return x.pools;
  if (Array.isArray(x.data)) return x.data;
  if (Array.isArray(x.result)) return x.result;
  if (Array.isArray(x.items)) return x.items;
  return [x];
}

function normMint(m) {
  return (m || '').toString().trim();
}

function isSolUsdcPair(mintA, mintB) {
  const a = normMint(mintA);
  const b = normMint(mintB);
  return (a === SOL_MINT && b === USDC_MINT) || (a === USDC_MINT && b === SOL_MINT);
}

function pickLiquidityUsd(obj) {
  const cand = [
    obj.liquidity,
    obj.liquidityUsd,
    obj.liquidity_usd,
    obj.tvl,
    obj.tvlUsd,
    obj.tvl_usd,
    obj.tvlUSD,
    obj.volume24h, // not tvl but better than nothing
  ];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

// --- ADAPTERS --------------------------------------------------------------

// Meteora DLMM pair entry
function fromMeteoraDlmm(x) {
  if (!x || typeof x !== 'object') return null;
  // heuristics based on keys seen in Meteora pair lists
  if (!('reserve_x' in x || 'reserve_y' in x || 'bin_step' in x)) return null;

  const poolAddress = x.address || x.lb_pair || x.pair_address || x.pool || null;
  const mintX = x.mint_x || x.token_x || x.tokenX || null;
  const mintY = x.mint_y || x.token_y || x.tokenY || null;
  if (!poolAddress || !mintX || !mintY) return null;

  const baseMint = mintX; // keep original order; enrich stage will map x/y to base/quote if needed
  const quoteMint = mintY;
  const baseDecimals = Number(x.decimal_x ?? x.decimals_x ?? x.token_x_decimals ?? x.baseDecimals ?? 0) || 0;
  const quoteDecimals = Number(x.decimal_y ?? x.decimals_y ?? x.token_y_decimals ?? x.quoteDecimals ?? 0) || 0;

  const feeBps = Number(x.fee_bps ?? x.feeBps ?? x.base_fee_bps ?? 0) || 0;
  const binStep = Number(x.bin_step ?? x.binStep ?? 0) || 0;

  return {
    poolAddress: poolAddress.toString(),
    dex: 'meteora',
    type: 'dlmm',
    baseMint: baseMint.toString(),
    quoteMint: quoteMint.toString(),
    baseDecimals,
    quoteDecimals,
    feeBps,
    binStep,
    // Meteora typically exposes these "vaults" already (token accounts holding reserves)
    vaults: {
      xVault: x.reserve_x || null,
      yVault: x.reserve_y || null,
    },
    liquidityUsd: pickLiquidityUsd(x),
    _raw: x,
  };
}

// Orca Whirlpool list entry
function fromOrcaWhirlpool(x) {
  if (!x || typeof x !== 'object') return null;
  if (!('tickSpacing' in x && ('tokenA' in x || 'tokenB' in x) && 'address' in x)) return null;

  const poolAddress = x.address;
  const mintA = x.tokenA?.mint || x.tokenA?.address || x.tokenA?.tokenMint || null;
  const mintB = x.tokenB?.mint || x.tokenB?.address || x.tokenB?.tokenMint || null;
  if (!poolAddress || !mintA || !mintB) return null;

  const baseDecimals = Number(x.tokenA?.decimals ?? 0) || 0;
  const quoteDecimals = Number(x.tokenB?.decimals ?? 0) || 0;

  // Orca often stores feeRate in basis points (but confirm in your source); keep both
  const feeBps = Number(x.feeRate ?? x.feeBps ?? 0) || 0;
  const tickSpacing = Number(x.tickSpacing ?? 0) || 0;

  return {
    poolAddress: poolAddress.toString(),
    dex: 'orca',
    type: 'whirlpool',
    baseMint: mintA.toString(),
    quoteMint: mintB.toString(),
    baseDecimals,
    quoteDecimals,
    feeBps,
    tickSpacing,
    liquidityUsd: pickLiquidityUsd(x),
    _raw: x,
  };
}

// Raydium pool list entry (CPMM or CLMM)
function fromRaydium(x) {
  if (!x || typeof x !== 'object') return null;
  if (!('programId' in x && 'id' in x && ('mintA' in x || 'mintB' in x))) return null;

  const poolAddress = x.id;
  const mintA = x.mintA?.address || x.mintA?.mint || x.mintA || null;
  const mintB = x.mintB?.address || x.mintB?.mint || x.mintB || null;
  if (!poolAddress || !mintA || !mintB) return null;

  const baseDecimals = Number(x.mintA?.decimals ?? x.decimalsA ?? 0) || 0;
  const quoteDecimals = Number(x.mintB?.decimals ?? x.decimalsB ?? 0) || 0;

  const programId = (x.programId || '').toString();
  // Heuristic:
  // - Raydium CPMM commonly uses program "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
  // - Raydium CLMM uses different program (often "CAMMCzo5YL8..."), but pool list entries also have type "Concentrated"
  const typeStr = (x.type || '').toString().toLowerCase();
  let type = 'cpmm';
  if (typeStr.includes('concentrated') || typeStr.includes('clmm')) type = 'clmm';
  // fallback by programId prefix
  if (programId.startsWith('CAMMC') || programId.startsWith('CLMM')) type = 'clmm';

  const feeBps = Number(x.feeBps ?? x.tradeFeeRate ?? x.tradeFeeRate ?? 0) || 0;

  return {
    poolAddress: poolAddress.toString(),
    dex: 'raydium',
    type,
    baseMint: mintA.toString(),
    quoteMint: mintB.toString(),
    baseDecimals,
    quoteDecimals,
    feeBps,
    liquidityUsd: pickLiquidityUsd(x),
    _raw: x,
  };
}

function normalizePool(p) {
  if (!p) return null;

  const baseMint = normMint(p.baseMint);
  const quoteMint = normMint(p.quoteMint);
  if (!baseMint || !quoteMint) return null;

  // Filter to SOL/USDC
  if (!isSolUsdcPair(baseMint, quoteMint)) return null;

  // Normalize to fixed base=SOL, quote=USDC for downstream consistency
  let out = { ...p };
  if (baseMint !== SOL_MINT) {
    // swap fields
    out = {
      ...p,
      baseMint: quoteMint,
      quoteMint: baseMint,
      baseDecimals: p.quoteDecimals,
      quoteDecimals: p.baseDecimals,
      // keep vault x/y as-is (enrich stage will remap)
    };
  }

  // Validate minimal decimals
  if (!Number.isFinite(out.baseDecimals) || !Number.isFinite(out.quoteDecimals)) return null;
  if (out.baseDecimals <= 0 || out.quoteDecimals <= 0) return null;

  // Type-specific fields
  if (out.type === 'dlmm') {
    if (!Number.isFinite(out.binStep) || out.binStep <= 0) return null;
  }
  if (out.type === 'whirlpool' || out.type === 'clmm') {
    if (!Number.isFinite(out.tickSpacing) || out.tickSpacing <= 0) {
      // some sources omit tickSpacing; allow and enrich later
      out.tickSpacing = out.tickSpacing || 0;
    }
  }

  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.inDir || !args.out) usageAndExit(args.help ? 0 : 1);

  let files = [];
  try {
    const stat = fs.statSync(args.inDir);
    if (stat.isDirectory()) {
      files = listJsonFilesRec(args.inDir);
    } else if (stat.isFile()) {
      files = [args.inDir];
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Input path not found: ${args.inDir}`);
    }
    throw e;
  }

  if (!files.length) throw new Error(`No .json files found under: ${args.inDir}`);

  const pools = [];
  const stats = { files: files.length, read: 0, parsed: 0, kept: 0, droppedPair: 0, droppedLiquidity: 0, droppedInvalid: 0 };

  for (const f of files) {
    stats.read++;
    const js = loadJson(f);
    const arr = toArray(js);
    stats.parsed += arr.length;

    for (const item of arr) {
      let p =
        fromMeteoraDlmm(item) ||
        fromOrcaWhirlpool(item) ||
        fromRaydium(item) ||
        null;

      if (!p) continue;

      const n = normalizePool(p);
      if (!n) { stats.droppedPair++; continue; }

      // Optional liquidity filter, only if we have a numeric liquidityUsd in metadata
      if (args.minLiquidityUsd > 0 && n.liquidityUsd && n.liquidityUsd < args.minLiquidityUsd) {
        stats.droppedLiquidity++;
        continue;
      }

      // Remove _raw unless verbose
      if (!args.verbose) delete n._raw;

      pools.push(n);
      stats.kept++;
    }
  }

  // Deduplicate
  const uniq = new Map();
  for (const p of pools) uniq.set(p.poolAddress, p);
  const out = Array.from(uniq.values()).sort((a, b) => a.dex.localeCompare(b.dex) || a.type.localeCompare(b.type));

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2));

  console.log(`Wrote ${args.out}`);
  console.log(`Pools kept: ${out.length}`);
  console.log(`Stats:`, stats);
}

main();

//. node json/poolfetch_meta.js --inDir json/all4_M.json  --out ./json/  --minLiquidityUsd 1000000 
