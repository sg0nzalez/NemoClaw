// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STATION_PREPARE_PATH = "scripts/prepare-dgx-station-host.sh";
export const HARDWARE_MARKER = "STATION_HARDWARE_EVIDENCE";
export const DEFERRAL_MARKER = "STATION_HARDWARE_DEFERRAL";
const GITHUB_CHANGED_FILE_LIMIT = 3_000;
const HEAD_CHECK_NAME = "Station / Hardware Evidence";

type ChangedFile = {
  filename: string;
  previous_filename?: string;
  sha: string;
  status: string;
};

type PullRequest = {
  body: string | null;
  head: {
    repo: { full_name: string };
    sha: string;
  };
  number: number;
};

type IssueComment = {
  body: string | null;
  issue_url: string;
  user: { login: string } | null;
};

type FollowUpIssue = {
  html_url: string;
  pull_request?: unknown;
  state: string;
};

export type StationHardwareGateApi = {
  getBlob(repo: string, sha: string): Promise<Buffer>;
  getCollaboratorPermission(login: string): Promise<string>;
  getFileAtCommit(repo: string, path: string, commit: string): Promise<Buffer>;
  getFollowUpIssue(number: number): Promise<FollowUpIssue>;
  getIssueComment(id: number): Promise<IssueComment>;
};

export type StationHardwareGateInput = {
  api: StationHardwareGateApi;
  changedFiles: ChangedFile[];
  changedFilesComplete: boolean;
  pullRequest: PullRequest;
  repository: string;
};

export type StationHardwareGateResult = {
  mode: "hardware" | "not-applicable" | "deferral";
  prepareScriptSha256?: string;
  summary: string;
};

export class StationHardwareGateError extends Error {}

