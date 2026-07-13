// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readYaml } from "./helpers/e2e-workflow-contract";

type WorkflowStep = {
  readonly name?: string;
  readonly run?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
};

type WorkflowJob = {
  readonly needs?: string | readonly string[];
  readonly steps?: readonly WorkflowStep[];
};

type Workflow = {
  readonly jobs: Record<string, WorkflowJob>;
};

const repoRoot = path.join(import.meta.dirname, "..");

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

describe("WeChat runtime audit and install-cache gates (#5896)", () => {
  // source-shape-contract: security -- Trusted PR and main workflows must enforce the reviewed WeChat runtime audit boundary
  it.each(["pr", "main"])("makes the audit a required %s workflow job", (workflowName) => {
    const workflow = readYaml<Workflow>(`.github/workflows/${workflowName}.yaml`);
    const job = workflow.jobs["wechat-runtime-audit"];
    const checks = workflow.jobs.checks;
    expect(job).toBeDefined();

    expect(requiredStep(job, "Setup production-compatible Node.js").with).toMatchObject({
      "node-version": "22.19.0",
    });
    expect(requiredStep(job, "Pin production npm").run).toBe(
      "npm install --global npm@10.9.4 --ignore-scripts --no-audit --no-fund",
    );
    expect(requiredStep(job, "Audit locked WeChat runtime graph").run).toBe(
      "bash scripts/checks/audit-wechat-runtime.sh artifacts/wechat-runtime-audit",
    );
    const upload = requiredStep(job, "Upload WeChat runtime audit evidence");
    expect(upload.if).toBe("${{ always() }}");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({
      path: "artifacts/wechat-runtime-audit",
      "if-no-files-found": "error",
    });

    expect(checks.needs).toContain("wechat-runtime-audit");
    const gate = requiredStep(
      checks,
      workflowName === "pr" ? "Verify required PR checks" : "Verify required main checks",
    );
    expect(gate.env).toMatchObject({
      WECHAT_RUNTIME_AUDIT_RESULT: "${{ needs['wechat-runtime-audit'].result }}",
    });
    expect(gate.run).toContain(
      'require_success "wechat-runtime-audit" "$WECHAT_RUNTIME_AUDIT_RESULT"',
    );
  });

  it("audits the installed graph and exercises the exact archive through a copied cache", () => {
    const script = fs.readFileSync(
      path.join(repoRoot, "scripts", "checks", "audit-wechat-runtime.sh"),
      "utf8",
    );
    for (const fragment of [
      'npm --prefix "$runtime_dir" ci',
      "--ignore-scripts",
      "--omit=dev",
      "--legacy-peer-deps",
      "audit-level=low",
      "audit signatures",
      "npm-audit.json",
      "npm-audit-signatures.txt",
      'chmod -R a-w "$trusted_cache"',
      'cp -R "$trusted_cache"/. "$install_cache"/',
      'chmod -R u+rwX,go-w "$install_cache"',
      'npm pack "$wechat_tarball"',
      "--offline",
      'EXPECTED_INTEGRITY="$wechat_integrity"',
    ]) {
      expect(script).toContain(fragment);
    }
  });

  it("keeps the image cache trusted and deletes the sandbox-writable copy", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    for (const fragment of [
      "chown -R root:root /usr/local/lib/nemoclaw/wechat-runtime",
      "trusted_cache=/usr/local/share/nemoclaw/wechat-npm-cache",
      'install_cache="$(mktemp -d /tmp/nemoclaw-wechat-npm-cache.XXXXXX)"',
      'cp -R "$trusted_cache"/. "$install_cache"/',
      'NEMOCLAW_WECHAT_NPM_INSTALL_CACHE="$install_cache"',
      'rm -rf "$install_cache"',
      'test ! -e "$install_cache"',
    ]) {
      expect(dockerfile).toContain(fragment);
    }
  });
});
