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

  it("runs WhatsApp compact-QR through Vitest artifacts", () => {
    const job = workflow.jobs?.["whatsapp-qr-compact-e2e"];
    const checkoutStep = job?.steps?.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    const runStep = job?.steps?.find(
      (step) => step.name === "Run WhatsApp compact-QR Vitest E2E test",
    );
    const uploadStep = job?.steps?.find(
      (step) => step.name === "Upload WhatsApp compact-QR E2E artifacts",
    );

    expect(checkoutStep?.with?.["persist-credentials"]).toBe(false);
    expect(runStep?.run).toContain("npx vitest run --project e2e-scenarios-live");
    expect(runStep?.run).toContain("test/e2e-scenario/live/whatsapp-qr-compact.test.ts");
    expect(runStep?.run).not.toContain("test/e2e/test-whatsapp-qr-compact-e2e.sh");
    expect(runStep?.env?.NEMOCLAW_RUN_E2E_SCENARIOS).toBe("1");
    expect(runStep?.env?.E2E_ARTIFACT_DIR).toBe(
      "${{ github.workspace }}/e2e-artifacts/vitest/whatsapp-qr-compact",
    );
    expect(uploadStep?.with?.path).toBe("e2e-artifacts/vitest/whatsapp-qr-compact/");
    expect(uploadStep?.with?.["include-hidden-files"]).toBe(false);
  });
});