function fail(message: string): never {
  throw new StationHardwareGateError(message);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function section(body: string): string {
  const heading = /^## DGX Station Hardware Validation[ \t]*$/imu;
  const match = heading.exec(body);
  if (!match) {
    fail("PR description is missing the 'DGX Station Hardware Validation' section.");
  }
  const tail = body.slice(match.index + match[0].length);
  const nextHeading = /^##\s+/mu.exec(tail);
  return nextHeading ? tail.slice(0, nextHeading.index) : tail;
}

function checked(sectionBody: string, label: string): boolean {
  return new RegExp(`^- \\[x\\] ${escapeRegex(label)}[ \\t]*$`, "imu").test(sectionBody);
}

function field(sectionBody: string, label: string): string {
  const match = new RegExp(`^${escapeRegex(label)}:[ \\t]*(.*?)[ \\t]*$`, "imu").exec(sectionBody);
  const value = match?.[1]?.trim() ?? "";
  return value.replace(/^`(.*)`$/u, "$1").replace(/^<(.*)>$/u, "$1");
}

export function parseSelection(body: string): {
  deferral: boolean;
  deferralComment: string;
  evidenceComment: string;
  hardware: boolean;
} {
  const sectionBody = section(body);
  return {
    deferral: checked(sectionBody, "Maintainer-approved deferral recorded"),
    deferralComment: field(sectionBody, "Deferral comment"),
    evidenceComment: field(sectionBody, "Evidence comment"),
    hardware: checked(sectionBody, "Real DGX Station validation passed"),
  };
}

function markerFields(body: string, marker: string, required: string[]): Record<string, string> {
  const markerMatches = [...body.matchAll(new RegExp(`^${escapeRegex(marker)}[ \\t]*$`, "gmu"))];
  markerMatches.length === 1 || fail(`Linked comment must contain exactly one ${marker} marker.`);
  const markerIndex = markerMatches[0]?.index ?? fail(`Unable to locate ${marker}.`);
  const tail = body.slice(markerIndex + marker.length);
  const values: Record<string, string> = {};

  for (const line of tail.split(/\r?\n/u)) {
    const entry = /^([a-z][a-z0-9_]*)=(.*)$/u.exec(line.trim());
    if (!entry || !required.includes(entry[1] ?? "")) continue;
    const key = entry[1] ?? "";
    Object.hasOwn(values, key) && fail(`Linked comment contains duplicate ${key} fields.`);
    values[key] = (entry[2] ?? "").trim();
  }

  for (const key of required) {
    values[key] || fail(`Linked comment is missing ${key}.`);
  }
  return values;
}

function samePrCommentId(url: string, repository: string, prNumber: number): number {
  const pattern = new RegExp(
    `^https://github\\.com/${escapeRegex(repository)}/(?:pull|issues)/${prNumber}#issuecomment-(\\d+)$`,
    "u",
  );
  const match = pattern.exec(url);
  if (!match?.[1]) {
    fail("Comment link must reference an issue comment on this PR.");
  }
  return Number(match[1]);
}

function followUpNumber(url: string, repository: string): number {
  const match = new RegExp(
    `^https://github\\.com/${escapeRegex(repository)}/issues/(\\d+)$`,
    "u",
  ).exec(url);
  if (!match?.[1]) {
    fail("Deferral follow_up must link an issue in this repository.");
  }
  return Number(match[1]);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateCommentBelongsToPr(
  comment: IssueComment,
  repository: string,
  prNumber: number,
): void {
  const expectedSuffix = `/repos/${repository}/issues/${prNumber}`;
  comment.issue_url.endsWith(expectedSuffix) || fail("Linked comment does not belong to this PR.");
}

async function validateHardwareEvidence(
  input: StationHardwareGateInput,
  currentHash: string,
  commentUrl: string,
): Promise<StationHardwareGateResult> {
  const commentId = samePrCommentId(commentUrl, input.repository, input.pullRequest.number);
  const comment = await input.api.getIssueComment(commentId);
  validateCommentBelongsToPr(comment, input.repository, input.pullRequest.number);
  const values = markerFields(comment.body ?? "", HARDWARE_MARKER, [
    "result",
    "tested_commit",
    "prepare_script_sha256",
    "profile",
  ]);

  values.result === "PASS" || fail("Station hardware evidence result must be PASS.");
  /^[0-9a-f]{40}$/u.test(values.tested_commit ?? "") ||
    fail("Station hardware evidence tested_commit must be a lowercase 40-character SHA.");
  /^[0-9a-f]{64}$/u.test(values.prepare_script_sha256 ?? "") ||
    fail("Station hardware evidence prepare_script_sha256 must be a lowercase SHA-256.");
  /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(values.profile ?? "") ||
    fail("Station hardware evidence profile is missing or malformed.");
  values.prepare_script_sha256 === currentHash ||
    fail(
      "Station hardware evidence is stale: preparation script hash does not match this PR head.",
    );

  const testedScript = await input.api.getFileAtCommit(
    input.pullRequest.head.repo.full_name,
    STATION_PREPARE_PATH,
    values.tested_commit ?? "",
  );
  sha256(testedScript) === currentHash ||
    fail(
      "Station hardware evidence tested_commit does not contain the recorded preparation script.",
    );

  return {
    mode: "hardware",
    prepareScriptSha256: currentHash,
    summary: `PASS: real DGX Station evidence matches preparation script ${currentHash}.`,
  };
}

async function validateDeferral(
  input: StationHardwareGateInput,
  currentHash: string,
  commentUrl: string,
): Promise<StationHardwareGateResult> {
  const commentId = samePrCommentId(commentUrl, input.repository, input.pullRequest.number);
  const comment = await input.api.getIssueComment(commentId);
  validateCommentBelongsToPr(comment, input.repository, input.pullRequest.number);
  const login = comment.user?.login ?? fail("Deferral comment has no author.");
  const permission = await input.api.getCollaboratorPermission(login);
  ["admin", "maintain"].includes(permission) ||
    fail("Deferral comment author must have maintain or admin repository permission.");

  const values = markerFields(comment.body ?? "", DEFERRAL_MARKER, [
    "prepare_script_sha256",
    "reason",
    "remaining_risk",
    "follow_up",
  ]);
  values.prepare_script_sha256 === currentHash ||
    fail(
      "Station hardware deferral is stale: preparation script hash does not match this PR head.",
    );
  (values.reason?.length ?? 0) >= 10 || fail("Station hardware deferral reason is too short.");
  (values.remaining_risk?.length ?? 0) >= 10 ||
    fail("Station hardware deferral remaining_risk is too short.");

  const issueNumber = followUpNumber(values.follow_up ?? "", input.repository);
  const followUp = await input.api.getFollowUpIssue(issueNumber);
  !followUp.pull_request || fail("Station hardware deferral follow_up must be an issue, not a PR.");
  followUp.state === "open" || fail("Station hardware deferral follow_up issue must be open.");

  return {
    mode: "deferral",
    prepareScriptSha256: currentHash,
    summary: `PASS WITH DEFERRAL: ${login} accepted the remaining Station risk in ${followUp.html_url}.`,
  };
}

export async function evaluateStationHardwareGate(
  input: StationHardwareGateInput,
): Promise<StationHardwareGateResult> {
  const relevant = input.changedFiles.filter(
    (file) =>
      file.filename === STATION_PREPARE_PATH || file.previous_filename === STATION_PREPARE_PATH,
  );
  if (relevant.length === 0) {
    input.changedFilesComplete ||
      fail(
        "GitHub PR file listing reached its 3,000-file limit; cannot prove the Station preparation script is unchanged.",
      );
    return { mode: "not-applicable", summary: `${STATION_PREPARE_PATH} was not changed.` };
  }
  relevant.length === 1 || fail("Preparation script appears more than once in the PR file list.");
  const changed = relevant[0] ?? fail("Preparation script change could not be resolved.");
  (changed.filename === STATION_PREPARE_PATH && changed.status !== "removed") ||
    fail("Preparation script removal or rename requires separate maintainer review.");

  const currentScript = await input.api.getBlob(input.pullRequest.head.repo.full_name, changed.sha);
  const currentHash = sha256(currentScript);
  const selection = parseSelection(input.pullRequest.body ?? "");
  selection.hardware !== selection.deferral ||
    fail("Select exactly one Station hardware outcome: real validation or maintainer deferral.");

  if (selection.hardware) {
    selection.evidenceComment || fail("Hardware validation requires an Evidence comment link.");
    !selection.deferralComment ||
      fail("Hardware validation must not include a Deferral comment link.");
    return validateHardwareEvidence(input, currentHash, selection.evidenceComment);
  }

  selection.deferralComment || fail("Maintainer deferral requires a Deferral comment link.");
  !selection.evidenceComment ||
    fail("Maintainer deferral must not include an Evidence comment link.");
  return validateDeferral(input, currentHash, selection.deferralComment);
}

type GitHubBlob = { content: string; encoding: string };
type GitHubContent = { content: string; encoding: string; type: string };
type GitHubCheckRun = { id: number };
type RequestOptions = {
  body?: unknown;
  method?: "GET" | "PATCH" | "POST";
};

function splitRepository(repository: string): [string, string] {
  const match = /^([^/]+)\/([^/]+)$/u.exec(repository);
  if (!match) {
    fail(`Invalid repository name: ${repository}`);
  }
  return [match[1] ?? "", match[2] ?? ""];
}

function apiPath(repository: string, suffix: string): string {
  const [owner, repo] = splitRepository(repository);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

async function requestJson<T>(
  token: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "nemoclaw-station-hardware-evidence-gate",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    method: options.method ?? "GET",
    signal: AbortSignal.timeout(30_000),
  });
  response.ok || fail(`GitHub API request failed with HTTP ${response.status}.`);
  return (await response.json()) as T;
}

async function createHeadCheck(
  token: string,
  repository: string,
  headSha: string,
): Promise<number> {
  const check = await requestJson<GitHubCheckRun>(token, apiPath(repository, "/check-runs"), {
    body: {
      head_sha: headSha,
      name: HEAD_CHECK_NAME,
      status: "in_progress",
    },
    method: "POST",
  });
  return check.id;
}

async function completeHeadCheck(
  token: string,
  repository: string,
  checkId: number,
  conclusion: "failure" | "success",
  summary: string,
): Promise<void> {
  await requestJson<GitHubCheckRun>(token, apiPath(repository, `/check-runs/${checkId}`), {
    body: {
      conclusion,
      output: {
        summary,
        title:
          conclusion === "success"
            ? "Station evidence remains valid"
            : "Station evidence is no longer valid",
      },
      status: "completed",
    },
    method: "PATCH",
  });
}

function decodeGitHubContent(payload: GitHubBlob | GitHubContent): Buffer {
  payload.encoding === "base64" || fail("GitHub returned unsupported content encoding.");
  return Buffer.from(payload.content.replace(/\s/gu, ""), "base64");
}

async function loadChangedFiles(
  token: string,
  repository: string,
  prNumber: number,
): Promise<{ complete: boolean; files: ChangedFile[] }> {
  const files: ChangedFile[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await requestJson<ChangedFile[]>(
      token,
      apiPath(repository, `/pulls/${prNumber}/files?per_page=100&page=${page}`),
    );
    files.push(...batch);
    if (batch.length < 100) return { complete: true, files };
    if (files.length >= GITHUB_CHANGED_FILE_LIMIT) return { complete: false, files };
  }
}

function githubApi(token: string, repository: string): StationHardwareGateApi {
  return {
    async getBlob(repo, sha) {
      const payload = await requestJson<GitHubBlob>(token, apiPath(repo, `/git/blobs/${sha}`));
      return decodeGitHubContent(payload);
    },
    async getCollaboratorPermission(login) {
      const payload = await requestJson<{ permission: string }>(
        token,
        apiPath(repository, `/collaborators/${encodeURIComponent(login)}/permission`),
      );
      return payload.permission;
    },
    async getFileAtCommit(repo, path, commit) {
      const payload = await requestJson<GitHubContent>(
        token,
        apiPath(repo, `/contents/${path}?ref=${encodeURIComponent(commit)}`),
      );
      payload.type === "file" || fail("Preparation script at tested_commit is not a file.");
      return decodeGitHubContent(payload);
    },
    async getFollowUpIssue(number) {
      return requestJson<FollowUpIssue>(token, apiPath(repository, `/issues/${number}`));
    },
    async getIssueComment(id) {
      return requestJson<IssueComment>(token, apiPath(repository, `/issues/comments/${id}`));
    },
  };
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN ?? fail("GH_TOKEN is required.");
  const repository = process.env.GITHUB_REPOSITORY ?? fail("GITHUB_REPOSITORY is required.");
  const prNumberText = process.env.PR_NUMBER ?? fail("PR_NUMBER is required.");
  /^\d+$/u.test(prNumberText) || fail("PR_NUMBER must be numeric.");
  const prNumber = Number(prNumberText);
  const pullRequest = await requestJson<PullRequest>(
    token,
    apiPath(repository, `/pulls/${prNumber}`),
  );
  const publishHeadCheck = process.env.PUBLISH_HEAD_CHECK === "true";
  const checkId = publishHeadCheck
    ? await createHeadCheck(token, repository, pullRequest.head.sha)
    : undefined;

  try {
    const changedFileListing = await loadChangedFiles(token, repository, prNumber);
    const result = await evaluateStationHardwareGate({
      api: githubApi(token, repository),
      changedFiles: changedFileListing.files,
      changedFilesComplete: changedFileListing.complete,
      pullRequest,
      repository,
    });
    checkId !== undefined &&
      (await completeHeadCheck(token, repository, checkId, "success", result.summary));
    console.log(result.summary);
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    summaryFile &&
      appendFileSync(summaryFile, `## Station hardware evidence\n\n${result.summary}\n`, "utf8");
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown Station hardware evidence failure.";
    checkId !== undefined &&
      (await completeHeadCheck(token, repository, checkId, "failure", message));
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown Station hardware evidence failure.";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
