// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { UPLOAD_E2E_ARTIFACTS_ACTION } from "../../../tools/e2e/upload-e2e-artifacts-workflow-boundary.mts";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, unknown>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
};

function smokeJob(): WorkflowJob {
  const workflow = readWorkflow() as { jobs: Record<string, WorkflowJob> };
  const job = workflow.jobs["tool-disclosure-smoke"];
  expect(job).toBeDefined();
  return job;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep | undefined {
  return job.steps?.find((step) => step.name === name);
}

describe("tool-disclosure smoke workflow boundary", () => {
  it("keeps the hosted-inference smoke explicit-only", () => {
    const inventory = readFreeStandingJobsInventory();

    expect(validateE2eWorkflowBoundary()).toEqual([]);
    expect(inventory.allowedJobs).toContain("tool-disclosure-smoke");
    expect(inventory.explicitOnlyJobs).toContain("tool-disclosure-smoke");
    expect(inventory.targetToJob.get("tool-disclosure-smoke")).toBe("tool-disclosure-smoke");
    expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).not.toContain(
      "tool-disclosure-smoke",
    );

    for (const selector of [
      { jobs: "tool-disclosure-smoke" },
      { targets: "tool-disclosure-smoke" },
    ]) {
      expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["tool-disclosure-smoke"],
        registryTargets: [],
      });
    }
  });

  it("runs the focused live test with reviewed prerequisites and scoped secrets", () => {
    const job = smokeJob();
    expect(job).toMatchObject({
      needs: "generate-matrix",
      if: "${{ contains(format(',{0},', inputs.jobs), ',tool-disclosure-smoke,') || contains(format(',{0},', inputs.targets), ',tool-disclosure-smoke,') }}",
      "runs-on": "ubuntu-latest",
      permissions: { contents: "read" },
      "timeout-minutes": 60,
      env: {
        E2E_JOB: "1",
        E2E_DEFAULT_ENABLED: "0",
        E2E_TARGET_ID: "tool-disclosure-smoke",
        E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/tool-disclosure-smoke",
        NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
        NEMOCLAW_RUN_LIVE_E2E: "1",
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        OPENSHELL_GATEWAY: "nemoclaw",
      },
    });
    expect(job.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");

    const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(namedStep(job, "Authenticate to Docker Hub")).toBeDefined();
    expect(namedStep(job, "Prepare E2E workspace")?.uses).toBe(
      "NVIDIA/NemoClaw/.github/actions/prepare-e2e@50281ee84c4a6fc759da95ea28fc0b7d9c378a28",
    );

    const cloudflared = namedStep(job, "Install and verify cloudflared prerequisite");
    expect(cloudflared?.env).toEqual({
      CLOUDFLARED_VERSION: "2026.6.1",
      CLOUDFLARED_DEB_SHA256: "ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526",
    });
    expect(cloudflared?.run).toContain("sha256sum -c -");
    expect(cloudflared?.run).toContain("dpkg-deb -f");

    const run = namedStep(job, "Run tool-disclosure smoke live test");
    expect(run?.env).toEqual({
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    });
    expect(run?.run).toContain("test/e2e/live/tool-disclosure-smoke.test.ts");
    expect(run?.run).toContain("--project e2e-live");
  });

  it("maps only the smoke artifact directory through the reviewed uploader", () => {
    const job = smokeJob();
    const upload = namedStep(job, "Upload tool-disclosure smoke artifacts");
    expect(upload).toEqual({
      name: "Upload tool-disclosure smoke artifacts",
      if: "always()",
      uses: UPLOAD_E2E_ARTIFACTS_ACTION,
    });
    expect(job.env?.E2E_TARGET_ID).toBe("tool-disclosure-smoke");
    expect(job.env?.E2E_ARTIFACT_DIR).toBe(
      "${{ github.workspace }}/e2e-artifacts/live/tool-disclosure-smoke",
    );
    expect(job.steps?.at(-1)?.name).toBe("Clean up Docker auth");
  });
});
