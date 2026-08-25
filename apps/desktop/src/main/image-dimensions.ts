export interface ImageDimensions {
  width: number;
  height: number;
}

const MAX_DIMENSION = 100_000;
const MAX_JPEG_SEGMENTS = 1_024;

function accepted(width: number, height: number): ImageDimensions | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return undefined;
  return { width, height };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! * 0x1000000) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (
    bytes.byteLength < 24
    || bytes[0] !== 0x89
    || ascii(bytes, 1, 3) !== "PNG"
    || bytes[4] !== 0x0d
    || bytes[5] !== 0x0a
    || bytes[6] !== 0x1a
    || bytes[7] !== 0x0a
    || u32be(bytes, 8) !== 13
    || ascii(bytes, 12, 4) !== "IHDR"
  ) return undefined;
  return accepted(u32be(bytes, 16), u32be(bytes, 20));
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 10) return undefined;
  const header = ascii(bytes, 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return undefined;
  return accepted(u16le(bytes, 6), u16le(bytes, 8));
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  for (let segments = 0; segments < MAX_JPEG_SEGMENTS && offset < bytes.byteLength; segments += 1) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return undefined;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.byteLength) return undefined;
    const segmentLength = u16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return undefined;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return undefined;
      return accepted(u16be(bytes, offset + 5), u16be(bytes, offset + 3));
    }
    offset += segmentLength;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 21 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const type = ascii(bytes, 12, 4);
  if (type === "VP8X") {
    if (bytes.byteLength < 30) return undefined;
    return accepted(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  }
  if (type === "VP8 ") {
    if (bytes.byteLength < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return accepted(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  if (type === "VP8L") {
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return undefined;
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    return accepted((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return undefined;
}

export function probeRasterDimensions(bytes: Uint8Array, mimeType: string): ImageDimensions | undefined {
  switch (mimeType) {
    case "image/png": return pngDimensions(bytes);
    case "image/jpeg": return jpegDimensions(bytes);
    case "image/gif": return gifDimensions(bytes);
    case "image/webp": return webpDimensions(bytes);
    default: return undefined;
  }
}