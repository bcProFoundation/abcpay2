import { describe, expect, it } from 'vitest';
import { formatAmount, formatFiatUsd, formatFixed } from '../derivation';

describe('formatFixed', () => {
  it('groups thousands and keeps fixed decimals', () => {
    expect(formatFixed(689169783.73, 2)).toBe('689,169,783.73');
    expect(formatFixed(1000, 2)).toBe('1,000.00');
    expect(formatFixed(0.5, 2)).toBe('0.50');
    expect(formatFixed(42, 0)).toBe('42');
  });

  it('handles non-finite values', () => {
    expect(formatFixed(Number.NaN, 2)).toBe('0.00');
  });
});

describe('formatFiatUsd', () => {
  it('formats USD with grouping', () => {
    expect(formatFiatUsd(1234.5)).toBe('$1,234.50');
    expect(formatFiatUsd(0)).toBe('$0.00');
  });
});

describe('formatAmount', () => {
  it('formats XEC with unit and grouping', () => {
    // 689169783.73 XEC = 68916978373 base units (2 decimals)
    expect(formatAmount('xec', 68_916_978_373)).toBe('689,169,783.73 XEC');
  });
});
