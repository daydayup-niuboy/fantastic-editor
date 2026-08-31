import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const executable = resolve(repositoryRoot, "release", "win-unpacked", "fantastic-editor.exe");
const smokeRoot = resolve(repositoryRoot, "build-tmp", `production-smokes-${packageJson.version}`);
const artifactRoot = resolve(smokeRoot, "artifacts");
const pdfPath = resolve(artifactRoot, "fixed-export.pdf");
const docxPath = resolve(artifactRoot, "fixed-export.docx");
const htmlPath = resolve(artifactRoot, "fixed-export.html");
const uiScreenshotPath = resolve(smokeRoot, "fantastic-editor-ui-smoke.png");

await mkdir(artifactRoot, { recursive: true });
const executableStat = await stat(executable);
if (!executableStat.isFile() || executableStat.size < 20 * 1024 * 1024) {
  throw new Error("Packaged fantastic-editor executable is missing or unexpectedly small. Run a Windows distribution build first.");
}

const scenarios = [
  { id: "basic", env: { FANTASTIC_EDITOR_SMOKE_TEST: "1" }, timeout: 45_000 },
  { id: "pdf", env: { FANTASTIC_EDITOR_PDF_SMOKE_TEST: "1", FANTASTIC_EDITOR_PDF_SMOKE_OUTPUT: pdfPath }, timeout: 90_000 },
  { id: "docx", env: { FANTASTIC_EDITOR_DOCX_SMOKE_TEST: "1", FANTASTIC_EDITOR_DOCX_SMOKE_OUTPUT: docxPath }, timeout: 90_000 },
  { id: "offline-html", env: { FANTASTIC_EDITOR_OFFLINE_HTML_SMOKE_TEST: "1", FANTASTIC_EDITOR_OFFLINE_HTML_SMOKE_OUTPUT: htmlPath }, timeout: 90_000 },
  { id: "formula", env: { FANTASTIC_EDITOR_FORMULA_SMOKE_TEST: "1" }, timeout: 45_000 },
  { id: "mermaid", env: { FANTASTIC_EDITOR_MERMAID_SMOKE_TEST: "1" }, timeout: 45_000 },
  { id: "ui", env: { FANTASTIC_EDITOR_UI_SMOKE_TEST: "1" }, timeout: 180_000 },
];

const scenarioResults = [];

async function waitForSmokeResult(path, scenario, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(path, "utf8"));
      if (result?.schema !== "fantastic-editor-smoke-result-v1" || result.scenario !== scenario || result.valid !== true) {
        throw new Error(`Production smoke ${scenario} returned an invalid completion marker.`);
      }
      return result;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Production smoke ${scenario} did not complete within ${timeout} ms.`);
}

for (const scenario of scenarios) {
  const userDataDirectory = resolve(smokeRoot, `user-data-${scenario.id}`);
  const resultPath = resolve(smokeRoot, `result-${scenario.id}.json`);
  await mkdir(userDataDirectory, { recursive: true });
  await rm(resultPath, { force: true });
  const result = spawnSync(executable, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", `--user-data-dir=${userDataDirectory}`], {
    cwd: smokeRoot,
    env: {
      ...process.env,
      TEMP: smokeRoot,
      TMP: smokeRoot,
      FANTASTIC_EDITOR_SMOKE_RESULT: resultPath,
      ...scenario.env,
    },
    encoding: "utf8",
    timeout: scenario.timeout,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Production smoke ${scenario.id} could not run.`, { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`Production smoke ${scenario.id} exited with ${result.status ?? "no status"}.\n${result.stderr || result.stdout || "No diagnostic output."}`);
  }
  const completion = await waitForSmokeResult(resultPath, scenario.id, scenario.timeout);
  scenarioResults.push({ id: scenario.id, exitCode: 0, completedAt: completion.completedAt });
  console.log(`production smoke ${scenario.id}: passed`);
}

const pdf = await readFile(pdfPath);
if (pdf.byteLength < 1_000 || pdf.toString("ascii", 0, 4) !== "%PDF") throw new Error("Fixed PDF smoke artifact is invalid.");

const docx = await readFile(docxPath);
if (docx.byteLength < 1_000 || docx[0] !== 0x50 || docx[1] !== 0x4b) throw new Error("Fixed DOCX smoke artifact is not a ZIP package.");
const docxZip = await JSZip.loadAsync(docx);
const documentXmlEntry = docxZip.file("word/document.xml");
if (!docxZip.file("[Content_Types].xml") || !documentXmlEntry) throw new Error("Fixed DOCX smoke artifact is missing required package entries.");
const documentXml = await documentXmlEntry.async("string");
for (const expectedText of ["DOCX smoke", "Utility Process", "跨页表格", "长代码"]) {
  if (!documentXml.includes(expectedText)) throw new Error(`Fixed DOCX smoke artifact is missing ${expectedText}.`);
}

const html = await readFile(htmlPath, "utf8");
if (!/^<!doctype html>/i.test(html) || !html.includes("<title>离线 HTML smoke</title>")) throw new Error("Fixed offline HTML smoke artifact is invalid.");
if (/<script\b|\son[a-z]+\s*=|(?:file|blob|app|fantastic-asset):/i.test(html)) throw new Error("Fixed offline HTML smoke artifact contains forbidden active content.");
if (!html.includes("data:font/woff2;base64,")) throw new Error("Fixed offline HTML smoke artifact is not font self-contained.");

const screenshotStat = await stat(uiScreenshotPath);
if (!screenshotStat.isFile() || screenshotStat.size < 10_000) throw new Error("Full UI smoke screenshot is missing or unexpectedly small.");

const report = {
  schema: "fantastic-editor-production-smoke-report-v1",
  generatedAt: new Date().toISOString(),
  version: packageJson.version,
  executable: "release/win-unpacked/fantastic-editor.exe",
  scenarios: scenarioResults,
  artifacts: {
    pdf: { path: "artifacts/fixed-export.pdf", byteLength: pdf.byteLength, header: "%PDF" },
    docx: { path: "artifacts/fixed-export.docx", byteLength: docx.byteLength, requiredEntries: ["[Content_Types].xml", "word/document.xml"] },
    html: { path: "artifacts/fixed-export.html", byteLength: Buffer.byteLength(html), selfContainedFont: true, scripts: false },
    uiScreenshot: { path: "fantastic-editor-ui-smoke.png", byteLength: screenshotStat.size },
  },
};
await writeFile(resolve(smokeRoot, "production-smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`production smoke report: ${resolve(smokeRoot, "production-smoke-report.json")}`);
