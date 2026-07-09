// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readYaml, type Workflow, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const PATH = ".github/workflows/pr-e2e-risk-gate.yaml";

type CoordinatorWorkflow = Workflow & {
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
};

function namedStep(steps: WorkflowStep[] | undefined, name: string): WorkflowStep {
  const result = steps?.find((step) => step.name === name);
  expect(result, `missing ${name}`).toBeDefined();
  return result!;
}

describe("required-live PR coordinator workflow", () => {
  it("cancels superseded live runs as soon as a PR head changes", () => {
    const workflow = readYaml<CoordinatorWorkflow>(PATH);
    const job = workflow.jobs["cancel-superseded"];
    const cancel = namedStep(job.steps, "Cancel superseded required-live runs");

    expect(job.if).toContain("github.event_name == 'pull_request_target'");
    expect(cancel.run).toContain("--mode cancel");
    expect(cancel.run).toContain('--pr "$PR_NUMBER"');
    expect(cancel.run).not.toContain("--head");
  });

  it("dispatches only after exact-head CI and Advisor planning and always closes its check", () => {
    const workflow = readYaml<CoordinatorWorkflow>(PATH);
    const job = workflow.jobs.coordinate;
    const initialize = namedStep(job.steps, "Create exact-head required-live check");
    const resolve = namedStep(job.steps, "Resolve exact PR and CI result");
    const advisor = namedStep(job.steps, "Wait for exact-head Advisor artifacts");
    const start = namedStep(job.steps, "Build exact-head plan and dispatch required live E2E");
    const finish = namedStep(job.steps, "Complete exact-head required-live check");
    const abandon = namedStep(job.steps, "Close required-live check after coordinator failure");

    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(initialize.env?.HEAD_SHA).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(initialize.run).toContain("--mode initialize");
    expect(resolve.env?.HEAD_SHA).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(resolve.env?.HEAD_BRANCH).toBe("${{ github.event.workflow_run.head_branch }}");
    expect(advisor.if).toContain("steps.resolve.outputs.ci_green == 'true'");
    expect(advisor.run).toContain('--commit "$HEAD_SHA"');
    expect(start.if).toContain("always()");
    expect(start.env?.CI_GREEN).toBe("${{ steps.resolve.outputs.ci_green }}");
    expect(start.env?.CHECK_ID).toBe("${{ steps.initialize.outputs.check_id }}");
    expect(start.run).toContain('--ci-green "$CI_GREEN"');
    expect(finish.id).toBe("finish");
    expect(finish.if).toContain("always()");
    expect(finish.run).toContain("--mode finish");
    expect(abandon.if).toContain("failure() || cancelled()");
    expect(abandon.if).toContain("steps.finish.outcome != 'success'");
    expect(abandon.env?.RUN_ID).toBe("${{ steps.start.outputs.run_id }}");
    expect(abandon.run).toContain("--mode abandon");
    expect(abandon.run).toContain('--run-id "$RUN_ID"');
  });

  it("revalidates the exact first-party PR before any live job can receive secrets", () => {
    const child = readYaml<Workflow & { permissions: Record<string, string> }>(
      ".github/workflows/e2e.yaml",
    );
    const generate = child.jobs["generate-matrix"];
    const validation = namedStep(generate.steps, "Validate exact-commit dispatch");

    expect(child.permissions).toEqual({ contents: "read" });
    expect(generate.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(validation.run).toContain("automatic risk PR must be first-party");
    expect(validation.run).toContain('[[ "$(jq -r .head.sha <<<"$pr_json")" == "$CHECKOUT_SHA" ]]');
    expect(JSON.stringify(generate)).not.toContain("${{ secrets.");
  });
});
