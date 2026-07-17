// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";

import { expect, onTestFinished, test } from "vitest";

import { REPO_ROOT } from "../fixtures/paths.ts";

const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-runtime.sh");
const enabled = process.env.NEMOCLAW_RUN_EXACT_STAGING_LAUNCHABLE === "1";

function run(mode: "deploy" | "qualify" | "cleanup"): SpawnSyncReturns<string> {
  return spawnSync("bash", [SCRIPT, mode], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 45 * 60_000,
  });
}

function expectSuccess(mode: string, result: SpawnSyncReturns<string>): void {
  const detail = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
  expect(result.status, `${mode} failed with status ${String(result.status)}\n${detail}`).toBe(0);
}

test.runIf(enabled)(
  "exact staging Launchable: deploy, prove image identity, smoke the baked install, and clean up",
  { timeout: 60 * 60_000 },
  () => {
    onTestFinished(() => expectSuccess("cleanup", run("cleanup")), 15 * 60_000);
    expectSuccess("deploy", run("deploy"));
    expectSuccess("qualify", run("qualify"));
  },
);
