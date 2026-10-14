export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[bytes.length - 1 - i];
  }
  return out;
}

export function u8(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff);
}

export function u16LE(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

export function u32LE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

export function u64LE(value: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

export function compactSize(value: number): Uint8Array {
  if (value < 0xfd) return u8(value);
  if (value <= 0xffff) return concatBytes(u8(0xfd), u16LE(value));
  if (value <= 0xffffffff) return concatBytes(u8(0xfe), u32LE(value));
  return concatBytes(u8(0xff), u64LE(value));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function varSlice(data: Uint8Array): Uint8Array {
  return concatBytes(compactSize(data.length), data);
}

export function readCompactSize(
  bytes: Uint8Array,
  offset: number
): { value: number; size: number } {
  if (offset < 0 || offset >= bytes.length) {
    throw new Error('Read past end of buffer');
  }
  const first = bytes[offset]!;
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) {
    if (offset + 3 > bytes.length) throw new Error('Read past end of buffer');
    return { value: bytes[offset + 1]! | (bytes[offset + 2]! << 8), size: 3 };
  }
  if (first === 0xfe) {
    if (offset + 5 > bytes.length) throw new Error('Read past end of buffer');
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4);
    return { value: view.getUint32(0, true), size: 5 };
  }
  if (offset + 9 > bytes.length) throw new Error('Read past end of buffer');
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 8);
  const value = view.getBigUint64(0, true);
  if (value > 0xffffffffn) throw new Error('CompactSize value too large');
  return { value: Number(value), size: 9 };
}

export function readVarSlice(
  bytes: Uint8Array,
  offset: number
): { value: Uint8Array; size: number } {
  const { value: length, size } = readCompactSize(bytes, offset);
  const start = offset + size;
  if (start + length > bytes.length) throw new Error('Read past end of buffer');
  return { value: bytes.slice(start, start + length), size: size + length };
}
