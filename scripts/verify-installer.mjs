import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const setupPath = resolve(repositoryRoot, "release", `fantastic-editor-${packageJson.version}-setup.exe`);
const smokeRoot = resolve(repositoryRoot, "build-tmp", `installer-smoke-${packageJson.version}`);
const installRoot = resolve(smokeRoot, "installed-app");
const userDataRoot = resolve(smokeRoot, "user-data");
const resultPath = resolve(smokeRoot, "installed-result.json");
const reportPath = resolve(smokeRoot, "installer-smoke-report.json");

function assertWorkspacePath(path) {
  const workspacePrefix = `${repositoryRoot}${sep}`.toLowerCase();
  if (!path.toLowerCase().startsWith(workspacePrefix)) {
    throw new Error(`Installer smoke target escaped the workspace: ${path}`);
  }
}

async function waitForJson(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Installed application did not write its completion marker within ${timeoutMs} ms.`);
}

async function waitUntilMissing(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Silent uninstall left the application executable behind: ${path}`);
}

assertWorkspacePath(smokeRoot);
assertWorkspacePath(installRoot);
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

// NSIS passes its self-delete path as an unquoted `_?=` argument.  A project
// checkout commonly contains spaces, so run the smoke test through a temporary
// SUBST drive and set TEMP/TMP explicitly to keep the gate deterministic.
const mappedDriveCandidates = ["Z:", "Y:", "X:", "W:"];
const existingSubst = spawnSync("subst.exe", [], { encoding: "utf8", windowsHide: true }).stdout || "";
const occupiedDrives = new Set(
  existingSubst
    .split(/\r?\n/)
    .map((line) => line.slice(0, 2).toUpperCase())
    .filter((drive) => /^[A-Z]:$/.test(drive)),
);
const mappedDrive = mappedDriveCandidates.find((drive) => !occupiedDrives.has(drive) && !existsSync(`${drive}\\`));
if (!mappedDrive) throw new Error("No free drive letter is available for the installer smoke test.");
const driveSmokeRoot = `${mappedDrive}\\build-tmp\\installer-smoke-${packageJson.version}`;
const driveInstallRoot = `${driveSmokeRoot}\\installed-app`;
const driveTempRoot = `${driveSmokeRoot}\\temp`;
const driveSetupPath = `${mappedDrive}\\release\\fantastic-editor-${packageJson.version}-setup.exe`;
await mkdir(resolve(smokeRoot, "temp"), { recursive: true });

const setupStat = await stat(setupPath);
if (!setupStat.isFile() || setupStat.size < 20 * 1024 * 1024) throw new Error("Windows setup artifact is missing or unexpectedly small.");

const installCommand = `subst ${mappedDrive} "${repositoryRoot}" & set "TEMP=${driveTempRoot}" & set "TMP=${driveTempRoot}" & "${driveSetupPath}" /S /currentuser /D=${driveInstallRoot} & set "gateExit=!ERRORLEVEL!" & subst ${mappedDrive} /D & exit /b !gateExit!`;
const install = spawnSync("cmd.exe", ["/d", "/v:on", "/c", installCommand], {
  cwd: repositoryRoot,
  encoding: "utf8",
  timeout: 120_000,
  windowsHide: true,
  windowsVerbatimArguments: true,
});
if (install.error) throw new Error("Silent installer could not run.", { cause: install.error });
if (install.status !== 0) throw new Error(`Silent installer exited with ${install.status ?? "no status"}.\n${install.stderr || install.stdout || ""}`);

const installedEntries = await readdir(installRoot, { withFileTypes: true });
const applicationEntry = installedEntries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "fantastic-editor.exe");
const uninstallEntry = installedEntries.find((entry) => entry.isFile() && entry.name.toLowerCase().startsWith("uninstall") && entry.name.toLowerCase().endsWith(".exe"));
if (!applicationEntry || !uninstallEntry) throw new Error("Installed application or uninstaller is missing.");
const applicationPath = resolve(installRoot, applicationEntry.name);
const uninstallPath = resolve(installRoot, uninstallEntry.name);

await mkdir(userDataRoot, { recursive: true });
const launch = spawnSync(applicationPath, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", `--user-data-dir=${userDataRoot}`], {
  cwd: smokeRoot,
  env: {
    ...process.env,
    TEMP: smokeRoot,
    TMP: smokeRoot,
    FANTASTIC_EDITOR_SMOKE_TEST: "1",
    FANTASTIC_EDITOR_SMOKE_RESULT: resultPath,
  },
  encoding: "utf8",
  timeout: 60_000,
  windowsHide: true,
});
if (launch.error) throw new Error("Installed application could not launch.", { cause: launch.error });
if (launch.status !== 0) throw new Error(`Installed application launcher exited with ${launch.status ?? "no status"}.`);
const completion = await waitForJson(resultPath, 60_000);
if (completion?.schema !== "fantastic-editor-smoke-result-v1" || completion.scenario !== "basic" || completion.valid !== true) {
  throw new Error("Installed application returned an invalid smoke result.");
}

// Keep the mapping alive briefly after the NSIS launcher returns because its
// temporary uninstaller child completes the actual directory removal.
const uninstallCommand = `subst ${mappedDrive} "${repositoryRoot}" & set "TEMP=${driveTempRoot}" & set "TMP=${driveTempRoot}" & "${mappedDrive}\\build-tmp\\installer-smoke-${packageJson.version}\\installed-app\\${uninstallEntry.name}" /S /currentuser & set "gateExit=!ERRORLEVEL!" & ping 127.0.0.1 -n 6 >NUL & subst ${mappedDrive} /D & exit /b !gateExit!`;
const uninstall = spawnSync("cmd.exe", ["/d", "/v:on", "/c", uninstallCommand], {
  cwd: repositoryRoot,
  encoding: "utf8",
  timeout: 120_000,
  windowsHide: true,
  windowsVerbatimArguments: true,
});
if (uninstall.error) throw new Error("Silent uninstaller could not run.", { cause: uninstall.error });
if (uninstall.status !== 0) throw new Error(`Silent uninstaller exited with ${uninstall.status ?? "no status"}.\n${uninstall.stderr || uninstall.stdout || ""}`);
await waitUntilMissing(applicationPath, 30_000);

const report = {
  schema: "fantastic-editor-installer-smoke-report-v1",
  generatedAt: new Date().toISOString(),
  version: packageJson.version,
  setupArtifact: relative(repositoryRoot, setupPath).replaceAll("\\", "/"),
  isolatedInstallDirectory: relative(repositoryRoot, installRoot).replaceAll("\\", "/"),
  installedApplicationLaunch: "passed",
  silentInstall: "passed",
  silentUninstall: "passed",
  applicationExecutableRemoved: true,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`installer smoke: passed\ninstaller smoke report: ${reportPath}`);
