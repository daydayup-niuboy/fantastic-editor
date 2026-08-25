import { describe, expect, it } from "vitest";
import { transformSvgToPng, validateSvgSource } from "./svg-transform.js";

const encode = (source: string) => new TextEncoder().encode(source);

describe("SVG isolated transform core", () => {
  it("renders a static local-only SVG to a bounded PNG", () => {
    const result = transformSvgToPng(encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#28745b"/></svg>',
    ));
    if (result.status !== "completed") throw new Error(result.code + ": " + result.message);
    expect(result.status).toBe("completed");
    expect(result.width).toBe(80);
    expect(result.height).toBe(40);
    expect([...result.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("scales oversized SVG output without exceeding the safety dimension", () => {
    const result = transformSvgToPng(encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8192" height="2048"><rect width="100%" height="100%"/></svg>',
    ));
    if (result.status !== "completed") throw new Error(result.code + ": " + result.message);
    expect(result.status).toBe("completed");
    expect(result.width).toBe(4096);
    expect(result.height).toBe(1024);
  });

  it.each([
    ['<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"/>', "SVG_DTD_ENTITY_BLOCKED"],
    ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "SVG_EVENT_HANDLER_BLOCKED"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "SVG_ACTIVE_CONTENT_BLOCKED"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>', "SVG_ACTIVE_CONTENT_BLOCKED"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>', "SVG_ACTIVE_CONTENT_BLOCKED"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/a.svg#x"/></svg>', "SVG_EXTERNAL_RESOURCE_BLOCKED"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com/p.svg#x)"/></svg>', "SVG_EXTERNAL_RESOURCE_BLOCKED"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{src:url(font.woff)}</style></svg>', "SVG_ACTIVE_CONTENT_BLOCKED"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><use href="data:image/svg+xml;base64,AA"/></svg>', "SVG_EXTERNAL_RESOURCE_BLOCKED"],
  ])("blocks active or external SVG input", (source, code) => {
    const result = validateSvgSource(encode(source));
    expect(result).toMatchObject({ status: "failed", code });
    expect(JSON.stringify(result)).not.toContain("example.com");
  });

  it("allows internal fragment references", () => {
    const result = transformSvgToPng(encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><defs><path id="shape" d="M0 0h20v20H0z"/></defs><use href="#shape" fill="red"/></svg>',
    ));
    if (result.status !== "completed") throw new Error(result.code + ": " + result.message);
    expect(result.status).toBe("completed");
  });
});