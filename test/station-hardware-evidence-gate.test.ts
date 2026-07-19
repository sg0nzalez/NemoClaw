// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DEFERRAL_MARKER,
  evaluateStationHardwareGate,
  HARDWARE_MARKER,
  STATION_PREPARE_PATH,
  type StationHardwareGateApi,
} from "../tools/station-hardware-evidence/gate.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const PR_NUMBER = 42;
const TESTED_COMMIT = "a".repeat(40);
const SCRIPT = Buffer.from("#!/usr/bin/env bash\necho station\n", "utf8");
const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("hex");
const EVIDENCE_URL = `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#issuecomment-100`;
const DEFERRAL_URL = `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#issuecomment-101`;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function prBody(
  options: {
    deferral?: boolean;
    deferralUrl?: string;
    evidenceUrl?: string;
    hardware?: boolean;
  } = {},
): string {
  return `## DGX Station Hardware Validation
- [${options.hardware ? "x" : " "}] Real DGX Station validation passed
- [${options.deferral ? "x" : " "}] Maintainer-approved deferral recorded
Evidence comment: ${options.evidenceUrl ?? ""}
Deferral comment: ${options.deferralUrl ?? ""}

## Verification
`;
}

function evidenceComment(hash = SCRIPT_HASH): string {
  return `${HARDWARE_MARKER}
result=PASS
tested_commit=${TESTED_COMMIT}
prepare_script_sha256=${hash}
profile=generic-ubuntu-24.04-arm64
`;
}

function deferralComment(hash = SCRIPT_HASH): string {
  return `${DEFERRAL_MARKER}
prepare_script_sha256=${hash}
reason=Physical Station capacity is temporarily unavailable.
remaining_risk=The clean-host package transaction remains unqualified.
follow_up=https://github.com/${REPOSITORY}/issues/7191
`;
}

