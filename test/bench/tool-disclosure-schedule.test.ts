// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendJsonLine,
  ensureCampaignDirectory,
  readJsonLines,
  scanArtifactsForForbiddenValues,
  writeChecksumManifest,
  writeJsonArtifact,
} from "../../scripts/bench/tool-disclosure/artifacts";
import {
  buildToolDisclosureSchedule,
  countScheduledRunsByCampaign,
} from "../../scripts/bench/tool-disclosure/schedule";

const primaryTaskIds = Array.from({ length: 24 }, (_, index) => `task-${index + 1}`);
const stressTaskIds = primaryTaskIds.slice(0, 8);

describe("tool-disclosure schedule", () => {
  it("builds the frozen two-campaign matrix with adjacent balanced mode pairs", () => {
    const schedule = buildToolDisclosureSchedule({ primaryTaskIds, stressTaskIds, seed: 6251 });
    expect(schedule).toHaveLength(1_884);
    expect(countScheduledRunsByCampaign(schedule)).toEqual({
      "campaign-1:static-visibility": 30,
      "campaign-1:small-control": 144,
      "campaign-1:primary": 720,
      "campaign-1:large-stress": 48,
      "campaign-2:static-visibility": 30,
      "campaign-2:small-control": 144,
      "campaign-2:primary": 720,
      "campaign-2:large-stress": 48,
    });
    for (let index = 0; index < schedule.length; index += 2) {
      expect(schedule[index].pair_id).toBe(schedule[index + 1].pair_id);
      expect(new Set([schedule[index].mode, schedule[index + 1].mode])).toEqual(
        new Set(["progressive", "direct"]),
      );
    }
  });

  it("is deterministic for a fixed seed and changes order for another seed", () => {
    const first = buildToolDisclosureSchedule({ primaryTaskIds, stressTaskIds, seed: 7 });
    const second = buildToolDisclosureSchedule({ primaryTaskIds, stressTaskIds, seed: 7 });
    const other = buildToolDisclosureSchedule({ primaryTaskIds, stressTaskIds, seed: 8 });
    expect(second).toEqual(first);
    expect(other.map((run) => run.run_id)).not.toEqual(first.map((run) => run.run_id));
  });
});

describe("tool-disclosure artifacts", () => {
  it("writes JSON, JSONL, checksums, and rejects leaked values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tool-bench-"));
    try {
      const output = ensureCampaignDirectory(path.join(root, "campaign"), false);
      writeJsonArtifact(output, "manifest.json", { safe: true });
      appendJsonLine(output, "runs.jsonl", { run_id: "one" });
      appendJsonLine(output, "runs.jsonl", { run_id: "two" });
      expect(readJsonLines(path.join(output, "runs.jsonl"))).toEqual([
        { run_id: "one" },
        { run_id: "two" },
      ]);
      writeChecksumManifest(output, ["runs.jsonl", "manifest.json"]);
      expect(fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8")).toContain("manifest.json");
      scanArtifactsForForbiddenValues(output, ["manifest.json", "runs.jsonl"], ["secret"]);
      expect(() => scanArtifactsForForbiddenValues(output, ["runs.jsonl"], ["run_id"])).toThrow(
        "contains a forbidden value",
      );
      expect(() => ensureCampaignDirectory(output, false)).toThrow("not empty");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
