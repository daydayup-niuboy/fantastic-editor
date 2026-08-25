import { describe, expect, it } from "vitest";
import { probeRasterDimensions } from "./image-dimensions.js";

function png(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0, 0, 0, 0, 0]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe("probeRasterDimensions", () => {
  it("reads bounded PNG and GIF dimensions", () => {
    expect(probeRasterDimensions(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(probeRasterDimensions(Uint8Array.from([71, 73, 70, 56, 57, 97, 0x20, 0x03, 0x58, 0x02]), "image/gif"))
      .toEqual({ width: 800, height: 600 });
  });

  it("reads a JPEG SOF segment and stops on malformed lengths", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 7, 8, 0x02, 0x58, 0x03, 0x20]);
    expect(probeRasterDimensions(jpeg, "image/jpeg")).toEqual({ width: 800, height: 600 });
    expect(probeRasterDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), "image/jpeg")).toBeUndefined();
  });

  it("reads VP8X and VP8L dimensions", () => {
    const vp8x = new Uint8Array(30);
    vp8x.set(new TextEncoder().encode("RIFF"), 0);
    vp8x.set(new TextEncoder().encode("WEBPVP8X"), 8);
    vp8x.set([0x7f, 0x02, 0, 0xdf, 0x01, 0], 24);
    expect(probeRasterDimensions(vp8x, "image/webp")).toEqual({ width: 640, height: 480 });
    const vp8l = new Uint8Array(25);
    vp8l.set(new TextEncoder().encode("RIFF"), 0);
    vp8l.set(new TextEncoder().encode("WEBPVP8L"), 8);
    vp8l[20] = 0x2f;
    const bits = ((320 - 1) | ((240 - 1) << 14)) >>> 0;
    new DataView(vp8l.buffer).setUint32(21, bits, true);
    expect(probeRasterDimensions(vp8l, "image/webp")).toEqual({ width: 320, height: 240 });
  });

  it("rejects truncated, zero and excessive dimensions", () => {
    expect(probeRasterDimensions(png(0, 20), "image/png")).toBeUndefined();
    expect(probeRasterDimensions(png(100_001, 20), "image/png")).toBeUndefined();
    expect(probeRasterDimensions(new Uint8Array(3), "image/gif")).toBeUndefined();
    expect(probeRasterDimensions(png(1, 1), "image/svg+xml")).toBeUndefined();
  });
});