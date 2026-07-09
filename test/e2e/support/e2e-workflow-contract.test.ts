// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, removeJobNeed, type Workflow } from "../../helpers/e2e-workflow-contract";

describe("E2E workflow test helpers", () => {
  it("refuses to remove a dependency from a later job", () => {
    const workflow = [
      "jobs:",
      "  owner:",
      "    needs:",
      "      [",
      "        present,",
      "      ]",
      "  later:",
      "    needs:",
      "      [",
      "        misplaced,",
      "      ]",
      "",
    ].join("\n");

    expect(() => removeJobNeed(workflow, "owner", "misplaced")).toThrow(
      "owner does not need misplaced",
    );
  });

  it("binds every checkout to the validated exact revision", () => {
    const workflow = readYaml<Workflow>(".github/workflows/e2e.yaml");
    const checkouts = Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
      (job.steps ?? [])
        .filter((step) => step.uses?.startsWith("actions/checkout@"))
        .map((step) => ({ jobId, step })),
    );

    expect(checkouts.length).toBeGreaterThan(0);
    for (const { jobId, step } of checkouts) {
      expect(step.with?.ref, `${jobId} checkout revision`).toBe(
        "${{ inputs.checkout_sha || github.sha }}",
      );
      expect(step.with?.["persist-credentials"], `${jobId} checkout credentials`).toBe(false);
    }
  });
});
