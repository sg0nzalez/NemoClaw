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

function extractBlock(src: string, startMarker: string, endMarker: string, label: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`${label}: start marker not found`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`${label}: end marker not found after start`);
  return src.slice(start, end + endMarker.length);
}

describe("nemoclaw-start NEMOCLAW_CMD permission restore (#6047)", () => {
  it("normalizes .openclaw perms after non-root command and preserves exit code", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const nonRootBase = src.indexOf("# ── Non-root fallback");
    if (nonRootBase === -1) throw new Error("non-root fallback section not found");
    const cmdBlock = extractBlock(
      src.slice(nonRootBase),
      "  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then\n",
      "\n  fi\n",
      "non-root NEMOCLAW_CMD block",
    );

    const script = [
      "set -euo pipefail",
      'normalize_mutable_config_perms() { echo "ORDER:normalize"; }',
      "install_messaging_runtime_preloads() { :; }",
      "verify_messaging_runtime_secret_scans() { :; }",
      "NEMOCLAW_CMD=(bash -c 'echo ORDER:cmd; exit 42')",
      cmdBlock,
      'echo "SHOULD_NOT_REACH"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(42);
    expect(result.stdout).toMatch(/ORDER:cmd[\s\S]*ORDER:normalize/);
    expect(result.stdout).not.toContain("SHOULD_NOT_REACH");
  });

  it("normalizes .openclaw perms after root step-down command and preserves exit code", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const rootBase = src.indexOf("# ── Root path");
    if (rootBase === -1) throw new Error("root path section not found");
    const cmdBlock = extractBlock(
      src.slice(rootBase),
      "# If a command was passed",
      "\nfi\n",
      "root NEMOCLAW_CMD block",
    );

    const script = [
      "set -euo pipefail",
      'normalize_mutable_config_perms() { echo "ORDER:normalize"; }',
      "setup_auth_profile_as_sandbox() { :; }",
      // env passes the remaining args through unchanged, simulating a no-op step-down
      "STEP_DOWN_PREFIX_SANDBOX=(env)",
      "NEMOCLAW_CMD=(bash -c 'echo ORDER:cmd; exit 42')",
      cmdBlock,
      'echo "SHOULD_NOT_REACH"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(42);
    expect(result.stdout).toMatch(/ORDER:cmd[\s\S]*ORDER:normalize/);
    expect(result.stdout).not.toContain("SHOULD_NOT_REACH");
  });
});
