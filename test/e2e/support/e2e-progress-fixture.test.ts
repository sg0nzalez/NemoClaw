// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect } from "vitest";

import { test } from "../fixtures/e2e-test.ts";
import type { ProgressSummary } from "../fixtures/progress.ts";

const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-progress-fixture-"));
const previousArtifactDir = process.env.E2E_ARTIFACT_DIR;
const previousTargetId = process.env.E2E_TARGET_ID;
const previousShardId = process.env.NEMOCLAW_E2E_SHARD;
let progressArtifact = "";

process.env.E2E_ARTIFACT_DIR = artifactRoot;

afterAll(() => {
  try {
    const summary = JSON.parse(fs.readFileSync(progressArtifact, "utf8")) as ProgressSummary;
    expect(summary).toMatchObject({
      version: 1,
      scenario: "automatic progress fixture writes completed target and shard evidence",
      targetId: "fixture-progress-target",
      shardId: "fixture-progress-shard",
    });
    expect(summary.finishedAtMs).not.toBeNull();
    expect(summary.durationMs).not.toBeNull();
    expect(summary.phases.at(-1)?.label).toBe("final fixture phase");
  } finally {
    if (previousArtifactDir === undefined) delete process.env.E2E_ARTIFACT_DIR;
    else process.env.E2E_ARTIFACT_DIR = previousArtifactDir;
    if (previousTargetId === undefined) delete process.env.E2E_TARGET_ID;
    else process.env.E2E_TARGET_ID = previousTargetId;
    if (previousShardId === undefined) delete process.env.NEMOCLAW_E2E_SHARD;
    else process.env.NEMOCLAW_E2E_SHARD = previousShardId;
    fs.rmSync(artifactRoot, { force: true, recursive: true });
  }
});

test("automatic progress fixture writes completed target and shard evidence", async ({
  artifacts,
  progress,
}) => {
  progressArtifact = artifacts.pathFor("test-progress.json");
  process.env.E2E_TARGET_ID = "fixture-progress-target";
  process.env.NEMOCLAW_E2E_SHARD = "fixture-progress-shard";
  progress.phase("final fixture phase");
});
