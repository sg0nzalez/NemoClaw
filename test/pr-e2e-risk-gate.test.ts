// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchRiskWorkflow } from "../tools/e2e-advisor/post-merge-risk-gate.mts";
import {
  abandon,
  advisorJobs,
  cancel,
  initialize,
  pullChangedFiles,
  resolve,
  start,
} from "../tools/e2e-advisor/pr-risk-gate.mts";

const temporaryDirectories: string[] = [];

function artifact(result: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "required-live-advisor-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "e2e-target-advisor-result.json"),
    `${JSON.stringify(result)}\n`,
    { mode: 0o600 },
  );
  const changedFiles = (result as { changedFiles?: string[] }).changedFiles ?? [];
  fs.writeFileSync(
    path.join(directory, "risk-plan.json"),
    `${JSON.stringify({ headSha: "a".repeat(40), changedFiles })}\n`,
    { mode: 0o600 },
  );
  return directory;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("required-live PR plan", () => {
  it("rejects oversized coordinator IDs before any GitHub API request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");

    await expect(abandon({ checkId: "9007199254740992" })).rejects.toThrow(
      "--check-id must be a safe positive integer",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses exact-head required jobs and reports selectors that need expansion", () => {
    const changedFiles = ["src/lib/onboard.ts"];
    const directory = artifact({
      version: 1,
      changedFiles,
      required: [
        { id: "onboard-resume", selectorType: "job", required: true },
        { id: "ubuntu-repo-cloud-openclaw", selectorType: "target", required: true },
        { id: "optional-by-contract", selectorType: "job", required: false },
      ],
    });

    expect(advisorJobs(directory, "a".repeat(40), changedFiles)).toEqual({
      jobs: ["onboard-resume"],
      unsupported: ["ubuntu-repo-cloud-openclaw"],
    });
  });

  it("rejects an Advisor artifact with a different changed-file set", () => {
    const directory = artifact({
      version: 1,
      changedFiles: ["src/lib/other.ts"],
      required: [],
    });

    expect(() => advisorJobs(directory, "a".repeat(40), ["src/lib/onboard.ts"])).toThrow(
      "Advisor result does not match the exact-head risk plan",
    );
  });

  it("rejects an Advisor artifact from another head revision", () => {
    const changedFiles = ["src/lib/onboard.ts"];
    const directory = artifact({ version: 1, changedFiles, required: [] });

    expect(() => advisorJobs(directory, "b".repeat(40), changedFiles)).toThrow(
      "Advisor result does not match the exact-head risk plan",
    );
  });

  it("uses GitHub's canonical PR changed-file set instead of a direct commit range", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ filename: "src/a.ts" }, { filename: "src/b.ts" }])),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(pullChangedFiles("NVIDIA/NemoClaw", 42, "token")).resolves.toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("pulls/42/files?per_page=100&page=1");
  });

  it("binds a PR dispatch to its exact revision and cancellation group", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          workflow_run_id: 91,
          run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/91",
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/91",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchRiskWorkflow({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs: ["onboard-resume"],
        commitSha: "a".repeat(40),
        planHash: "b".repeat(64),
        correlationId: "12345678-1234-4123-8123-123456789abc",
        prNumber: 42,
      }),
    ).resolves.toBe(91);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      ref: "main",
      inputs: {
        checkout_sha: "a".repeat(40),
        jobs: "onboard-resume",
        pr_number: "42",
        risk_pr: "true",
        risk_shadow: "true",
      },
    });
  });

  it("creates the stable check before fallible PR resolution", async () => {
    const outputFile = path.join(artifact({ changedFiles: [] }), "outputs");
    fs.writeFileSync(outputFile, "", { mode: 0o600 });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 17 })));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputFile);

    await initialize({ head: "a".repeat(40) });

    expect(fs.readFileSync(outputFile, "utf8")).toBe("check_id=17\n");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: "E2E / Required Live",
      head_sha: "a".repeat(40),
      status: "in_progress",
    });
  });

  it("resolves the exact workflow head and carries only a successful CI conclusion", async () => {
    const outputFile = path.join(artifact({ changedFiles: [] }), "outputs");
    fs.writeFileSync(outputFile, "", { mode: 0o600 });
    const pull = {
      number: 42,
      state: "open",
      head: { sha: "a".repeat(40), repo: { full_name: "NVIDIA/NemoClaw" } },
      base: { sha: "b".repeat(40), repo: { full_name: "NVIDIA/NemoClaw" } },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([pull])));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputFile);
    vi.stubEnv("HEAD_SHA", "a".repeat(40));
    vi.stubEnv("HEAD_REPO", "NVIDIA/NemoClaw");
    vi.stubEnv("HEAD_BRANCH", "feature");
    vi.stubEnv("CI_CONCLUSION", "success");

    await resolve();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("head=NVIDIA%3Afeature");
    expect(new Set(fs.readFileSync(outputFile, "utf8").trim().split("\n"))).toEqual(
      new Set([
        "pr_number=42",
        `base_sha=${"b".repeat(40)}`,
        `head_sha=${"a".repeat(40)}`,
        "head_repo=NVIDIA/NemoClaw",
        "first_party=true",
        "ci_green=true",
      ]),
    );
  });

  it("blocks secret-bearing live execution for fork heads", async () => {
    const outputFile = path.join(artifact({ changedFiles: [] }), "outputs");
    fs.writeFileSync(outputFile, "", { mode: 0o600 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 42,
            state: "open",
            head: { sha: "a".repeat(40), repo: { full_name: "contributor/NemoClaw" } },
            base: { sha: "b".repeat(40), repo: { full_name: "NVIDIA/NemoClaw" } },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputFile);

    await start({
      checkId: "17",
      pr: "42",
      base: "b".repeat(40),
      head: "a".repeat(40),
      headRepo: "contributor/NemoClaw",
      ciGreen: "true",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "Fork live E2E requires a trusted upstream branch" },
    });
    expect(fs.readFileSync(outputFile, "utf8")).toBe("dispatched=false\n");
  });

  it("blocks dispatch when the PR head changes after exact-head planning", async () => {
    const changedFiles = ["src/lib/onboard.ts"];
    const directory = artifact({ version: 1, changedFiles, required: [] });
    const outputFile = path.join(directory, "outputs");
    fs.writeFileSync(outputFile, "", { mode: 0o600 });
    const matchingPull = {
      number: 42,
      state: "open",
      head: { sha: "a".repeat(40), repo: { full_name: "NVIDIA/NemoClaw" } },
      base: { sha: "b".repeat(40), repo: { full_name: "NVIDIA/NemoClaw" } },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(matchingPull)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(changedFiles.map((filename) => ({ filename })))),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...matchingPull,
            head: { ...matchingPull.head, sha: "c".repeat(40) },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputFile);

    await start({
      checkId: "17",
      pr: "42",
      base: "b".repeat(40),
      head: "a".repeat(40),
      headRepo: "NVIDIA/NemoClaw",
      ciGreen: "true",
      advisorDir: directory,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/dispatches"))).toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "PR head changed before live dispatch" },
    });
  });

  it("cancels a transitioning child run only once", async () => {
    const run = { id: 91, display_title: "E2E PR #42 risk correlation", status: "queued" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([run]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ ...run, status: "in_progress" }]), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");

    await cancel({ pr: "42" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("actions/runs/91/cancel");
  });

  it("abandons an incomplete gate and cancels its still-running child", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 91, display_title: "E2E PR #42 risk id", status: "in_progress" }),
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");

    await abandon({ checkId: "17", runId: "91" });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("actions/runs/91/cancel");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("check-runs/17");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });

  it("closes an abandoned gate even when child cancellation fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 91, status: "in_progress" })))
      .mockResolvedValueOnce(new Response("cancel unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");

    await expect(abandon({ checkId: "17", runId: "91" })).rejects.toThrow();

    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("check-runs/17");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });
});
