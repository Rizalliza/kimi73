'use strict';

// flashloanSwapInstructions.fixed.js
// Fixes:
//  - uses per-hop amountInAtomic (NOT the same loanAmount for every hop)
//  - supports passing pre-quoted minOutAtomic + remaining accounts (bin arrays / tick arrays) so you can be math-first
//  - keeps SDK/instruction-builder usage for the "final mile"
//
// This file is intentionally conservative: it will THROW if a hop is missing required fields.
// That prevents "silent wrongness" that looks profitable but fails on-chain.

const { PublicKey, TransactionInstruction, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');

let MeteoraDlmm = null;
try {
  const m = require('@meteora-ag/dlmm');
  MeteoraDlmm = m.DLMM || m.default || m;
} catch (_) { /* optional */ }

// ---------- small helpers ----------
const pubkeyOf = (k) => (k instanceof PublicKey ? k : new PublicKey(String(k)));
const ensure = (cond, msg) => { if (!cond) throw new Error(msg); };

function addComputeBudgetIxs({ unitLimit, unitPriceMicroLamports } = {}) {
  const ixs = [];
  if (unitLimit != null) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Number(unitLimit) }));
  if (unitPriceMicroLamports != null) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(unitPriceMicroLamports) }));
  }
  return ixs;
}

// ---------- DEX-specific swap ix builders (only DLMM implemented here) ----------
async function buildMeteoraDlmmSwapIxs(hop, payer, connection) {
  ensure(MeteoraDlmm, 'Meteora DLMM: @meteora-ag/dlmm is not installed');
  ensure(connection, 'Meteora DLMM: connection required');

  const poolAddress = hop.poolAddress || hop.address || hop.id;
  ensure(poolAddress, 'Meteora DLMM: hop.poolAddress required');
  ensure(hop.inputMint && hop.outputMint, 'Meteora DLMM: hop.inputMint/outputMint required');
  ensure(hop.amountInAtomic != null, 'Meteora DLMM: hop.amountInAtomic required');
  ensure(hop.minOutAtomic != null, 'Meteora DLMM: hop.minOutAtomic required');

  const inst = await MeteoraDlmm.create(connection, pubkeyOf(poolAddress));

  // bin arrays: accept either `binArrays` (string[]) or `binArraysPubkey` (string[])
  const binArrayList = hop.binArraysPubkey || hop.binArrays || (hop.quote && hop.quote.binArrays) || null;
  ensure(Array.isArray(binArrayList) && binArrayList.length > 0, 'Meteora DLMM: missing bin arrays (hop.binArrays)');

  const binArraysPubkey = binArrayList.map(pubkeyOf);

  // Prefer the SDK's swap builder (returns a Transaction or object with `instructions`)
  if (typeof inst.swap === 'function') {
    const BN = (await import('bn.js')).default;
    const txOrObj = await inst.swap({
      inToken: pubkeyOf(hop.inputMint),
      outToken: pubkeyOf(hop.outputMint),
      inAmount: new BN(String(hop.amountInAtomic)),
      minOutAmount: new BN(String(hop.minOutAtomic)),
      lbPair: pubkeyOf(poolAddress),
      user: pubkeyOf(payer),
      binArraysPubkey,
    });

    // SDKs vary; normalize to instruction array
    if (txOrObj instanceof Transaction) return txOrObj.instructions;
    if (txOrObj && Array.isArray(txOrObj.instructions)) return txOrObj.instructions;
    if (txOrObj && Array.isArray(txOrObj.ixs)) return txOrObj.ixs;
  }

  throw new Error('Meteora DLMM: SDK did not expose inst.swap() in expected form');
}

async function buildSwapIxForPool(hop, payer, opts = {}) {
  ensure(hop && typeof hop === 'object', 'buildSwapIxForPool: hop object required');
  ensure(hop.dexType || hop.dex, 'buildSwapIxForPool: hop.dexType/hop.dex required');

  const dex = (hop.dexType || hop.dex || '').toUpperCase();

  if (dex.includes('METEORA') || dex.includes('DLMM')) {
    return await buildMeteoraDlmmSwapIxs(hop, payer, opts.connection);
  }

  throw new Error(`buildSwapIxForPool: unsupported dex for fixed builder: ${dex}`);
}

// ---------- Flashloan wrapper ----------
async function buildFlashloanTx({
  connection,
  payerKeypair,
  loanMint,
  loanAmountAtomic,
  routeLegs,
  flashloanInstructionBuilder,
  borrowerProgramId,
  computeBudget,
  opts = {}
}) {
  ensure(connection, 'connection required');
  ensure(payerKeypair, 'payerKeypair required');
  ensure(Array.isArray(routeLegs) && routeLegs.length > 0, 'routeLegs[] required');
  ensure(typeof flashloanInstructionBuilder === 'function', 'flashloanInstructionBuilder function required');

  const payer = payerKeypair.publicKey;

  const perHopIxs = [];
  for (let i = 0; i < routeLegs.length; i++) {
    const hop = routeLegs[i];
    // HARD REQUIRE: amounts are per-hop (triangle builder must propagate amounts)
    ensure(hop.amountInAtomic != null, `routeLegs[${i}].amountInAtomic missing`);
    ensure(hop.minOutAtomic != null, `routeLegs[${i}].minOutAtomic missing`);

    const ixs = await buildSwapIxForPool(hop, payer, { connection, ...opts });
    if (Array.isArray(ixs)) perHopIxs.push(...ixs);
    else perHopIxs.push(ixs);
  }

  const flashIx = await flashloanInstructionBuilder({
    connection,
    payer,
    loanMint: loanMint ? pubkeyOf(loanMint) : null,
    loanAmountAtomic: String(loanAmountAtomic ?? loanAmountAtomic === 0 ? loanAmountAtomic : loanAmountAtomic),
    borrowerProgramId: borrowerProgramId ? pubkeyOf(borrowerProgramId) : null,
    callbackIxs: perHopIxs,
  });

  // Build transaction (compute budget + flashloan ix)
  const tx = new Transaction();
  for (const ix of addComputeBudgetIxs(computeBudget)) tx.add(ix);
  tx.add(flashIx);

  return { tx, signers: [payerKeypair] };
}

module.exports = {
  addComputeBudgetIxs,
  buildSwapIxForPool,
  buildFlashloanTx,
};
