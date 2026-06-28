// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  readInferenceSwitchWorkflow,
  validateInferenceSwitchWorkflow,
  validateInferenceSwitchWorkflowBoundary,
} from "../../../tools/e2e-scenarios/inference-switch-workflow-boundary.mts";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("inference switch workflow boundary", () => {
  it("runs hosted and Anthropic-compatible modes for both agents", () => {
    expect(validateInferenceSwitchWorkflowBoundary()).toEqual([]);
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);

    for (const { job, scenario } of [
      {
        job: "hermes-inference-switch-vitest",
        scenario: "hermes-inference-switch",
      },
      {
        job: "openclaw-inference-switch-vitest",
        scenario: "openclaw-inference-switch",
      },
    ]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: scenario })).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: [job],
      });
      expect(evaluateE2eVitestWorkflowDispatchSelectors({ jobs: job })).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: [job],
      });
      expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
        job,
      );
    }
  });

  it("makes the mode matrix part of the central workflow ratchet", () => {
    const workflow = readInferenceSwitchWorkflow();
    workflow.jobs["hermes-inference-switch-vitest"].strategy!.matrix!.include!.pop();

    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-inference-switch-workflow-"));
    const workflowPath = join(directory, "workflow.yaml");
    try {
      writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toContain(
        "hermes-inference-switch-vitest must run the exact hosted and Anthropic-compatible mode matrix",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects mode, secret, and Docker-auth boundary drift", () => {
    const modeDrift = readInferenceSwitchWorkflow();
    modeDrift.jobs["openclaw-inference-switch-vitest"].env!.NEMOCLAW_SWITCH_PROVIDER =
      "compatible-endpoint";
    expect(validateInferenceSwitchWorkflow(modeDrift)).toContain(
      "openclaw-inference-switch-vitest environment contract must not drift",
    );

    const broadSecret = readInferenceSwitchWorkflow();
    broadSecret.jobs["hermes-inference-switch-vitest"].env!.NVIDIA_INFERENCE_API_KEY =
      "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    expect(validateInferenceSwitchWorkflow(broadSecret)).toContain(
      "hermes-inference-switch-vitest must not expose NVIDIA_INFERENCE_API_KEY at job scope",
    );

    const unrelatedStepSecret = readInferenceSwitchWorkflow();
    unrelatedStepSecret.jobs["openclaw-inference-switch-vitest"].steps!.find(
      (step) => step.name === "Build CLI",
    )!.env = { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" };
    expect(validateInferenceSwitchWorkflow(unrelatedStepSecret)).toContain(
      "openclaw-inference-switch-vitest must not expose GITHUB_TOKEN to step Build CLI",
    );

    const unsafeCleanup = readInferenceSwitchWorkflow();
    unsafeCleanup.jobs["openclaw-inference-switch-vitest"].steps!.find(
      (step) => step.name === "Clean up Docker auth",
    )!.run = "docker logout docker.io || true";
    expect(validateInferenceSwitchWorkflow(unsafeCleanup)).toContain(
      'openclaw-inference-switch-vitest step Clean up Docker auth must contain: rm -rf "${docker_config}"',
    );
  });
});
