import { describe, expect, it } from "vitest";
import { buildStructuredCodeOutline, structuredBranchEnd, tokenizeStructuredLabel } from "./structured-code";

describe("structured code outline", () => {
  it("builds bounded JSON, YAML, TOML, HTML and common configuration outlines without executing content", () => {
    expect(buildStructuredCodeOutline("json", '{"app":{"port":3000},"flags":[true,false]}')?.rows.map((row) => row.label)).toContain("app {1}");
    expect(buildStructuredCodeOutline("yaml", "server:\n  port: 3000\n  tls: true")?.rows).toContainEqual({ depth: 1, label: "port: 3000", kind: "value" });
    expect(buildStructuredCodeOutline("toml", "[server]\nport = 3000")?.rows.at(-1)?.label).toBe("port: 3000");
    const html = buildStructuredCodeOutline("html", '<main><script>alert(1)</script><p>正文</p></main>');
    expect(html?.rows.map((row) => row.label)).toContain("<script>");
    expect(html?.rows.map((row) => row.label)).toContain("alert(1)");
    expect(buildStructuredCodeOutline("ini", "; note\n[server]\nport=3000")?.rows).toContainEqual({ depth: 1, label: "port: 3000", kind: "value" });
    expect(buildStructuredCodeOutline("dotenv", "# local\nexport API_URL=https://example.test")?.rows.at(-1)?.label).toBe("API_URL: https://example.test");
    expect(buildStructuredCodeOutline("properties", "app.name=fantastic-editor")?.rows[0]?.label).toBe("app.name: fantastic-editor");
  });

  it("rejects unsupported, invalid and oversized input", () => {
    expect(buildStructuredCodeOutline("typescript", "const value = 1")).toBeNull();
    expect(buildStructuredCodeOutline("json", "{invalid}")).toBeNull();
    expect(buildStructuredCodeOutline("json", "x".repeat(200_001))).toBeNull();
  });

  it("finds the bounded descendants of a collapsible branch", () => {
    const rows = buildStructuredCodeOutline("json", '{"app":{"port":3000},"enabled":true}')!.rows;
    expect(structuredBranchEnd(rows, 1)).toBe(3);
    expect(structuredBranchEnd(rows, 2)).toBe(3);
    expect(structuredBranchEnd(rows, 99)).toBe(99);
  });

  it("assigns safe semantic colors without changing source text", () => {
    expect(tokenizeStructuredLabel("json", { depth: 1, label: "port: 3000", kind: "value" })).toEqual([
      { text: "port", kind: "key" }, { text: ": ", kind: "punctuation" }, { text: "3000", kind: "number" },
    ]);
    expect(tokenizeStructuredLabel("yaml", { depth: 1, label: "enabled: true", kind: "value" }).at(-1)?.kind).toBe("boolean");
    expect(tokenizeStructuredLabel("html", { depth: 0, label: "<main>", kind: "branch" })).toEqual([
      { text: "<", kind: "punctuation" }, { text: "main", kind: "tag" }, { text: ">", kind: "punctuation" },
    ]);
  });
});
