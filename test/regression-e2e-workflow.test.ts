// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowStep } from "./helpers/e2e-workflow-contract";

type RegressionWorkflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: {
        jobs?: {
          description?: string;
        };
      };
    };
  };
  jobs?: Record<
    string,
    {
      steps?: WorkflowStep[];
    }
  >;
};

describe("Regression E2E workflow contract", () => {
  const workflow = readYaml<RegressionWorkflow>(".github/workflows/regression-e2e.yaml");

  it("does not advertise or select the retired docker-unreachable gateway-start lane", () => {
    const jobsDescription = workflow.on?.workflow_dispatch?.inputs?.jobs?.description ?? "";
    const selectorScript =
      workflow.jobs?.select_regression_jobs?.steps?.find((step) => step.id === "select")?.run ?? "";

    expect(jobsDescription).not.toContain("docker-unreachable-gateway-start-e2e");
    expect(Object.keys(workflow.jobs ?? {})).not.toContain("docker-unreachable-gateway-start-e2e");
    expect(selectorScript).not.toContain("docker-unreachable-gateway-start-e2e");
    expect(selectorScript).not.toContain("docker_unreachable_gateway_start");
  });

  it("runs gateway health-honesty through Vitest artifacts", () => {
    const jobsDescription = workflow.on?.workflow_dispatch?.inputs?.jobs?.description ?? "";
    const selectorScript =
      workflow.jobs?.select_regression_jobs?.steps?.find((step) => step.id === "select")?.run ?? "";
    const job = workflow.jobs?.["gateway-health-honest-e2e"];
    const checkoutStep = job?.steps?.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    const setupNodeStep = job?.steps?.find((step) =>
      String(step.uses ?? "").startsWith("actions/setup-node@"),
    );
    const installStep = job?.steps?.find((step) => step.name === "Install root dependencies");
    const runStep = job?.steps?.find(
      (step) => step.name === "Run gateway health-honesty Vitest E2E test",
    );
    const uploadStep = job?.steps?.find(
      (step) => step.name === "Upload gateway health-honesty artifacts",
    );

    expect(jobsDescription).toContain("gateway-health-honest-e2e");
    expect(selectorScript).toContain("gateway-health-honest-e2e");
    expect(selectorScript).toContain("gateway=true");
    expect(checkoutStep?.with?.["persist-credentials"]).toBe(false);
    expect(setupNodeStep?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(setupNodeStep?.with?.cache).toBe("npm");
    expect(installStep?.run).toBe("npm ci --ignore-scripts");
    expect(runStep?.run).toContain("npx vitest run --project e2e-scenarios-live");
    expect(runStep?.run).toContain("test/e2e-scenario/live/gateway-health-honest.test.ts");
    expect(runStep?.run).not.toContain("test/e2e/test-gateway-health-honest.sh");
    expect(runStep?.env?.NEMOCLAW_RUN_E2E_SCENARIOS).toBe("1");
    expect(runStep?.env?.E2E_ARTIFACT_DIR).toBe(
      "${{ github.workspace }}/e2e-artifacts/vitest/gateway-health-honest",
    );
    expect(uploadStep?.if).toBe("always()");
    expect(uploadStep?.with?.path).toBe("e2e-artifacts/vitest/gateway-health-honest/");
    expect(uploadStep?.with?.["include-hidden-files"]).toBe(false);
    expect(uploadStep?.with?.["if-no-files-found"]).toBe("ignore");
    expect(uploadStep?.with?.["retention-days"]).toBe(14);
  });
});
