// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const NODE_VERSION = "22.19.0";
const WORKFLOWS = [
  ".github/workflows/wsl-e2e.yaml",
  ".github/workflows/platform-vitest-main.yaml",
] as const;

function extractPinnedHashes(source: string): { x64: string; arm64: string } {
  const x64 = /x86_64\) node_arch="x64"; node_sha="([a-f0-9]{64})"/.exec(source)?.[1];
  const arm64 =
    /aarch64\|arm64\) node_arch="arm64"; node_sha="([a-f0-9]{64})"/.exec(source)?.[1];
  assert(x64, "missing x64 Node tarball SHA-256 pin");
  assert(arm64, "missing arm64 Node tarball SHA-256 pin");
  return { x64, arm64 };
}

function parseOfficialShasums(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+(\S+)$/.exec(line.trim());
    match ? map.set(match[2], match[1]) : undefined;
  }
  return map;
}

describe("Pinned Node.js dist checksums", () => {
  // source-shape-contract: security -- Workflow Node tarball pins must match nodejs.org SHASUMS256
  it(`matches official linux x64/arm64 SHA-256 for Node ${NODE_VERSION}`, async () => {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
    expect(response.ok).toBe(true);
    const official = parseOfficialShasums(await response.text());
    const expectedX64 = official.get(`node-v${NODE_VERSION}-linux-x64.tar.xz`);
    const expectedArm64 = official.get(`node-v${NODE_VERSION}-linux-arm64.tar.xz`);
    expect(expectedX64).toMatch(/^[a-f0-9]{64}$/);
    expect(expectedArm64).toMatch(/^[a-f0-9]{64}$/);

    for (const path of WORKFLOWS) {
      const source = readFileSync(resolve(path), "utf8");
      expect(source).toContain(`NODE_VERSION="${NODE_VERSION}"`);
      expect(source).toContain("sha256sum -c -");
      expect(source).toContain('*) echo "Unsupported architecture: $arch" >&2; exit 1 ;;');
      const pinned = extractPinnedHashes(source);
      expect(pinned.x64, path).toBe(expectedX64);
      expect(pinned.arm64, path).toBe(expectedArm64);
    }
  });
});
