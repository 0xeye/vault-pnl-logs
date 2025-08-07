export const ZERO = 0n;

export const add = (a: bigint, b: bigint): bigint => a + b;
export const subtract = (a: bigint, b: bigint): bigint => a - b;
export const multiply = (a: bigint, b: bigint): bigint => a * b;
export const divide = (a: bigint, b: bigint): bigint => b !== ZERO ? a / b : ZERO;

export const safeRatio = (numerator: bigint, denominator: bigint, fallback: bigint = ZERO): bigint =>
  denominator > ZERO ? divide(numerator, denominator) : fallback;

export const isPositive = (value: bigint): boolean => value > ZERO;
export const isZero = (value: bigint): boolean => value === ZERO;
export const isNegative = (value: bigint): boolean => value < ZERO;