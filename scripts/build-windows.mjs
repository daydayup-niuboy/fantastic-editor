import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSigningConfiguration } from "./signing-config.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = resolve(repositoryRoot, "build-tmp");
const electronBuilderCli = resolve(repositoryRoot, "node_modules/electron-builder/out/cli/cli.js");
const electronDistribution = resolve(repositoryRoot, "node_modules/electron/dist");
const signedBuild = process.argv.includes("--signed");
const requestedTargets = process.argv.slice(2).filter((argument) => argument !== "--signed");
const targets = requestedTargets.length > 0 ? requestedTargets : ["nsis", "portable"];

const supportedTargets = new Set(["nsis", "portable"]);
for (const target of targets) {
  if (!supportedTargets.has(target)) throw new Error(`Unsupported Windows target: ${target}`);
}

await mkdir(temporaryDirectory, { recursive: true });

const signingArguments = [];
if (signedBuild) {
  const signing = resolveSigningConfiguration();
  signingArguments.push(
    "--config.forceCodeSigning=true",
    `--config.win.rfc3161TimeStampServer=${signing.timestampServer}`,
    `--config.win.timeStampServer=${signing.timestampServer}`,
  );
  if (signing.certificateSha1) {
    signingArguments.push(`--config.win.certificateSha1=${signing.certificateSha1}`);
  }
}

// Never let a developer's local公众号 credentials leak into the packaging
// process. Runtime configuration is intentionally resolved from Electron's
// per-user data directory after installation; build-time env values are not
// part of a release artifact.
const buildEnvironment = { ...process.env };
for (const key of Object.keys(buildEnvironment)) {
  if (key.startsWith("FANTASTIC_EDITOR_WECHAT_")) delete buildEnvironment[key];
}

const result = spawnSync(
  process.execPath,
  [electronBuilderCli, "--win", ...targets, "--x64", `--config.electronDist=${electronDistribution}`, ...signingArguments],
  {
    cwd: repositoryRoot,
    env: {
      ...buildEnvironment,
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
    },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
