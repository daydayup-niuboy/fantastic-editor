import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedDocument } from "./model.js";
import { parseDocument } from "./parser.js";

const fixturesRoot = resolve(import.meta.dirname, "../fixtures");

describe("UDM 0.5 golden fixtures", async () => {
  const entries = (await readdir(fixturesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    it(`matches ${entry.name}`, async () => {
      const directory = join(fixturesRoot, entry.name);
      const editorText = await readFile(join(directory, "input.md"), "utf8");
      const expected = JSON.parse(await readFile(join(directory, "expected.parsed-document.json"), "utf8")) as ParsedDocument;
      const expectedDiagnostics = JSON.parse(await readFile(join(directory, "expected-diagnostics.json"), "utf8")) as ParsedDocument["diagnostics"];
      const actual = await parseDocument({ documentId: `fixture-${entry.name}`, editorText });
      expect(actual).toEqual(expected);
      expect(actual.diagnostics).toEqual(expectedDiagnostics);
    });
  }
});