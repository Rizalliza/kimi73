'use strict';

const Decimal = require('decimal.js');

function D(x) {
  if (x instanceof Decimal) return x;
  if (typeof x === 'bigint') return new Decimal(x.toString());
  if (x === null || x === undefined) return new Decimal(0);
  const s = String(x).trim();
  if (!s) return new Decimal(0);
  return new Decimal(s);
}

const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  UFD: 'eL5fUxj2J4CiQsmW85k5FG9DvuQjjUoBHoQBi2Kpump',
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shortAddr(a) {
  if (!a) return '';
  const s = String(a);
  return s.length <= 10 ? s : `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function shortMint(m) {
  return shortAddr(m);
}

function normalizeDex(p) {
  const d = (p?.dex ?? p?.raw?.dex ?? p?.raw?._original?.dex ?? '').toString().toLowerCase();
  if (!d) return 'unknown';
  if (d.includes('meteora')) return 'meteora';
  if (d.includes('orca')) return 'orca';
  if (d.includes('raydium')) return 'raydium';
  return d;
}

function normalizeType(p) {
  // Force Orca -> Whirlpool
  const d = normalizeDex(p);
  if (d === 'orca') return 'whirlpool';

  const t = (p?.type ?? p?.poolType ?? p?.raw?.type ?? p?.raw?.poolType ?? p?.raw?._original?.type ?? '').toString().toLowerCase();
  if (t.includes('dlmm')) return 'dlmm';
  if (t.includes('whirlpool') || t.includes('orca')) return 'whirlpool';
  if (t.includes('clmm')) return 'clmm';
  if (t.includes('cpmm') || t.includes('amm') || t.includes('constant')) return 'cpmm';
  if (p?.binStep || p?.raw?.bin_step) return 'dlmm';
  if (p?.tickSpacing || p?.raw?.tickSpacing) return 'whirlpool';
  return 'cpmm';
}

function getFeeRate(p) {
  const bps = p?.feeBps ?? p?.raw?.feeBps ?? p?.raw?.tradeFeeBps ?? p?.raw?.fee_bps;
  if (bps !== undefined && bps !== null && bps !== '') return D(bps).div(10000);
  const fee = p?.feeRate ?? p?.raw?.feeRate ?? p?.raw?.tradeFeeRate;
  if (fee !== undefined && fee !== null && fee !== '') return D(fee);
  return D('0.003');
}

function getTokenDecimals(mint, pool) {
  if (pool) {
    if (mint === pool.baseMint) return Number(pool.baseDecimals ?? 0);
    if (mint === pool.quoteMint) return Number(pool.quoteDecimals ?? 0);
  }
  if (mint === TOKENS.SOL || mint === TOKENS.WSOL) return 9;
  if (mint === TOKENS.USDC) return 6;
  return 9;
}

function getSwapDecimals(pool, inputMint) {
  const baseDecimals = Number(pool.baseDecimals ?? getTokenDecimals(pool.baseMint, pool));
  const quoteDecimals = Number(pool.quoteDecimals ?? getTokenDecimals(pool.quoteMint, pool));

  if (inputMint === pool.baseMint) {
    return { inputDecimals: baseDecimals, outputDecimals: quoteDecimals, swapForY: true };
  }
  if (inputMint === pool.quoteMint) {
    return { inputDecimals: quoteDecimals, outputDecimals: baseDecimals, swapForY: false };
  }
  return { inputDecimals: baseDecimals, outputDecimals: quoteDecimals, swapForY: true };
}

function atomicToHuman(atomic, decimals) {
  return D(atomic).div(D(10).pow(decimals));
}

function humanToAtomic(human, decimals) {
  const D = require('decimal.js');
  return D(human).mul(D(10).pow(decimals)).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
}

function hasReserves(pool) {
  if (!pool) return false;
  if (pool.xReserve === null || pool.xReserve === undefined) return false;
  if (pool.yReserve === null || pool.yReserve === undefined) return false;
  const x = D(pool.xReserve);
  const y = D(pool.yReserve);
  return x.gt(0) && y.gt(0);
}

function getReserves(pool) {
  return { x: D(pool.xReserve), y: D(pool.yReserve) };
}
/**
 * Convert a value to a number, or return null if conversion fails
 * @param {any} val - Value to convert
 * @returns {number|null} Parsed number or null
 */
function toNumberOrNull(val) {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  Decimal,
  D,
  TOKENS,
  toNumberOrNull,
  sleep,
  shortAddr,
  shortMint,
  normalizeDex,
  normalizeType,
  getFeeRate,
  getTokenDecimals,
  getSwapDecimals,
  atomicToHuman,
  humanToAtomic,
  hasReserves,
  getReserves,
};
