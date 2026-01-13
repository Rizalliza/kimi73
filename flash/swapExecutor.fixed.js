'use strict';

// swapExecutor.fixed.js
// Minimal executor for already-built instructions / or for route legs that are already fully-quoted.
// Fixes:
//  - requires per-leg amountInAtomic/minOutAtomic (prevents accidental reuse of loan amount)
//  - optional compute budget
//
// NOTE: This executor does NOT do quoting. Your buildTriangle/quoter must fill amounts.

const { TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');

let buildSwapIxForPool;
try { ({ buildSwapIxForPool } = require('./flashloanSwapInstructions.fixed.js')); }
catch (e) { ({ buildSwapIxForPool } = require('../flashloanSwapInstructions.fixed.js')); }

function computeBudgetIxs({ unitLimit, unitPriceMicroLamports } = {}) {
  const ixs = [];
  if (unitLimit != null) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Number(unitLimit) }));
  if (unitPriceMicroLamports != null) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(unitPriceMicroLamports) }));
  return ixs;
}

async function executeRoute({ connection, payer, routeLegs, computeBudget, opts = {} }) {
  if (!connection) throw new Error('executeRoute: connection required');
  if (!payer) throw new Error('executeRoute: payer required');
  if (!Array.isArray(routeLegs) || routeLegs.length === 0) throw new Error('executeRoute: routeLegs required');

  const ixs = [];
  ixs.push(...computeBudgetIxs(computeBudget));

  for (let i = 0; i < routeLegs.length; i++) {
    const hop = routeLegs[i];
    if (hop.amountInAtomic == null) throw new Error(`executeRoute: routeLegs[${i}].amountInAtomic missing`);
    if (hop.minOutAtomic == null) throw new Error(`executeRoute: routeLegs[${i}].minOutAtomic missing`);
    const hopIxs = await buildSwapIxForPool(hop, payer.publicKey, { connection, ...opts });
    if (Array.isArray(hopIxs)) ixs.push(...hopIxs);
    else ixs.push(hopIxs);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: Boolean(opts.skipPreflight),
    maxRetries: opts.maxRetries ?? 2,
  });

  if (!opts.skipConfirm) {
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  }
  return { signature: sig };
}

module.exports = { executeRoute };
