import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repositoryRoot, "build", "icon.svg");
const pngPath = resolve(repositoryRoot, "build", "icon.png");
const icoPath = resolve(repositoryRoot, "build", "icon.ico");

function renderPng(svg, size) {
  return Buffer.from(new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  }).render().asPng());
}

function pngIco(png, size) {
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(1, 4);
  directory.writeUInt8(size >= 256 ? 0 : size, 6);
  directory.writeUInt8(size >= 256 ? 0 : size, 7);
  directory.writeUInt8(0, 8);
  directory.writeUInt8(0, 9);
  directory.writeUInt16LE(1, 10);
  directory.writeUInt16LE(32, 12);
  directory.writeUInt32LE(png.byteLength, 14);
  directory.writeUInt32LE(directory.byteLength, 18);
  return Buffer.concat([directory, png]);
}

await mkdir(dirname(sourcePath), { recursive: true });
const svg = await readFile(sourcePath, "utf8");
const png512 = renderPng(svg, 512);
const png256 = renderPng(svg, 256);
await writeFile(pngPath, png512);
await writeFile(icoPath, pngIco(png256, 256));

console.log(`Generated ${pngPath} (${png512.byteLength} bytes)`);
console.log(`Generated ${icoPath} (${png256.byteLength + 22} bytes)`);
