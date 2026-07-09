#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubApi, githubRestPaginated } from "../advisors/github.mts";
import { parseArgs } from "../advisors/io.mts";
import { buildRiskPlan } from "../advisors/risk-plan.mts";
import { readFreeStandingJobsInventory } from "../e2e/workflow-boundary.mts";
import {
  completeCheck,
  createCheck,
  dispatchRiskWorkflow,
  expectedRiskSignalShards,
  finishRiskGate,
  type RiskGateState,
  validateRiskPlan,
} from "./post-merge-risk-gate.mts";
import { readPrivateRegularFile, writePrivateRegularFile } from "./private-file.ts";

const CHECK_NAME = "E2E / Required Live";
const SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

type Pull = {
  number: number;
  state: string;
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo: { full_name: string } };
};

type PullFile = { filename: string };

type WorkflowRun = {
  id: number;
  display_title: string;
  status: string;
};

type TargetResult = {
  version: number;
  changedFiles: string[];
  required: Array<{ id: string; selectorType: string; required: boolean }>;
};

/** Read and validate the trusted GitHub Actions identity. */
function tokenAndRepository(): { token: string; repository: string } {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !REPOSITORY.test(repository)) throw new Error("trusted GitHub context is required");
  return { token, repository };
}

/** Require a non-empty command-line value. */
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** Parse a positive integer command-line value. */
function positive(value: string | undefined, name: string): number {
  const raw = required(value, name);
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error(`--${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be a safe positive integer`);
  return parsed;
}

