// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const outputDir = path.resolve("dist");
const bundlePath = path.join(outputDir, "mcp-tool-discovery.mjs");
const licenseFileNames = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"];

function packageNameFromInput(inputPath) {
  const normalized = inputPath.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const segments = normalized.slice(markerIndex + marker.length).split("/");
  if (segments[0]?.startsWith("@")) return `${segments[0]}/${segments[1]}`;
  return segments[0] || null;
}

function readPackageLicense(packageName) {
  const packageDir = path.resolve("node_modules", packageName);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const licenseFileName = licenseFileNames.find((candidate) =>
    fs.existsSync(path.join(packageDir, candidate)),
  );
  if (!licenseFileName) throw new Error(`bundled package ${packageName} has no license file`);
  return {
    name: packageName,
    version: manifest.version,
    declaredLicense: manifest.license,
    text: fs.readFileSync(path.join(packageDir, licenseFileName), "utf8").trim(),
  };
}

fs.rmSync(outputDir, { recursive: true, force: true });
const result = await build({
  entryPoints: ["mcp-tool-discovery.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: bundlePath,
  metafile: true,
});

const bundledPackages = [...new Set(Object.keys(result.metafile.inputs).map(packageNameFromInput))]
  .filter((name) => name !== null)
  .sort();
if (!bundledPackages.includes("@modelcontextprotocol/sdk")) {
  throw new Error("the MCP SDK was not present in the bundled input graph");
}

const notices = bundledPackages.map(readPackageLicense);
const noticeText = [
  "Third-party licenses for the NemoClaw MCP tool discovery runtime bundle",
  "",
  ...notices.flatMap(({ name, version, declaredLicense, text }) => [
    "================================================================================",
    `${name}@${version} (${declaredLicense})`,
    "================================================================================",
    text,
    "",
  ]),
].join("\n");
fs.writeFileSync(path.join(outputDir, "THIRD_PARTY_LICENSES.txt"), noticeText, "utf8");
