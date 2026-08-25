import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(scriptDirectory, "../fixtures");
for (const entry of await readdir(fixturesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(fixturesRoot, entry.name);
  const editorText = await readFile(join(directory, "input.md"), "utf8");
  const parsed = await parseDocument({ documentId: `fixture-${entry.name}`, editorText });
  await writeFile(join(directory, "expected.parsed-document.json"), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await writeFile(join(directory, "expected-diagnostics.json"), `${JSON.stringify(parsed.diagnostics, null, 2)}\n`, "utf8");
}