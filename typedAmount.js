'use strict';

function ensure(cond, msg) { if (!cond) throw new Error(msg); }

/**
 * A typed amount wrapper to stop "fee/decimals" bugs from creeping in.
 * All amounts are stored as ATOMIC STRINGS to avoid JS number precision loss.
 */
function makeAmount({ mint, decimals, atomic }) {
  ensure(mint, 'mint required');
  ensure(Number.isInteger(decimals) && decimals >= 0, 'decimals required');
  ensure(atomic !== undefined && atomic !== null, 'atomic required');
  return { mint: mint.toString(), decimals, atomic: atomic.toString() };
}

/**
 * Attach typed fields to a standard quote object.
 * Standard quote must have inAmountRaw/outAmountRaw/minOutAmountRaw.
 */
function attachTypedToQuote(q, { inMint, outMint, inDecimals, outDecimals, feeMint = null, feeAtomic = null, feeRateBps = null }) {
  q.typed = {
    in: makeAmount({ mint: inMint, decimals: inDecimals, atomic: q.inAmountRaw }),
    out: makeAmount({ mint: outMint, decimals: outDecimals, atomic: q.outAmountRaw }),
    minOut: makeAmount({ mint: outMint, decimals: outDecimals, atomic: q.minOutAmountRaw }),
    fee: feeMint && feeAtomic != null ? makeAmount({ mint: feeMint, decimals: feeMint === inMint ? inDecimals : outDecimals, atomic: feeAtomic }) : null,
    feeRateBps: feeRateBps != null ? Number(feeRateBps) : null
  };

  // Safety rails
  if (q.typed.in.atomic !== q.inAmountRaw.toString()) throw new Error('typed.in.atomic mismatch');
  if (q.typed.out.atomic !== q.outAmountRaw.toString()) throw new Error('typed.out.atomic mismatch');
  if (q.typed.minOut.atomic !== q.minOutAmountRaw.toString()) throw new Error('typed.minOut.atomic mismatch');
  return q;
}

module.exports = { makeAmount, attachTypedToQuote, ensure };
