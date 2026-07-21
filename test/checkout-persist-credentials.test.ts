// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import type { Workflow, WorkflowStep } from "./helpers/e2e-workflow-contract";

const WORKFLOWS_DIR = resolve(".github/workflows");

/** Workflows hardened in the Muninn security PR to disable checkout credential persistence. */
const HARDENED_WORKFLOWS = [
  "base-image.yaml",
  "brev-nightly-e2e.yaml",
  "candidate-compatibility.yaml",
  "code-scanning.yaml",
  "commit-lint.yaml",
  "docker-pin-check.yaml",
  "docs-cli-parity-pr.yaml",
  "docs-links-pr.yaml",
  "e2e-branch-validation.yaml",
  "e2e.yaml",
  "macos-e2e.yaml",
  "muninn.yaml",
  "platform-vitest-main.yaml",
  "pr-e2e-gate.yaml",
  "pr-review-advisor.yaml",
  "pr-self-hosted.yaml",
  "regression-e2e.yaml",
  "release-latest-tag.yaml",
  "wsl-e2e.yaml",
] as const;

function checkoutSteps(workflow: Workflow): WorkflowStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).filter((step) => step.uses?.startsWith("actions/checkout@") ?? false),
  );
}

describe("Checkout credential persistence hardening", () => {
  // source-shape-contract: security -- persist-credentials:false stays on every hardened checkout
  it("keeps persist-credentials false on every actions/checkout in hardened workflows", () => {
    const missing: string[] = [];
    for (const file of HARDENED_WORKFLOWS) {
      const path = join(WORKFLOWS_DIR, file);
      const workflow = parseYaml(readFileSync(path, "utf8")) as Workflow;
      for (const step of checkoutSteps(workflow)) {
        if (step.with?.["persist-credentials"] !== false) {
          missing.push(`${file}: ${step.name ?? step.uses ?? "<unnamed>"}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  // source-shape-contract: security -- Hardened list stays aligned with workflows on disk
  it("covers every workflow file that was in the Muninn hardening set", () => {
    const onDisk = new Set(
      readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")),
    );
    for (const file of HARDENED_WORKFLOWS) {
      expect(onDisk.has(file), file).toBe(true);
    }
  });
});
