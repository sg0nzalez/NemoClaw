// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function ensureCampaignDirectory(outputDir: string, resume: boolean): string {
  const resolved = path.resolve(outputDir);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("performance test output path must be a real directory");
    }
    const entries = fs.readdirSync(resolved);
    if (!resume && entries.length > 0) {
      throw new Error("performance test output directory is not empty; pass --resume to reuse it");
    }
  } else {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  return resolved;
}

export function artifactPath(outputDir: string, name: string): string {
  if (!SAFE_ARTIFACT_NAME.test(name))
    throw new Error(`invalid performance test artifact name: ${name}`);
  const root = path.resolve(outputDir);
  const candidate = path.resolve(root, name);
  if (path.dirname(candidate) !== root)
    throw new Error("performance test artifact escaped output directory");
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`performance test artifact must not be a symlink: ${name}`);
  }
  return candidate;
}

export function writeJsonArtifact(outputDir: string, name: string, value: unknown): string {
  const destination = artifactPath(outputDir, name);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, destination);
  return destination;
}

export function writeTextArtifact(outputDir: string, name: string, value: string): string {
  const destination = artifactPath(outputDir, name);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, destination);
  return destination;
}

export function appendJsonLine(outputDir: string, name: string, value: unknown): void {
  const destination = artifactPath(outputDir, name);
  fs.appendFileSync(destination, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function readJsonLines<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`invalid JSONL at line ${index + 1}`);
      }
    });
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function writeChecksumManifest(outputDir: string, names: readonly string[]): string {
  const unique = [...new Set(names)].sort();
  const lines = unique.map((name) => {
    const file = artifactPath(outputDir, name);
    if (!fs.statSync(file).isFile()) throw new Error(`cannot checksum non-file artifact: ${name}`);
    return `${sha256File(file)}  ${name}`;
  });
  const destination = artifactPath(outputDir, "SHA256SUMS");
  fs.writeFileSync(destination, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return destination;
}

export function scanArtifactsForForbiddenValues(
  outputDir: string,
  names: readonly string[],
  forbiddenValues: readonly string[],
): void {
  const forbidden = forbiddenValues.filter((value) => value.length > 0);
  for (const name of names) {
    const content = fs.readFileSync(artifactPath(outputDir, name), "utf8");
    const leaked = forbidden.find((value) => content.includes(value));
    if (leaked) throw new Error(`performance test artifact ${name} contains a forbidden value`);
  }
}
