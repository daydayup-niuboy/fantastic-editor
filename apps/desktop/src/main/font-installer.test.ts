import { describe, expect, it } from "vitest";
import { decodeFontInstallOutput, validateFontPath } from "./font-installer.js";

describe("custom font validation", () => {
  it("accepts TTF and OTF files without accepting unrelated local files", () => {
    expect(validateFontPath("C:\\Fonts\\正文.ttf")).toBeNull();
    expect(validateFontPath("C:\\Fonts\\正文.OTF")).toBeNull();
    expect(validateFontPath("C:\\Fonts\\正文.woff2")).toContain("只支持");
    expect(validateFontPath("C:\\Fonts\\说明.txt")).toContain("只支持");
  });

  it("decodes stable font installer messages without exposing PowerShell output", () => {
    const encoded = Buffer.from("平方赖江湖飞扬体", "utf8").toString("base64");
    expect(decodeFontInstallOutput(`FONT_OK:${encoded}`)).toBe("平方赖江湖飞扬体");
    expect(decodeFontInstallOutput("#< CLIXML")).toBeNull();
  });
});
