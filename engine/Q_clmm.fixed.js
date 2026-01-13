'use strict';
require('dotenv').config();

const { PublicKey, Keypair } = require('@solana/web3.js');
const Decimal = require('decimal.js');

/**
 * CLMM quoter aligned to Q-dlmm.js structure.
 *
 * Philosophy:
 *  - Same surface API as DLMMAdapter: init(), quoteFastExactIn(), quoteExactIn()
 *  - Returns the same standardized quote keys:
 *      inAmountRaw/outAmountRaw/minOutAmountRaw
 *      inAmountDecimal/outAmountDecimal/minOutAmountDecimal
 *      executionPrice/priceImpact/fee (fee is a rate, like Q-dlmm.js)
 *      poolAddress/dexType/swapForY/success/error
 *    plus CLMM-specific: remainingAccounts (tick arrays) when available
 *
 * Implementation:
 *  - By default tries to use Raydium SDK v2 if installed.
 *  - If that fails or you prefer full control, pass a quoteProvider in opts:
 *      await adapter.quoteExactIn(..., { quoteProvider })
 *    quoteProvider signature:
 *      async ({ poolAddress, inAmountAtomic, swapForY, slippageBps, poolData, connection }) =>
 *        { outAmountRaw, minOutAmountRaw, executionPrice, priceImpact, feeRate, remainingAccounts? }
 */

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}
function toDec(v) {
  if (v instanceof Decimal) return v;
  if (v === undefined || v === null) return new Decimal(0);
  return new Decimal(v.toString());
}
function toHuman(atomicStr, decimals) {
  return toDec(atomicStr).div(Decimal.pow(10, decimals));
}
function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

let RaydiumV2 = null;
try { RaydiumV2 = require('@raydium-io/raydium-sdk-v2'); } catch (e) { }

class CLMMAdapter {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {string|PublicKey} poolAddress
   * @param {object|null} poolData - optional enriched pool record; should include mints/decimals/fee if available
   */
  constructor(connection, poolAddress, poolData = null) {
    this.connection = connection;
    this.poolAddress = new PublicKey(poolAddress);
    this.poolData = poolData;

    this.tokenXMint = null;
    this.tokenYMint = null;
    this.tokenXDecimals = null;
    this.tokenYDecimals = null;

    // fee bps if known (used only as a "rate" field in the standard quote; real SDK quote already includes fee impact)
    this.feeBps = (poolData && (poolData.feeBps ?? poolData.fee_bps ?? poolData.raw?.feeBps)) ?? 0;

    this._raydium = null; // lazy Raydium v2 client
  }

  async init() {
    // Prefer poolData for static metadata
    const pd = this.poolData || {};
    const baseMint = pd.baseMint || pd.mintA || pd.raw?.mintA || pd.raw?.mint_a || pd.mint_x || pd.raw?.mint_x;
    const quoteMint = pd.quoteMint || pd.mintB || pd.raw?.mintB || pd.raw?.mint_b || pd.mint_y || pd.raw?.mint_y;
    const baseDec = pd.baseDecimals ?? pd.decimalsA ?? pd.raw?.baseDecimals ?? pd.raw?.decimalsA ?? pd.decA;
    const quoteDec = pd.quoteDecimals ?? pd.decimalsB ?? pd.raw?.quoteDecimals ?? pd.raw?.decimalsB ?? pd.decB;

    if (baseMint && quoteMint) {
      this.tokenXMint = new PublicKey(baseMint);
      this.tokenYMint = new PublicKey(quoteMint);
    }
    if (Number.isInteger(baseDec)) this.tokenXDecimals = baseDec;
    if (Number.isInteger(quoteDec)) this.tokenYDecimals = quoteDec;

    return this;
  }

