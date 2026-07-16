// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { normalizedExactImageManifestJson } from "../../../tools/e2e/exact-image-manifest.mts";
import {
  CANDIDATE_SHA,
  CORRELATION_ID,
  exactImageManifest,
  IMAGE_REPOSITORY_SHA,
} from "./exact-image-manifest-fixture.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "tools/e2e/validate-exact-image-manifest.mts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-manifest-"));
  tempDirs.push(directory);
  return directory;
}

function args(manifest: string, output: string, overrides: Record<string, string> = {}): string[] {
  const values = {
    "--manifest": manifest,
    "--output": output,
    "--nemoclaw-sha": CANDIDATE_SHA,
    "--requester-run-id": "8001",
    "--requester-run-attempt": "1",
    "--correlation-id": CORRELATION_ID,
    "--image-repository-sha": IMAGE_REPOSITORY_SHA,
    "--producer-run-id": "9002",
    "--producer-run-attempt": "1",
    ...overrides,
  };
  return Object.entries(values).flat();
}

function runCli(cliArgs: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...cliArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

function runCliWithTsx(cliArgs: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...cliArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

describe("exact staging image manifest CLI", () => {
  it("writes only normalized accepted JSON with private permissions", () => {
    const directory = tempDir();
    const input = path.join(directory, "nemoclaw-image-manifest.v1.json");
    const output = path.join(directory, "accepted.json");
    const manifest = exactImageManifest();
    fs.writeFileSync(input, JSON.stringify(manifest), "utf8");

    const result = runCli(args(input, output));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(output, "utf8")).toBe(normalizedExactImageManifestJson(manifest));
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  });

  it("loads through the repository tsx runtime", () => {
    const directory = tempDir();
    const input = path.join(directory, "nemoclaw-image-manifest.v1.json");
    const output = path.join(directory, "accepted.json");
    fs.writeFileSync(input, JSON.stringify(exactImageManifest()), "utf8");

    const result = runCliWithTsx(args(input, output));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(output)).toBe(true);
  });

  it("reports a stable provenance failure code and leaves no accepted output", () => {
    const directory = tempDir();
    const input = path.join(directory, "manifest.json");
    const output = path.join(directory, "accepted.json");
    fs.writeFileSync(input, JSON.stringify(exactImageManifest()), "utf8");

    const result = runCli(args(input, output, { "--producer-run-id": "9003" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^PROVENANCE_MISMATCH: workflowRunId/u);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("rejects symlinked, oversized, and non-UTF-8 inputs", () => {
    const directory = tempDir();
    const valid = path.join(directory, "valid.json");
    fs.writeFileSync(valid, JSON.stringify(exactImageManifest()), "utf8");
    const symlink = path.join(directory, "symlink.json");
    fs.symlinkSync(valid, symlink);

    const oversized = path.join(directory, "oversized.json");
    fs.writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1, 0x20));

    const invalidUtf8 = path.join(directory, "invalid-utf8.json");
    fs.writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));

    for (const [name, input, message] of [
      ["symlink", symlink, "manifest input could not be opened safely"],
      ["oversized", oversized, "manifest input exceeds 65536 bytes"],
      ["non-UTF-8", invalidUtf8, "manifest input must be valid UTF-8"],
    ]) {
      const output = path.join(directory, `${name}-accepted.json`);
      const result = runCli(args(input, output));
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toContain(`ARTIFACT_MISSING_OR_INVALID: ${message}`);
      expect(fs.existsSync(output), name).toBe(false);
    }
  });

  it("refuses to replace a symlinked accepted-output path", () => {
    const directory = tempDir();
    const input = path.join(directory, "manifest.json");
    const target = path.join(directory, "target.json");
    const output = path.join(directory, "accepted.json");
    fs.writeFileSync(input, JSON.stringify(exactImageManifest()), "utf8");
    fs.writeFileSync(target, "unchanged\n", "utf8");
    fs.symlinkSync(target, output);

    const result = runCli(args(input, output));

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "OUTPUT_WRITE_FAILED: accepted manifest output could not be written safely\n",
    );
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged\n");
  });

  it("reports invalid or incomplete invocation as a request failure", () => {
    const result = runCli(["--manifest", "manifest.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("REQUEST_INVALID: --output is required\n");
  });
});
