// utils/decimals.js
// Decimal utility wrapper for high-precision arithmetic

const Decimal = require('decimal.js');

// Configure Decimal for financial calculations
Decimal.set({
    precision: 40,
    rounding: Decimal.ROUND_DOWN,
    toExpNeg: -40,
    toExpPos: 40
});

/**
 * Convert any value to Decimal
 * Handles: number, string, Decimal, BigInt, null, undefined
 */
function toDecimal(value) {
    if (value === null || value === undefined) {
        return new Decimal(0);
    }
    
    if (value instanceof Decimal) {
        return value;
    }
    
    if (typeof value === 'bigint') {
        return new Decimal(value.toString());
    }
    
    if (typeof value === 'object' && value.toString) {
        // Handle BN.js or other big number libraries
        return new Decimal(value.toString());
    }
    
    try {
        return new Decimal(value);
    } catch (err) {
        console.warn(`toDecimal: Failed to convert "${value}" to Decimal, returning 0`);
        return new Decimal(0);
    }
}

module.exports = {
    Decimal,
    toDecimal
};
