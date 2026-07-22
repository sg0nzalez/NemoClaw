// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { readYaml, type Workflow, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const WORKFLOW_PATH = ".github/workflows/muninn.yaml";
const workflow = readYaml<Workflow>(WORKFLOW_PATH);

function requiredJob(name: string) {
  const job = workflow.jobs[name];
  assert(job, `Muninn workflow is missing job: ${name}`);
  return job;
}

function requiredStep(jobName: string, stepName: string): WorkflowStep {
  const step = requiredJob(jobName).steps?.find((candidate) => candidate.name === stepName);
  assert(step, `Muninn workflow job ${jobName} is missing step: ${stepName}`);
  return step;
}

function resolveScript(): string {
  const script = requiredStep("muninn", "Resolve Muninn config path").run;
  assert(typeof script === "string" && script.length > 0);
  return script;
}

function writeTrustedPolicy(root: string): void {
  mkdirSync(join(root, "trusted-muninn-policy"), { recursive: true });
  writeFileSync(join(root, "trusted-muninn-policy", "muninn.yml"), "scanners: {}\n");
}

function writeHeadPolicy(root: string): void {
  writeFileSync(join(root, "muninn.yml"), "scanners: {}\n");
}

function runResolveScript(
  eventName: string,
  prepare: (root: string) => void,
): { log: string; config: string; status: number } {
  const root = mkdtempSync(join(tmpdir(), "muninn-policy-"));
  try {
    prepare(root);
    const githubOutput = join(root, "github-output");
    writeFileSync(githubOutput, "");
    const result = spawnSync("bash", ["-c", resolveScript()], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT_NAME: eventName,
        BASE_SHA: "abc123",
        GITHUB_OUTPUT: githubOutput,
      },
    });
    const output = readFileSync(githubOutput, "utf8");
    return {
      log: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      config: /^config=(.+)$/m.exec(output)?.[1] ?? "",
      status: result.status ?? 1,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Muninn workflow contract", () => {
  // source-shape-contract: security -- fail-on and formats stay owned by the workflow, not muninn.yml
  it("pins Muninn and keeps fail-on info with SARIF plus PR comment output", () => {
    const run = requiredStep("muninn", "Run Muninn");
    expect(run.uses).toBe("skaldlab/muninn@daf98872b5748d015ed5bd828296175f6bc0115d");
    expect(run.with?.["fail-on"]).toBe("info");
    expect(run.with?.format).toBe("sarif,comment");
    expect(run.with?.token).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(run.with?.config).toBe("${{ steps.policy.outputs.config }}");
  });

  // source-shape-contract: security -- Scan job permissions match the documented publication surface
  it("grants the Muninn job only the write scopes needed for SARIF and comments", () => {
    expect(requiredJob("muninn").permissions).toEqual({
      contents: "read",
      "security-events": "write",
      "pull-requests": "write",
    });
    expect(workflow.jobs.muninn).toBeDefined();
    expect(requiredJob("npm-audit-production").permissions).toEqual({ contents: "read" });
  });

  // source-shape-contract: security -- Production npm audit stays complementary to Muninn osv/trivy
  it("enforces npm audit --omit=dev in the companion production gate", () => {
    const install = requiredStep("npm-audit-production", "Install production dependencies");
    const audit = requiredStep("npm-audit-production", "Audit production dependency graph");
    expect(install.run).toBe("npm ci --omit=dev --ignore-scripts --no-audit --no-fund");
    expect(audit.run).toBe("npm audit --omit=dev");
  });

  // source-shape-contract: security -- Base-SHA suppressions beat head; missing base is bootstrap-only
  it("prefers trusted base muninn.yml and documents the bootstrap head fallback", () => {
    const trustedCheckout = requiredStep("muninn", "Checkout trusted Muninn suppressions (base SHA)");
    expect(trustedCheckout.if).toBe("github.event_name == 'pull_request'");
    expect(trustedCheckout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(trustedCheckout.with?.path).toBe("trusted-muninn-policy");
    expect(String(trustedCheckout.with?.["sparse-checkout"])).toContain("muninn.yml");
    expect(trustedCheckout.with?.["persist-credentials"]).toBe(false);

    const resolve = requiredStep("muninn", "Resolve Muninn config path");
    expect(resolve.env?.EVENT_NAME).toBe("${{ github.event_name }}");
    expect(resolve.env?.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(resolve.run).toContain("trusted-muninn-policy/muninn.yml");
    expect(resolve.run).toContain(".muninn-trusted.yml");
    expect(resolve.run).toContain("bootstrap: base has no file yet");
  });

  // source-shape-contract: security -- PR with base muninn.yml uses the trusted copy
  it("resolves config to the trusted base file when both base and head exist", () => {
    const result = runResolveScript("pull_request", (root) => {
      writeTrustedPolicy(root);
      writeHeadPolicy(root);
    });
    expect(result.status).toBe(0);
    expect(result.log).toContain("Using trusted base muninn.yml");
    expect(result.config).toBe(".muninn-trusted.yml");
  });

  // source-shape-contract: security -- Missing base muninn.yml bootstraps from head
  it("resolves config to the head file when the base policy is absent", () => {
    const result = runResolveScript("pull_request", writeHeadPolicy);
    expect(result.status).toBe(0);
    expect(result.log).toContain("bootstrap: base has no file yet");
    expect(result.config).toBe("muninn.yml");
  });

  // source-shape-contract: security -- Non-PR events use the workspace muninn.yml
  it("resolves config to the workspace file on push events", () => {
    const result = runResolveScript("push", writeHeadPolicy);
    expect(result.status).toBe(0);
    expect(result.config).toBe("muninn.yml");
  });
});