/** Append a bounded, single-line GitHub Actions output. */
function output(name: string, value: string): void {
  if (
    !/^(?:base_sha|check_id|ci_green|dispatched|first_party|head_repo|head_sha|pr_number|run_id|state_hash)$/u.test(
      name,
    )
  ) {
    throw new Error("invalid output name");
  }
  const file = process.env.GITHUB_OUTPUT;
  if (!file) throw new Error("safe GITHUB_OUTPUT is required");
  const validValue =
    name === "base_sha" || name === "head_sha"
      ? SHA.test(value)
      : name === "state_hash"
        ? /^[a-f0-9]{64}$/u.test(value)
        : name === "head_repo"
          ? REPOSITORY.test(value)
          : name === "ci_green" || name === "dispatched" || name === "first_party"
            ? /^(?:true|false)$/u.test(value)
            : /^[1-9][0-9]*$/u.test(value);
  if (!validValue) throw new Error(`invalid ${name} output value`);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("GITHUB_OUTPUT must be a regular file");
    // GitHub supplies this output file. The name and value are restricted to
    // typed controller outputs above, and O_NOFOLLOW rejects link substitution.
    // codeql[js/http-to-file-access]
    fs.writeFileSync(descriptor, `${name}=${value}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Resolve exactly one open pull request for a workflow-run head. */
async function findExactPull(headSha: string, headRepo: string, headBranch: string): Promise<Pull> {
  const { token, repository } = tokenAndRepository();
  if (!SHA.test(headSha) || !REPOSITORY.test(headRepo) || !headBranch || /[\r\n]/u.test(headBranch))
    throw new Error("invalid workflow head identity");
  const owner = headRepo.split("/", 1)[0]!;
  const pulls = await githubApi<Pull[]>(
    `repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}&per_page=100`,
    token,
  );
  const matches = pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.head.sha === headSha &&
      pull.head.repo?.full_name === headRepo &&
      pull.base.repo.full_name === repository,
  );
  if (matches.length !== 1) throw new Error(`expected one open PR for ${headRepo}@${headSha}`);
  return matches[0]!;
}

/** Read the canonical changed-file set for the current exact PR revision. */
export async function pullChangedFiles(
  repository: string,
  prNumber: number,
  token: string,
): Promise<string[]> {
  const files = await githubRestPaginated<PullFile>(
    `repos/${repository}/pulls/${prNumber}/files`,
    token,
    5001,
  );
  if (files.length > 5000) throw new Error("required-live PR exceeds 5000 changed files");
  const changedFiles = files.map((file) => file.filename);
  if (
    new Set(changedFiles).size !== changedFiles.length ||
    changedFiles.some(
      (file) =>
        !file || file.startsWith("/") || file.split("/").includes("..") || /[\r\n]/u.test(file),
    )
  ) {
    throw new Error("GitHub returned an unsafe required-live changed-file set");
  }
  return changedFiles;
}

/** Create the stable required-live check before fallible PR resolution. */
export async function initialize(args: Record<string, string | undefined>): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const headSha = required(args.head, "head");
  if (!SHA.test(headSha)) throw new Error("invalid required-live head SHA");
  const checkRunId = await createCheck(
    repository,
    token,
    headSha,
    "Required live E2E is being planned",
    `Exact PR head ${headSha.slice(0, 12)}.`,
    CHECK_NAME,
  );
  output("check_id", String(checkRunId));
}

/** Publish the exact PR identity and triggering CI result. */
export async function resolve(): Promise<void> {
  const headSha = process.env.HEAD_SHA ?? "";
  const headRepo = process.env.HEAD_REPO ?? "";
  const headBranch = process.env.HEAD_BRANCH ?? "";
  const pull = await findExactPull(headSha, headRepo, headBranch);
  const { repository } = tokenAndRepository();
  output("pr_number", String(pull.number));
  output("base_sha", pull.base.sha);
  output("head_sha", pull.head.sha);
  output("head_repo", headRepo);
  output("first_party", String(headRepo === repository));
  output("ci_green", String(process.env.CI_CONCLUSION === "success"));
}

/** Read a bounded private JSON artifact. */
function readJson(file: string): unknown {
  return JSON.parse(readPrivateRegularFile(file, { maxBytes: 1024 * 1024 })!);
}

/** Validate exact-head Advisor output and return supported required jobs. */
export function advisorJobs(
  advisorDir: string,
  headSha: string,
  changedFiles: readonly string[],
): {
  jobs: string[];
  unsupported: string[];
} {
  const result = readJson(path.join(advisorDir, "e2e-target-advisor-result.json")) as TargetResult;
  const artifactPlan = readJson(path.join(advisorDir, "risk-plan.json")) as {
    headSha?: unknown;
    changedFiles?: unknown;
  };
  if (
    artifactPlan.headSha !== headSha ||
    !Array.isArray(artifactPlan.changedFiles) ||
    JSON.stringify([...artifactPlan.changedFiles].sort()) !==
      JSON.stringify([...changedFiles].sort()) ||
    result.version !== 1 ||
    !Array.isArray(result.changedFiles) ||
    JSON.stringify([...result.changedFiles].sort()) !== JSON.stringify([...changedFiles].sort()) ||
    !Array.isArray(result.required)
  ) {
    throw new Error("Advisor result does not match the exact-head risk plan");
  }
  const jobs: string[] = [];
  const unsupported: string[] = [];
  for (const recommendation of result.required) {
    if (!recommendation.required || typeof recommendation.id !== "string") continue;
    if (recommendation.selectorType === "job" && JOB.test(recommendation.id))
      jobs.push(recommendation.id);
    else unsupported.push(recommendation.id);
  }
  return { jobs: [...new Set(jobs)], unsupported: [...new Set(unsupported)] };
}

/** Create the stable check and dispatch an exact-head required-live plan. */
export async function start(args: Record<string, string | undefined>): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const checkRunId = positive(args.checkId, "check-id");
  const prNumber = positive(args.pr, "pr");
  const baseSha = required(args.base, "base");
  const headSha = required(args.head, "head");
  const headRepo = required(args.headRepo, "head-repo");
  if (!SHA.test(baseSha) || !SHA.test(headSha) || !REPOSITORY.test(headRepo))
    throw new Error("invalid PR identity");

  const pull = await githubApi<Pull>(`repos/${repository}/pulls/${prNumber}`, token);
  if (
    pull.state !== "open" ||
    pull.base.sha !== baseSha ||
    pull.head.sha !== headSha ||
    pull.head.repo?.full_name !== headRepo
  ) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "failure",
      title: "PR head was superseded",
      summary: "No live E2E was dispatched for a stale PR revision.",
    });
    output("dispatched", "false");
    return;
  }
  if (args.ciGreen !== "true") {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "failure",
      title: "Normal CI must pass before live E2E",
      summary:
        "The exact-head CI run did not complete successfully, so no live jobs were dispatched.",
    });
    output("dispatched", "false");
    return;
  }
  if (headRepo !== repository) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "failure",
      title: "Fork live E2E requires a trusted upstream branch",
      summary:
        "Advisor planning is automatic, but secret-bearing fork code is never dispatched. A maintainer must promote the reviewed revision to an upstream branch.",
    });
    output("dispatched", "false");
    return;
  }

  const allowedJobs = new Set(readFreeStandingJobsInventory().allowedJobs);
  const changedFiles = await pullChangedFiles(repository, prNumber, token);
  const plan = validateRiskPlan(buildRiskPlan({ headSha, changedFiles }), allowedJobs);
  const advisorDir = required(args.advisorDir, "advisor-dir");
  const fromAdvisor = advisorJobs(advisorDir, headSha, plan.changedFiles);
  const jobs = [...new Set([...plan.automaticJobs, ...fromAdvisor.jobs])];
  const invalidJobs = jobs.filter((job) => !allowedJobs.has(job));
  if (
    fromAdvisor.unsupported.length > 0 ||
    invalidJobs.length > 0 ||
    jobs.length > 3 ||
    plan.requiresManualExpansion
  ) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "failure",
      title: "Required live plan needs maintainer expansion",
      summary: `Automatic jobs: ${jobs.join(", ") || "none"}. Unsupported selectors: ${fromAdvisor.unsupported.join(", ") || "none"}.`,
    });
    output("dispatched", "false");
    return;
  }
  if (jobs.length === 0) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "success",
      title: "No live E2E required",
      summary: "The exact-head deterministic and Advisor plans selected no required live jobs.",
    });
    output("dispatched", "false");
    return;
  }

  const currentPull = await githubApi<Pull>(`repos/${repository}/pulls/${prNumber}`, token);
  if (
    currentPull.state !== "open" ||
    currentPull.base.sha !== baseSha ||
    currentPull.head.sha !== headSha ||
    currentPull.head.repo?.full_name !== headRepo
  ) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "failure",
      title: "PR head changed before live dispatch",
      summary: "No live E2E was dispatched because the exact PR revision was superseded.",
    });
    output("dispatched", "false");
    return;
  }

  const correlationId = randomUUID();
  const executionPlanHash = createHash("sha256")
    .update(
      JSON.stringify({
        deterministicPlanHash: plan.planHash,
        headRepo,
        headSha,
        jobs: [...jobs].sort(),
        prNumber,
      }),
    )
    .digest("hex");
  const runId = await dispatchRiskWorkflow({
    repository,
    token,
    jobs,
    commitSha: headSha,
    planHash: executionPlanHash,
    correlationId,
    prNumber,
  });
  // Publish the trusted API response immediately so the always-run cleanup can
  // cancel the child even if local state persistence fails afterward.
  output("run_id", String(runId));
  const state: RiskGateState = {
    version: 1,
    commitSha: headSha,
    planHash: executionPlanHash,
    correlationId,
    expectedJobs: jobs,
    expectedShards: expectedRiskSignalShards(jobs),
    requiresManualExpansion: false,
    prNumber,
  };
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  const statePath = path.join(process.env.RUNNER_TEMP ?? "", "required-live-state.json");
  writePrivateRegularFile(statePath, serialized);
  output("state_hash", createHash("sha256").update(serialized).digest("hex"));
  output("dispatched", "true");
}

/** Close an incomplete gate and stop its correlated child when still active. */
export async function abandon(args: Record<string, string | undefined>): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const runId = args.runId ? positive(args.runId, "run-id") : undefined;
  try {
    if (runId) {
      const child = await githubApi<WorkflowRun>(
        `repos/${repository}/actions/runs/${runId}`,
        token,
      );
      if (child.status === "queued" || child.status === "in_progress") {
        await githubApi(`repos/${repository}/actions/runs/${runId}/cancel`, token, {
          method: "POST",
        });
      }
    }
  } finally {
    await completeCheck({ repository, checkRunId: positive(args.checkId, "check-id") }, token, {
      conclusion: "failure",
      title: "Required live E2E coordinator stopped early",
      summary: "The coordinator could not produce complete exact-head evidence.",
    });
  }
}

/** Cancel queued or running required-live children for a superseded PR head. */
export async function cancel(args: Record<string, string | undefined>): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const prNumber = positive(args.pr, "pr");
  const prefix = `E2E PR #${prNumber} risk `;
  const matchingRuns = new Map<number, WorkflowRun>();
  for (const status of ["queued", "in_progress"]) {
    const runs = await githubRestPaginated<WorkflowRun>(
      `repos/${repository}/actions/workflows/e2e.yaml/runs?event=workflow_dispatch&status=${status}`,
      token,
      100,
    );
    for (const run of runs.filter((candidate) => candidate.display_title.startsWith(prefix))) {
      matchingRuns.set(run.id, run);
    }
  }
  for (const run of matchingRuns.values()) {
    await githubApi(`repos/${repository}/actions/runs/${run.id}/cancel`, token, { method: "POST" });
  }
}

/** Route the requested coordinator mode. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "initialize") return initialize(args);
  if (args.mode === "resolve") return resolve();
  if (args.mode === "cancel") return cancel(args);
  if (args.mode === "start") return start(args);
  if (args.mode === "abandon") return abandon(args);
  if (args.mode === "finish") {
    return finishRiskGate({
      statePath: required(args.state, "state"),
      stateHash: required(args.stateHash, "state-hash"),
      evidencePath: required(args.evidence, "evidence"),
      checkRunId: positive(args.checkId, "check-id"),
      childRunId: positive(args.runId, "run-id"),
      requireSuccess: true,
      returnAfterRecordedFailure: true,
    });
  }
  throw new Error("--mode must be initialize, resolve, cancel, start, finish, or abandon");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