function api(overrides: Partial<StationHardwareGateApi> = {}): StationHardwareGateApi {
  return {
    getBlob: async () => SCRIPT,
    getCollaboratorPermission: async () => "maintain",
    getFileAtCommit: async () => SCRIPT,
    getFollowUpIssue: async () => ({
      html_url: `https://github.com/${REPOSITORY}/issues/7191`,
      state: "open",
    }),
    getIssueComment: async (id) => ({
      body: id === 100 ? evidenceComment() : deferralComment(),
      issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${PR_NUMBER}`,
      user: { login: "maintainer" },
    }),
    ...overrides,
  };
}

function input(
  options: {
    api?: StationHardwareGateApi;
    body?: string;
    files?: Array<{ filename: string; previous_filename?: string; sha: string; status: string }>;
    filesComplete?: boolean;
  } = {},
) {
  return {
    api: options.api ?? api(),
    changedFiles: options.files ?? [
      { filename: STATION_PREPARE_PATH, sha: "blob-sha", status: "modified" },
    ],
    changedFilesComplete: options.filesComplete ?? true,
    pullRequest: {
      body: options.body ?? prBody(),
      head: { repo: { full_name: "contributor/NemoClaw" }, sha: "b".repeat(40) },
      number: PR_NUMBER,
    },
    repository: REPOSITORY,
  };
}

describe("Station hardware evidence gate", () => {
  it("passes unrelated PRs without requiring Station metadata (#7191)", async () => {
    const result = await evaluateStationHardwareGate(
      input({ files: [{ filename: "README.md", sha: "blob", status: "modified" }] }),
    );
    expect(result.mode).toBe("not-applicable");
  });

  it("fails closed when a truncated file listing cannot prove the script is unchanged (#7191)", async () => {
    await expect(
      evaluateStationHardwareGate(
        input({
          files: [{ filename: "README.md", sha: "blob", status: "modified" }],
          filesComplete: false,
        }),
      ),
    ).rejects.toThrow("file listing reached its 3,000-file limit");
  });

  it("fails changed preparation scripts without exactly one outcome (#7191)", async () => {
    await expect(evaluateStationHardwareGate(input())).rejects.toThrow(
      "Select exactly one Station hardware outcome",
    );
    await expect(
      evaluateStationHardwareGate(input({ body: prBody({ deferral: true, hardware: true }) })),
    ).rejects.toThrow("Select exactly one Station hardware outcome");
  });

  it("accepts hardware evidence bound to the current script and tested commit (#7191)", async () => {
    const result = await evaluateStationHardwareGate(
      input({ body: prBody({ evidenceUrl: EVIDENCE_URL, hardware: true }) }),
    );
    expect(result).toMatchObject({ mode: "hardware", prepareScriptSha256: SCRIPT_HASH });
  });

  it("rejects hardware evidence bound to a stale script hash (#7191)", async () => {
    await expect(
      evaluateStationHardwareGate(
        input({
          api: api({
            getIssueComment: async () => ({
              body: evidenceComment("0".repeat(64)),
              issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${PR_NUMBER}`,
              user: { login: "author" },
            }),
          }),
          body: prBody({ evidenceUrl: EVIDENCE_URL, hardware: true }),
        }),
      ),
    ).rejects.toThrow("evidence is stale");
  });

  it.each([
    [
      "a duplicate required field",
      `${evidenceComment()}tested_commit=${TESTED_COMMIT}\n`,
      "duplicate tested_commit fields",
    ],
    [
      "an invalid tested commit",
      evidenceComment().replace(TESTED_COMMIT, "invalid-commit"),
      "tested_commit must be a lowercase 40-character SHA",
    ],
    [
      "an invalid script hash",
      evidenceComment().replace(SCRIPT_HASH, "invalid-hash"),
      "prepare_script_sha256 must be a lowercase SHA-256",
    ],
    [
      "an invalid profile",
      evidenceComment().replace("generic-ubuntu-24.04-arm64", "invalid profile"),
      "profile is missing or malformed",
    ],
  ])("rejects hardware evidence with %s (#7191)", async (_case, body, expected) => {
    await expect(
      evaluateStationHardwareGate(
        input({
          api: api({
            getIssueComment: async () => ({
              body,
              issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${PR_NUMBER}`,
              user: { login: "author" },
            }),
          }),
          body: prBody({ evidenceUrl: EVIDENCE_URL, hardware: true }),
        }),
      ),
    ).rejects.toThrow(expected);
  });

  it("rejects a tested commit that contains different preparation bytes (#7191)", async () => {
    await expect(
      evaluateStationHardwareGate(
        input({
          api: api({ getFileAtCommit: async () => Buffer.from("different", "utf8") }),
          body: prBody({ evidenceUrl: EVIDENCE_URL, hardware: true }),
        }),
      ),
    ).rejects.toThrow("tested_commit does not contain the recorded preparation script");
  });

  it("rejects evidence links that do not belong to the current PR (#7191)", async () => {
    await expect(
      evaluateStationHardwareGate(
        input({
          body: prBody({
            evidenceUrl: `https://github.com/${REPOSITORY}/pull/41#issuecomment-100`,
            hardware: true,
          }),
        }),
      ),
    ).rejects.toThrow("Comment link must reference an issue comment on this PR");
  });

  it("rejects a deferral from a collaborator without maintain permission (#7191)", async () => {
    await expect(
      evaluateStationHardwareGate(
        input({
          api: api({ getCollaboratorPermission: async () => "write" }),
          body: prBody({ deferral: true, deferralUrl: DEFERRAL_URL }),
        }),
      ),
    ).rejects.toThrow("must have maintain or admin repository permission");
  });

  it("accepts a current maintain-approved deferral with an open follow-up (#7191)", async () => {
    const result = await evaluateStationHardwareGate(
      input({ body: prBody({ deferral: true, deferralUrl: DEFERRAL_URL }) }),
    );
    expect(result).toMatchObject({ mode: "deferral", prepareScriptSha256: SCRIPT_HASH });
  });

  it("rejects a deferral for stale preparation-script bytes (#7191)", async () => {
    await expect(
      evaluateStationHardwareGate(
        input({
          api: api({
            getIssueComment: async () => ({
              body: deferralComment("0".repeat(64)),
              issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${PR_NUMBER}`,
              user: { login: "maintainer" },
            }),
          }),
          body: prBody({ deferral: true, deferralUrl: DEFERRAL_URL }),
        }),
      ),
    ).rejects.toThrow(
      "Station hardware deferral is stale: preparation script hash does not match this PR head.",
    );
  });

  it.each([
    ["a missing required field", deferralComment().replace(/^reason=.*\n/mu, ""), "missing reason"],
    [
      "a duplicate required field",
      `${deferralComment()}reason=Second reason must be rejected.\n`,
      "duplicate reason fields",
    ],
    [
      "an undersized reason",
      deferralComment().replace(
        "reason=Physical Station capacity is temporarily unavailable.",
        "reason=short",
      ),
      "reason is too short",
    ],
    [
      "an undersized remaining risk",
      deferralComment().replace(
        "remaining_risk=The clean-host package transaction remains unqualified.",
        "remaining_risk=short",
      ),
      "remaining_risk is too short",
    ],
    [
      "a malformed follow-up URL",
      deferralComment().replace(
        `follow_up=https://github.com/${REPOSITORY}/issues/7191`,
        "follow_up=not-a-url",
      ),
      "must link an issue in this repository",
    ],
    [
      "a cross-repository follow-up URL",
      deferralComment().replace(REPOSITORY, "another/repository"),
      "must link an issue in this repository",
    ],
  ])("rejects deferral metadata with %s (#7191)", async (_case, body, expected) => {
    await expect(
      evaluateStationHardwareGate(
        input({
          api: api({
            getIssueComment: async () => ({
              body,
              issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${PR_NUMBER}`,
              user: { login: "maintainer" },
            }),
          }),
          body: prBody({ deferral: true, deferralUrl: DEFERRAL_URL }),
        }),
      ),
    ).rejects.toThrow(expected);
  });

  it("rejects a deferral whose follow-up issue is closed (#7191)", async () => {
    await expect(
      evaluateStationHardwareGate(
        input({
          api: api({
            getFollowUpIssue: async () => ({
              html_url: `https://github.com/${REPOSITORY}/issues/7191`,
              state: "closed",
            }),
          }),
          body: prBody({ deferral: true, deferralUrl: DEFERRAL_URL }),
        }),
      ),
    ).rejects.toThrow("follow_up issue must be open");
  });

  it("fails closed when the preparation script is removed or renamed (#7191)", async () => {
    await expect(
      evaluateStationHardwareGate(
        input({
          files: [
            {
              filename: "scripts/replacement.sh",
              previous_filename: STATION_PREPARE_PATH,
              sha: "blob",
              status: "renamed",
            },
          ],
        }),
      ),
    ).rejects.toThrow("removal or rename requires separate maintainer review");
  });
});

describe("Station hardware evidence workflow boundary", () => {
  const workflowSource = readFileSync(
    resolve(REPO_ROOT, ".github/workflows/station-hardware-evidence.yaml"),
    "utf8",
  );
  const workflow = parseYaml(workflowSource) as Record<string, any>;

  // source-shape-contract: security -- The privileged pull_request_target gate must stay on trusted code with immutable actions, read-only permissions, and no contributor checkout
  it("runs from a trusted pull_request_target revision with read-only permissions (#7191)", () => {
    expect(workflow.on.pull_request_target.types).toEqual([
      "opened",
      "edited",
      "synchronize",
      "reopened",
      "ready_for_review",
    ]);
    expect(workflow.on.issue_comment.types).toEqual(["edited", "deleted"]);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs["station-hardware-evidence"].permissions).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
    const checkout = workflow.jobs["station-hardware-evidence"].steps[0];
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/u);
    expect(checkout.with).toMatchObject({
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
    });
    const setupNode = workflow.jobs["station-hardware-evidence"].steps[1];
    expect(setupNode.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/u);
    const revalidation = workflow.jobs["revalidate-edited-comment"];
    expect(revalidation.if).toContain("github.event.issue.pull_request != null");
    expect(revalidation.permissions).toEqual({
      checks: "write",
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
    expect(revalidation.steps[0].uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/u);
    expect(revalidation.steps[0].with).toMatchObject({
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
    });
    expect(revalidation.steps[1].uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/u);
    expect(revalidation.steps[2].env).toMatchObject({
      PR_NUMBER: "${{ github.event.issue.number }}",
      PUBLISH_HEAD_CHECK: "true",
    });
    expect(workflowSource).not.toContain("github.event.pull_request.head.sha");
  });

  // source-shape-contract: compatibility -- The contributor template and agent policy must expose the machine-readable Station evidence contract consumed by the trusted gate
  it("exposes the same contract to contributor and reviewer agents (#7191)", () => {
    const template = readFileSync(resolve(REPO_ROOT, ".github/PULL_REQUEST_TEMPLATE.md"), "utf8");
    const agentPolicy = readFileSync(resolve(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(template).toContain("## DGX Station Hardware Validation");
    expect(template).toContain("Real DGX Station validation passed");
    expect(template).toContain("Maintainer-approved deferral recorded");
    expect(template).toContain(HARDWARE_MARKER);
    expect(template).toContain(DEFERRAL_MARKER);
    expect(agentPolicy).toContain("scripts/prepare-dgx-station-host.sh");
    expect(agentPolicy).toContain("A deferral accepts merge risk but is not Station qualification");
  });
});
