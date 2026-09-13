export function formatWalletId(hexId: string): string {
  const hex = hexId.replace(/-/g, '');
  if (hex.length !== 32) return hexId;
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function normalizeWalletId(id: string): string {
  return id.replace(/-/g, '');
}
