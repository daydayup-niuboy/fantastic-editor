import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = resolve(repositoryRoot, "release");
const unpackedDirectory = resolve(releaseDirectory, "win-unpacked");
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));

const forbiddenFile = /(?:wechat-api-config-v1\.json|\.env(?:\.|$)|\.(?:pfx|p12|pvk|key))$/i;
const privateEnvironmentValues = Object.entries(process.env)
  .filter(([key, value]) => key.startsWith("FANTASTIC_EDITOR_WECHAT_") && typeof value === "string" && value.length >= 4)
  .map(([, value]) => Buffer.from(value));
const userProfile = process.env.USERPROFILE ? Buffer.from(process.env.USERPROFILE) : null;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const files = await walk(unpackedDirectory);
const forbidden = files.filter((path) => forbiddenFile.test(path));
if (forbidden.length > 0) {
  throw new Error(`Release contains private configuration files: ${forbidden.join(", ")}`);
}

const packageFiles = [
  ...files,
  resolve(releaseDirectory, `fantastic-editor-${packageJson.version}-portable.exe`),
  resolve(releaseDirectory, `fantastic-editor-${packageJson.version}-setup.exe`),
];
for (const path of packageFiles) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) continue;
  const bytes = await readFile(path);
  for (const value of privateEnvironmentValues) {
    if (value.length > 0 && bytes.includes(value)) {
      throw new Error(`Release contains a value from FANTASTIC_EDITOR_WECHAT_*: ${path}`);
    }
  }
  if (userProfile && userProfile.length >= 8 && bytes.includes(userProfile)) {
    throw new Error(`Release contains the local user profile path: ${path}`);
  }
}

console.log(`release privacy: passed (${packageJson.version}); runtime credentials remain per-user and are not packaged`);
