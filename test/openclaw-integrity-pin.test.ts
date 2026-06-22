// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");
const BLUEPRINT = path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml");
const UNPINNED_OPENCLAW_VERSION = "2026.6.10";

function extractRunBlock(file: string, startMarker: string, endMarker: string): string {
  const source = fs.readFileSync(file, "utf-8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `Expected start marker in ${file}: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `Expected end marker in ${file}: ${endMarker}`).toBeGreaterThan(start);
  const runIndex = source.indexOf("RUN ", start);
  expect(runIndex, `Expected RUN instruction after ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(runIndex, `Expected RUN instruction before ${endMarker}`).toBeLessThanOrEqual(end);
  return source
    .slice(runIndex, end)
    .trim()
    .replace(/^RUN\s+--mount=[^\n]+\\\n\s*/, "")
    .replace(/^RUN\s+/, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .replace(/\\\s*$/, "");
}

function runInstallBlock(command: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-integrity-"));
  const blueprint = path.join(tmp, "blueprint.yaml");
  const log = path.join(tmp, "calls.log");
  fs.writeFileSync(blueprint, fs.readFileSync(BLUEPRINT, "utf-8"));
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `OPENCLAW_VERSION=${JSON.stringify(UNPINNED_OPENCLAW_VERSION)}`,
    'OPENCLAW_2026_6_9_INTEGRITY="sha512-reviewed-pin"',
    'openclaw() { if [ "${1:-}" = "--version" ]; then printf \'openclaw 2026.3.11\\n\'; else return 127; fi; }',
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    '  if [ "${1:-}" = "view" ] && [ "${3:-}" = "version" ]; then printf "%s\\n" "$OPENCLAW_VERSION"; return 0; fi',
    '  if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.integrity" ]; then printf "%s\\n" "$OPENCLAW_2026_6_9_INTEGRITY"; return 0; fi',
    "}",
    "pip3() { return 0; }",
    command
      .replaceAll("/opt/nemoclaw-blueprint/blueprint.yaml", blueprint)
      .replaceAll("/tmp/blueprint.yaml", blueprint),
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  fs.rmSync(tmp, { recursive: true, force: true });
  return { result, calls };
}

describe("OpenClaw npm integrity pins", () => {
  it("fails closed before npm install for unpinned production Dockerfile overrides", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# OPENCLAW_VERSION is the NemoClaw runtime build target",
        "# Patch OpenClaw media fetch",
      ),
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `OpenClaw ${UNPINNED_OPENCLAW_VERSION} has no committed npm integrity pin`,
    );
    expect(calls).not.toContain("npm install -g");
  });

  it("fails closed before npm install for unpinned base Dockerfile overrides", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE_BASE,
        "# Install OpenClaw CLI + PyYAML.",
        "# Baseline health check.",
      ),
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `OpenClaw ${UNPINNED_OPENCLAW_VERSION} has no committed npm integrity pin`,
    );
    expect(calls).not.toContain("npm install -g");
  });
});
