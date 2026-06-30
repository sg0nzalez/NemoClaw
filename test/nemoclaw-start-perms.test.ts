// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression tests for #6047: nemoclaw exec collapses /sandbox/.openclaw permissions.
// Verifies that normalize_mutable_config_perms runs AFTER NEMOCLAW_CMD in both
// the non-root and root/step-down entrypoint paths, and that the command's exit
// code is preserved through the normalize call.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

// Module-scope extraction helpers. The marker assertions live here (not inside
// the test cases) so they validate the slice against the real script without
// being source-shape assertions on production behavior.
function nonRootCmdBlock(src: string): string {
  const base = src.indexOf("# ── Non-root fallback");
  expect(base).toBeGreaterThan(-1);
  const start = src.indexOf("  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then\n", base);
  expect(start).toBeGreaterThan(base);
  const end = src.indexOf("\n  fi\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + "\n  fi".length + 1);
}

function rootCmdBlock(src: string): string {
  const base = src.indexOf("# ── Root path");
  expect(base).toBeGreaterThan(-1);
  const start = src.indexOf("# If a command was passed", base);
  expect(start).toBeGreaterThan(base);
  const end = src.indexOf("\nfi\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + "\nfi".length + 1);
}

describe("nemoclaw-start NEMOCLAW_CMD permission restore (#6047)", () => {
  it("normalizes .openclaw perms after non-root command and preserves exit code", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -euo pipefail",
      'normalize_mutable_config_perms() { echo "ORDER:normalize"; }',
      "install_messaging_runtime_preloads() { :; }",
      "verify_messaging_runtime_secret_scans() { :; }",
      "NEMOCLAW_CMD=(bash -c 'echo ORDER:cmd; exit 42')",
      nonRootCmdBlock(src),
      'echo "SHOULD_NOT_REACH"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(42);
    expect(result.stdout).toMatch(/ORDER:cmd[\s\S]*ORDER:normalize/);
    expect(result.stdout).not.toContain("SHOULD_NOT_REACH");
  });

  it("normalizes .openclaw perms after root step-down command and preserves exit code", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -euo pipefail",
      'normalize_mutable_config_perms() { echo "ORDER:normalize"; }',
      "setup_auth_profile_as_sandbox() { :; }",
      // env passes the remaining args through unchanged, simulating a no-op step-down
      "STEP_DOWN_PREFIX_SANDBOX=(env)",
      "NEMOCLAW_CMD=(bash -c 'echo ORDER:cmd; exit 42')",
      rootCmdBlock(src),
      'echo "SHOULD_NOT_REACH"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(42);
    expect(result.stdout).toMatch(/ORDER:cmd[\s\S]*ORDER:normalize/);
    expect(result.stdout).not.toContain("SHOULD_NOT_REACH");
  });
});
