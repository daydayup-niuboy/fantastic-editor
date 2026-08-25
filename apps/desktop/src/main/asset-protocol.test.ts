import { describe, expect, it } from "vitest";
import { parseAssetHandleUrl } from "./asset-protocol.js";

const HANDLE = "00000000-0000-4000-8000-000000000001";

describe("parseAssetHandleUrl", () => {
  it("accepts only the canonical asset host and UUID path", () => {
    expect(parseAssetHandleUrl(`fantastic-asset://asset/${HANDLE}`)).toBe(HANDLE);
  });

  it.each([
    `https://asset/${HANDLE}`,
    `fantastic-asset://other/${HANDLE}`,
    `fantastic-asset://user@asset/${HANDLE}`,
    `fantastic-asset://asset/${HANDLE}?copy=1`,
    `fantastic-asset://asset/${HANDLE}#fragment`,
    `fantastic-asset://asset/${HANDLE}/extra`,
    "fantastic-asset://asset/not-a-uuid",
  ])("rejects non-canonical URL %s", (url) => {
    expect(parseAssetHandleUrl(url)).toBeUndefined();
  });
});