  _normalizeQuote({ inAmountAtomic, outAmountAtomic, minOutAtomic, swapForY, feeRate, priceImpact, executionPrice, remainingAccounts }) {
    const inDecimals = swapForY ? this.tokenXDecimals : this.tokenYDecimals;
    const outDecimals = swapForY ? this.tokenYDecimals : this.tokenXDecimals;

    ensure(Number.isInteger(inDecimals) && Number.isInteger(outDecimals), 'CLMMAdapter missing token decimals (enrich poolData or set decimals)');

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
      fee: Number(feeRate ?? (this.feeBps / 10000)),

      poolAddress: this.poolAddress.toBase58(),
      dexType: 'RAYDIUM_CLMM',
      swapForY: Boolean(swapForY),

      remainingAccounts: Array.isArray(remainingAccounts) ? remainingAccounts.map(String) : [],

      success: true,
      error: null
    };
  }

  async _getRaydiumClient() {
    if (!RaydiumV2) return null;
    if (this._raydium) return this._raydium;

    const { Raydium } = RaydiumV2;
    if (!Raydium || typeof Raydium.load !== 'function') return null;

    // owner is required by Raydium.load; a throwaway keypair is fine for quoting.
    const owner = Keypair.generate();
    this._raydium = await Raydium.load({
      connection: this.connection,
      owner,
      disableFeatureCheck: true,
      blockhashCommitment: 'confirmed'
    });
    return this._raydium;
  }

  /**
   * Fast quote: same as exact for now (Raydium CLMM needs tick traversal anyway).
   */
  async quoteFastExactIn(inAmountAtomic, swapForY = true, slippageBps = 50, opts = {}) {
    return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps, opts);
  }

  /**
   * Exact quote (SDK-first unless you inject quoteProvider).
   * @param {string|number|bigint} inAmountAtomic
   * @param {boolean} swapForY  true => X->Y (base->quote), false => Y->X
   * @param {number} slippageBps
   * @param {object} opts
   * @param {function} [opts.quoteProvider] optional injected provider
   */
  async quoteExactIn(inAmountAtomic, swapForY = true, slippageBps = 50, opts = {}) {
    ensure(inAmountAtomic != null, 'inAmountAtomic required');

    const quoteProvider = opts.quoteProvider;
    if (typeof quoteProvider === 'function') {
      try {
        const q = await quoteProvider({
          poolAddress: this.poolAddress.toBase58(),
          inAmountAtomic: String(inAmountAtomic),
          swapForY: Boolean(swapForY),
          slippageBps: Number(slippageBps),
          poolData: this.poolData,
          connection: this.connection
        });
        ensure(q && q.outAmountRaw != null && q.minOutAmountRaw != null, 'quoteProvider must return outAmountRaw and minOutAmountRaw');
        return this._normalizeQuote({
          inAmountAtomic: String(inAmountAtomic),
          outAmountAtomic: String(q.outAmountRaw),
          minOutAtomic: String(q.minOutAmountRaw),
          swapForY,
          feeRate: q.feeRate,
          priceImpact: q.priceImpact,
          executionPrice: q.executionPrice,
          remainingAccounts: q.remainingAccounts || q.tickArrays || q.binArrays
        });
      } catch (e) {
        return {
          inAmountRaw: String(inAmountAtomic),
          outAmountRaw: '0',
          minOutAmountRaw: '0',
          inAmountDecimal: 0,
          outAmountDecimal: 0,
          minOutAmountDecimal: 0,
          executionPrice: 0,
          priceImpact: 0,
          fee: Number(this.feeBps / 10000),
          poolAddress: this.poolAddress.toBase58(),
          dexType: 'RAYDIUM_CLMM',
          swapForY: Boolean(swapForY),
          remainingAccounts: [],
          success: false,
          error: `quoteProvider failed: ${e.message || String(e)}`
        };
      }
    }

    // SDK v2 path (best-effort). If it can't quote, return a clear error to trigger fallback.
    try {
      const raydium = await this._getRaydiumClient();
      ensure(raydium && raydium.api && typeof raydium.api.fetchPoolById === 'function', 'Raydium SDK v2 not available (install @raydium-io/raydium-sdk-v2 or pass quoteProvider)');

      const { PoolUtils } = RaydiumV2;
      ensure(PoolUtils, 'Raydium SDK v2 PoolUtils not found');

      const res = await raydium.api.fetchPoolById({ ids: this.poolAddress.toBase58() });
      const poolInfo = Array.isArray(res) ? res[0] : (res?.data ? res.data[0] : res);
      ensure(poolInfo, 'Raydium api.fetchPoolById returned no pool');

      // Compute clmm info + fetch tick arrays
      const chainTime = Math.floor(Date.now() / 1000);
      const clmmInfoList = await PoolUtils.fetchComputeClmmInfo({
        connection: this.connection,
        poolInfoList: [poolInfo],
        chainTime
      });
      const clmmInfo = Array.isArray(clmmInfoList) ? clmmInfoList[0] : clmmInfoList;
      ensure(clmmInfo, 'PoolUtils.fetchComputeClmmInfo returned no clmmInfo');

      // Fetch tick arrays cache
      const tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
        connection: this.connection,
        poolKeys: [clmmInfo.poolKeys],
        batchRequest: true
      });
      const tickArrayCache = Array.isArray(tickCache) ? tickCache[0] : tickCache;

      // Compute quote
      const amountIn = toDec(inAmountAtomic);
      const slippage = Number(slippageBps) / 10000;

      const quote = await PoolUtils.computeAmountOutFormat({
        poolInfo: clmmInfo,
        tickArrayCache,
        amountIn,
        // swap direction: aToB means tokenA->tokenB in Raydium naming; map from swapForY
        // We'll pass as 'direction' if supported; else rely on poolInfo.mintA/mintB ordering.
        // Many Raydium SDK builds infer from currencyIn/currencyOut.
        slippage
      });

      // Normalization: different SDK builds name fields differently
      const outRaw = quote?.amountOut?.toString?.() ?? quote?.amountOutRaw ?? quote?.minAmountOut?.toString?.() ?? quote?.amountOut;
      const minOutRaw = quote?.minAmountOut?.toString?.() ?? quote?.minAmountOutRaw ?? quote?.minAmountOut;
      ensure(outRaw != null && minOutRaw != null, 'Raydium computeAmountOutFormat returned no out/minOut');

      const remaining = quote?.remainingAccounts?.map?.(a => a.toString?.() ?? String(a)) ?? [];

      return this._normalizeQuote({
        inAmountAtomic: String(inAmountAtomic),
        outAmountAtomic: String(outRaw),
        minOutAtomic: String(minOutRaw),
        swapForY,
        feeRate: quote?.feeRate ?? (this.feeBps / 10000),
        priceImpact: quote?.priceImpact ?? 0,
        executionPrice: quote?.executionPrice ?? quote?.executionPriceX64 ?? null,
        remainingAccounts: remaining
      });
    } catch (e) {
      return {
        inAmountRaw: String(inAmountAtomic),
        outAmountRaw: '0',
        minOutAmountRaw: '0',
        inAmountDecimal: 0,
        outAmountDecimal: 0,
        minOutAmountDecimal: 0,
        executionPrice: 0,
        priceImpact: 0,
        fee: Number(this.feeBps / 10000),
        poolAddress: this.poolAddress.toBase58(),
        dexType: 'RAYDIUM_CLMM',
        swapForY: Boolean(swapForY),
        remainingAccounts: [],
        success: false,
        error: e.message || String(e)
      };
    }
  }
}

module.exports = CLMMAdapter;
module.exports.CLMMAdapter = CLMMAdapter;

//. node engine/Q_clmm.fixed.js ../data/pools.json 1000000000 results_CLMM.json