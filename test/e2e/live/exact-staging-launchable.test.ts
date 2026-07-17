// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";

import { expect, test } from "vitest";

import { REPO_ROOT } from "../fixtures/paths.ts";

const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-runtime.sh");
const enabled = process.env.NEMOCLAW_RUN_EXACT_STAGING_LAUNCHABLE === "1";
const liveTest = enabled ? test : test.skip;

function run(mode: "deploy" | "qualify" | "cleanup"): SpawnSyncReturns<string> {
  return spawnSync("bash", [SCRIPT, mode], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 45 * 60_000,
  });
}

function failure(mode: string, result: SpawnSyncReturns<string>): Error {
  const detail = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
  return new Error(`${mode} failed with status ${String(result.status)}\n${detail}`);
}

liveTest(
  "exact staging Launchable: deploy, prove image identity, smoke the baked install, and clean up",
  { timeout: 60 * 60_000 },
  () => {
    let journeyFailure: Error | undefined;
    try {
      const deploy = run("deploy");
      if (deploy.status !== 0) throw failure("deploy", deploy);

      const qualify = run("qualify");
      if (qualify.status !== 0) throw failure("qualify", qualify);
    } catch (error) {
      journeyFailure = error instanceof Error ? error : new Error(String(error));
    }

    const cleanup = run("cleanup");
    if (cleanup.status !== 0) {
      const cleanupFailure = failure("cleanup", cleanup);
      throw journeyFailure
        ? new AggregateError([journeyFailure, cleanupFailure], "qualification and cleanup failed")
        : cleanupFailure;
    }
    if (journeyFailure) throw journeyFailure;

    expect(cleanup.status).toBe(0);
  },
);
