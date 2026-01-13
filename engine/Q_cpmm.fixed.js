'use strict';
require('dotenv').config();

const { PublicKey } = require('@solana/web3.js');
const Decimal = require('decimal.js');

/**
 * CPMM quoter aligned to Q-dlmm.js structure.
 *
 * Requires reserves (x/y) from poolData (ideally from poolFetch enrich).
 * Will FAIL FAST if reserves are missing/zero, to avoid fake "profitable" quotes.
 */

function ensure(cond, msg) { if (!cond) throw new Error(msg); }
function toDec(v) {
  if (v instanceof Decimal) return v;
  if (v === undefined || v === null) return new Decimal(0);
  return new Decimal(v.toString());
}
function toHuman(atomicStr, decimals) {
  return toDec(atomicStr).div(Decimal.pow(10, decimals));
}

class CPMMAdapter {
  constructor(connection, poolAddress, poolData = null) {
    this.connection = connection;
    this.poolAddress = new PublicKey(poolAddress);
    this.poolData = poolData || {};

    const pd = this.poolData;

    this.tokenXMint = pd.baseMint || pd.mintA || pd.raw?.mintA || pd.raw?.mint_a || pd.mint_x || pd.raw?.mint_x || null;
    this.tokenYMint = pd.quoteMint || pd.mintB || pd.raw?.mintB || pd.raw?.mint_b || pd.mint_y || pd.raw?.mint_y || null;

    this.tokenXDecimals = pd.baseDecimals ?? pd.decimalsA ?? pd.raw?.baseDecimals ?? pd.raw?.decimalsA ?? pd.decA ?? null;
    this.tokenYDecimals = pd.quoteDecimals ?? pd.decimalsB ?? pd.raw?.quoteDecimals ?? pd.raw?.decimalsB ?? pd.decB ?? null;

    this.feeBps = pd.feeBps ?? pd.fee_bps ?? pd.raw?.feeBps ?? 25;

    // Reserves may be in many forms
    this.xReserveRaw = pd.xReserve ?? pd.baseReserve ?? pd.reserve_x ?? pd.raw?.reserve_x ?? pd.raw?.baseReserve ?? null;
    this.yReserveRaw = pd.yReserve ?? pd.quoteReserve ?? pd.reserve_y ?? pd.raw?.reserve_y ?? pd.raw?.quoteReserve ?? null;
  }

  async init() { return this; }

  _normalizeQuote({ inAmountAtomic, outAmountAtomic, minOutAtomic, swapForY, executionPrice, priceImpact }) {
    const inDecimals = swapForY ? this.tokenXDecimals : this.tokenYDecimals;
    const outDecimals = swapForY ? this.tokenYDecimals : this.tokenXDecimals;
    ensure(Number.isInteger(inDecimals) && Number.isInteger(outDecimals), 'CPMMAdapter missing token decimals');

    const inHuman = toHuman(inAmountAtomic, inDecimals);
    const outHuman = toHuman(outAmountAtomic, outDecimals);
    const minOutHuman = toHuman(minOutAtomic, outDecimals);

    const execPx = executionPrice != null
      ? Number(executionPrice)
      : (inHuman.gt(0) ? outHuman.div(inHuman).toNumber() : 0);

    return {
      inAmountRaw: String(inAmountAtomic),
      outAmountRaw: String(outAmountAtomic),
      minOutAmountRaw: String(minOutAtomic),

      inAmountDecimal: inHuman.toNumber(),
      outAmountDecimal: outHuman.toNumber(),
      minOutAmountDecimal: minOutHuman.toNumber(),

      executionPrice: execPx,
      priceImpact: Number(priceImpact ?? 0),
      fee: Number(this.feeBps) / 10000,

      poolAddress: this.poolAddress.toBase58(),
      dexType: 'RAYDIUM_CPMM',
      swapForY: Boolean(swapForY),

      success: true,
      error: null
    };
  }

  async quoteFastExactIn(inAmountAtomic, swapForY = true, slippageBps = 50) {
    return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps);
  }

  async quoteExactIn(inAmountAtomic, swapForY = true, slippageBps = 50) {
    ensure(inAmountAtomic != null, 'inAmountAtomic required');
    const xR = this.xReserveRaw;
    const yR = this.yReserveRaw;
    ensure(xR != null && yR != null, 'CPMM reserves missing (run enrich reserves first)');
    const x = toDec(xR);
    const y = toDec(yR);
    ensure(x.gt(0) && y.gt(0), 'CPMM reserves are zero (cannot quote)');

    const inAmt = toDec(inAmountAtomic);
    ensure(inAmt.gt(0), 'inAmountAtomic must be > 0');

    const feeRate = new Decimal(this.feeBps).div(10000);
    const oneMinusFee = new Decimal(1).minus(feeRate);

    let out;
    if (swapForY) {
      // X -> Y
      const inAfterFee = inAmt.mul(oneMinusFee);
      out = inAfterFee.mul(y).div(x.add(inAfterFee));
    } else {
      // Y -> X
      const inAfterFee = inAmt.mul(oneMinusFee);
      out = inAfterFee.mul(x).div(y.add(inAfterFee));
    }

    // slippage on output
    const slip = new Decimal(slippageBps).div(10000);
    const minOut = out.mul(new Decimal(1).minus(slip)).floor();

    // mid price (ui) for priceImpact
    const xDec = this.tokenXDecimals;
    const yDec = this.tokenYDecimals;
    ensure(Number.isInteger(xDec) && Number.isInteger(yDec), 'CPMMAdapter missing decimals for midPrice');

    const xUi = x.div(Decimal.pow(10, xDec));
    const yUi = y.div(Decimal.pow(10, yDec));
    const midPrice = xUi.gt(0) ? yUi.div(xUi) : new Decimal(0);

    // execution price (ui)
    const inDec = swapForY ? xDec : yDec;
    const outDec = swapForY ? yDec : xDec;

    const inUi = inAmt.div(Decimal.pow(10, inDec));
    const outUi = out.div(Decimal.pow(10, outDec));
    const execPrice = inUi.gt(0) ? outUi.div(inUi) : new Decimal(0);

    const priceImpact = (midPrice.gt(0) && execPrice.gt(0))
      ? midPrice.minus(execPrice).abs().div(midPrice).toNumber()
      : 0;

    return this._normalizeQuote({
      inAmountAtomic: inAmt.toFixed(0),
      outAmountAtomic: out.floor().toFixed(0),
      minOutAtomic: minOut.toFixed(0),
      swapForY,
      executionPrice: execPrice.toNumber(),
      priceImpact
    });
  }
}

module.exports = CPMMAdapter;
module.exports.CPMMAdapter = CPMMAdapter;

//  node ./engine/Q_cpmm.fixed.js pools.json 1000000000 results_CPMM.json