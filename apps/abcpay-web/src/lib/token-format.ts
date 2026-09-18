export function formatTokenAtoms(atoms: string, decimals?: number): string {
  try {
    const value = BigInt(atoms);
    if (!decimals) return value.toString();
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return atoms;
  }
}

export function parseTokenAtoms(value: string, decimals = 0): bigint {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Amount is required');
  const [wholePart = '0', fractionPart = ''] = trimmed.split('.');
  if (!/^\d*$/.test(wholePart) || !/^\d*$/.test(fractionPart)) throw new Error('Invalid amount');
  if (fractionPart.length > decimals) {
    throw new Error(`At most ${decimals} decimal place${decimals === 1 ? '' : 's'} are supported`);
  }
  const padded = (fractionPart + '0'.repeat(decimals)).slice(0, decimals);
  const atoms = BigInt(wholePart || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  if (atoms <= 0n) throw new Error('Amount must be greater than zero');
  return atoms;
}

export function tokenLabel(token: { ticker?: string; name?: string; tokenId: string }): string {
  return token.ticker || token.name || `${token.tokenId.slice(0, 8)}…`;
}
