// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect } from "vitest";
import { parseSnapshotLine } from "../../../tools/e2e/runner-pressure-core.mts";
import { test } from "../fixtures/e2e-test.ts";
import type { ProgressSummary } from "../fixtures/progress.ts";

const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-progress-fixture-"));
const resourceSnapshots = path.join(artifactRoot, "runner-resource-snapshots.jsonl");
let progressArtifact = "";

const fixtureEnvironment = {
  E2E_ARTIFACT_DIR: artifactRoot,
  E2E_TARGET_ID: "fixture-progress-target",
  NEMOCLAW_E2E_SHARD: "fixture-progress-shard",
  E2E_RESOURCE_SNAPSHOTS_FILE: resourceSnapshots,
} as const;
const previousEnvironment = Object.fromEntries(
  Object.keys(fixtureEnvironment).map((key) => [key, process.env[key]]),
) as Record<keyof typeof fixtureEnvironment, string | undefined>;
Object.assign(process.env, fixtureEnvironment);
fs.writeFileSync(resourceSnapshots, "", { mode: 0o600 });

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
    expect(summary.phases.at(-1)?.label).toBe(
      "phase 5 current base built by authoritative rebuild",
    );
    const snapshots = fs
      .readFileSync(resourceSnapshots, "utf8")
      .trim()
      .split("\n")
      .map(parseSnapshotLine);
    expect(snapshots).toHaveLength(4);
    expect(snapshots.slice(0, 2).map((snapshot) => snapshot.phase)).toEqual([
      "fixture-progress-target.test-body",
      "fixture-progress-target.test-body",
    ]);
    const longPhaseLabels = snapshots.slice(2).map((snapshot) => snapshot.phase);
    expect(longPhaseLabels[0]).toHaveLength(64);
    expect(longPhaseLabels[0]).toMatch(/^fixture-progress-target\.[a-z0-9-]+-[0-9a-f]{8}$/u);
    expect(longPhaseLabels[1]).toBe(longPhaseLabels[0]);
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(artifactRoot, { force: true, recursive: true });
  }
});

test("automatic progress fixture writes completed target and shard evidence", async ({
  artifacts,
  progress,
}) => {
  progressArtifact = artifacts.pathFor("test-progress.json");
  progress.phase("phase 5 current base built by authoritative rebuild");
});
