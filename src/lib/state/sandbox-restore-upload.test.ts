// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  exec: vi.fn(),
  getSandbox: vi.fn(),
  loadAgent: vi.fn(),
  select: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("../adapters/openshell/sandbox-control-routing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/sandbox-control-routing.js")>()),
  selectOpenShellSandboxControlForMutation: mocks.select,
}));

vi.mock("../adapters/openshell/sandbox-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/sandbox-upload.js")>()),
  uploadSandboxPayloadFile: mocks.upload,
}));

vi.mock("../agent/defs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/defs.js")>()),
  loadAgent: mocks.loadAgent,
}));

vi.mock("./registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry.js")>()),
  getSandbox: mocks.getSandbox,
}));

import {
  SANDBOX_PAYLOAD_CLEANUP_OK,
  SANDBOX_PAYLOAD_CLEANUP_PYTHON,
} from "../adapters/openshell/sandbox-upload.js";
import { restoreRecreatedSandboxState } from "./sandbox.js";
import { STATE_DIRECTORY_RESTORE_PYTHON } from "./sandbox-restore-payload.js";

const fixtures: string[] = [];
const STATE_ROOT = "/sandbox/.fixture";

function completed() {
  return { status: 0, stdout: "RESTORE_OK\n", stderr: "" };
}

function cleanupCompleted() {
  return { status: 0, stdout: `${SANDBOX_PAYLOAD_CLEANUP_OK}\n`, stderr: "" };
}

function restoreExecCalls() {
  return mocks.exec.mock.calls.filter(
    ([request]) => request.stdin === STATE_DIRECTORY_RESTORE_PYTHON,
  );
}

function cleanupExecCalls() {
  return mocks.exec.mock.calls.filter(
    ([request]) => request.stdin === SANDBOX_PAYLOAD_CLEANUP_PYTHON,
  );
}

function writeDirectoryBackup(
  withStateFile = false,
  stateDirs: string[] = ["workspace"],
  materializeDirectories = true,
  manifestDir = STATE_ROOT,
): string {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-upload-"));
  fixtures.push(backupPath);
  for (const stateDir of materializeDirectories ? stateDirs : []) {
    fs.mkdirSync(path.join(backupPath, stateDir));
    fs.writeFileSync(path.join(backupPath, stateDir, "large.bin"), Buffer.alloc(1024 * 1024 + 7));
  }
  fs.writeFileSync(path.join(backupPath, "config.json"), "{}\n");
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify({
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-07-14T00:00:00.000Z",
      agentType: "fixture",
      agentVersion: null,
      expectedVersion: null,
      stateDirs,
      backedUpDirs: stateDirs,
      stateFiles: withStateFile ? [{ path: "config.json", strategy: "copy" }] : [],
      dir: manifestDir,
      backupPath,
      blueprintDigest: null,
    }),
  );
  return backupPath;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSandbox.mockReturnValue({
    name: "alpha",
    agent: "fixture",
    gatewayName: "nemoclaw-18080",
  });
  mocks.loadAgent.mockReturnValue({
    configPaths: { dir: STATE_ROOT },
    stateDirs: ["workspace"],
    stateFiles: [],
  });
  mocks.select.mockReturnValue({
    control: { exec: mocks.exec },
    transport: "grpc",
    close: mocks.close,
  });
  mocks.exec.mockImplementation(async (request) =>
    request.stdin === SANDBOX_PAYLOAD_CLEANUP_PYTHON ? cleanupCompleted() : completed(),
  );
  mocks.upload.mockImplementation(
    (_gateway: string, _sandbox: string, _local: string, remotePath: string) => ({
      ok: true,
      remotePath,
    }),
  );
});

afterEach(() => {
  delete process.env.OPENSHELL_GATEWAY_ENDPOINT;
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("state directory restore transport boundary", () => {
  it("uploads once to the registry gateway and dispatches one canonical fixed-program mutation", async () => {
    const backupPath = writeDirectoryBackup();
    let stagedPath = "";
    mocks.upload.mockImplementation(
      (gateway: string, sandbox: string, localPath: string, remotePath: string) => {
        stagedPath = localPath;
        expect(gateway).toBe("nemoclaw-18080");
        expect(sandbox).toBe("alpha");
        expect(fs.statSync(localPath).size).toBeGreaterThan(1024 * 1024);
        return { ok: true, remotePath };
      },
    );

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
    });

    expect(result).toEqual({
      success: true,
      restoredDirs: ["workspace"],
      failedDirs: [],
      restoredFiles: [],
      failedFiles: [],
    });
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.exec).toHaveBeenCalledOnce();
    const request = mocks.exec.mock.calls[0][0];
    expect(request).toMatchObject({
      sandboxName: "alpha",
      command: [
        "python3",
        "-I",
        "-",
        expect.stringMatching(/^\/tmp\/nemoclaw-state-restore-/),
        STATE_ROOT,
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ],
      stdin: STATE_DIRECTORY_RESTORE_PYTHON,
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
    });
    expect(fs.existsSync(stagedPath)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("uses an explicit non-default gateway before an unregistered recreated sandbox is published", async () => {
    const backupPath = writeDirectoryBackup();
    mocks.getSandbox.mockReturnValue(undefined);

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
      gatewayName: "nemoclaw-18080",
    });

    expect(result).toMatchObject({ success: true, restoredDirs: ["workspace"] });
    expect(mocks.upload).toHaveBeenCalledWith(
      "nemoclaw-18080",
      "alpha",
      expect.any(String),
      expect.stringMatching(/^\/tmp\/nemoclaw-state-restore-/),
    );
    expect(mocks.exec).toHaveBeenCalledOnce();
    expect(mocks.select).toHaveBeenCalledWith("nemoclaw-18080");
  });

  it("canonicalizes a legacy trailing-slash manifest root before mutation", async () => {
    const backupPath = writeDirectoryBackup(false, ["workspace"], true, `${STATE_ROOT}/`);

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
      gatewayName: "nemoclaw-18080",
    });

    expect(result).toMatchObject({ success: true, restoredDirs: ["workspace"] });
    expect(restoreExecCalls()).toHaveLength(1);
    expect(restoreExecCalls()[0]?.[0].command[4]).toBe(STATE_ROOT);
  });

  it("accepts a discovered top-level workspace directory outside target declarations", async () => {
    const backupPath = writeDirectoryBackup(false, ["workspace-.legacy", "workspace-_legacy"]);

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
      gatewayName: "nemoclaw-18080",
    });

    expect(result).toMatchObject({
      success: true,
      restoredDirs: ["workspace-.legacy", "workspace-_legacy"],
    });
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.exec).toHaveBeenCalledOnce();
  });

  it("rejects an undeclared directory before gateway selection or upload", async () => {
    const backupPath = writeDirectoryBackup(false, ["secrets"]);

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
      gatewayName: "nemoclaw-18080",
    });

    expect(result).toMatchObject({ success: false, failedDirs: ["secrets"] });
    expect(result.error).toContain("is not declared by target agent");
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it.each([
    "workspace-",
    "prefix-workspace-agent",
    "nested/workspace-agent",
    "workspace-agent/nested",
    "../workspace-agent",
    "workspace-agent\nextra",
    "workspace-agent\\extra",
    `workspace-${"x".repeat(246)}`,
  ])("rejects non-canonical discovered workspace path %j", async (stateDir) => {
    const backupPath = writeDirectoryBackup(false, [stateDir], false);

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
      gatewayName: "nemoclaw-18080",
    });

    expect(result.success).toBe(false);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("does not dispatch after upload failure", async () => {
    const backupPath = writeDirectoryBackup();
    mocks.upload.mockReturnValue({
      ok: false,
      error: "gateway unavailable",
      remotePath: "/tmp/nemoclaw-state-restore-failed",
    });

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
    });

    expect(result).toMatchObject({ success: false, failedDirs: ["workspace"] });
    expect(result.error).toContain("upload failed");
    expect(restoreExecCalls()).toHaveLength(0);
    expect(cleanupExecCalls()).toHaveLength(1);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "returns an unconfirmed result",
      () =>
        mocks.exec.mockResolvedValueOnce({ status: 1, stdout: "", stderr: "cleanup unavailable" }),
    ],
    ["throws", () => mocks.exec.mockRejectedValueOnce(new Error("cleanup unavailable"))],
  ])("retries only the exact staged cleanup path when the first attempt %s", async (_label, stageFirstCleanup) => {
    const backupPath = writeDirectoryBackup();
    const stagedPaths = new Set(["/tmp/unrelated"]);
    mocks.upload.mockImplementation(
      (_gateway: string, _sandbox: string, _local: string, remotePath: string) => {
        stagedPaths.add(remotePath);
        return { ok: true, remotePath };
      },
    );
    mocks.exec.mockResolvedValueOnce({ status: 1, stdout: "", stderr: "restore failed" });
    stageFirstCleanup();
    mocks.exec.mockImplementationOnce(async (request) => {
      stagedPaths.delete(String(request.command.at(-1)));
      return cleanupCompleted();
    });

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
    });

    const restoreRequests = restoreExecCalls();
    const cleanupRequests = cleanupExecCalls();
    const exactStagedPath = restoreRequests[0]?.[0].command[3];
    expect(result).toMatchObject({ success: false, failedDirs: ["workspace"] });
    expect(restoreRequests).toHaveLength(1);
    expect(cleanupRequests).toHaveLength(2);
    expect(cleanupRequests[1]?.[0]).toBe(cleanupRequests[0]?.[0]);
    expect(cleanupRequests.map(([request]) => request.command.at(-1))).toEqual([
      exactStagedPath,
      exactStagedPath,
    ]);
    expect(stagedPaths).toEqual(new Set(["/tmp/unrelated"]));
  });

  it.each([
    ["error result", { status: null, stdout: "", stderr: "", error: new Error("unknown") }],
    ["signal result", { status: null, stdout: "", stderr: "", signal: "SIGTERM" }],
  ])("never replays an indeterminate %s", async (_label, outcome) => {
    const backupPath = writeDirectoryBackup();
    mocks.exec.mockResolvedValue(outcome);

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
    });

    expect(result).toMatchObject({ success: false, failedDirs: ["workspace"] });
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(restoreExecCalls()).toHaveLength(1);
    expect(cleanupExecCalls()).toHaveLength(2);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("never replays when the selected transport throws after dispatch", async () => {
    const backupPath = writeDirectoryBackup();
    mocks.exec.mockRejectedValue(new Error("dispatch outcome unknown"));

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
    });

    expect(result).toMatchObject({ success: false, failedDirs: ["workspace"] });
    expect(result.error).toContain("dispatch failed");
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(restoreExecCalls()).toHaveLength(1);
    expect(cleanupExecCalls()).toHaveLength(2);
  });

  it.each([
    1, 20, 21, 22, 23,
  ])("does not begin state-file mutations after indeterminate directory status %s", async (status) => {
    const backupPath = writeDirectoryBackup(true);
    mocks.loadAgent.mockReturnValue({
      configPaths: { dir: STATE_ROOT },
      stateDirs: ["workspace"],
      stateFiles: [{ path: "config.json", strategy: "copy" }],
    });
    mocks.exec.mockResolvedValue({ status, stdout: "", stderr: "directory restore failed" });

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
    });

    expect(result).toMatchObject({
      success: false,
      failedDirs: ["workspace"],
      failedFiles: ["config.json"],
    });
    expect(restoreExecCalls()).toHaveLength(1);
    expect(cleanupExecCalls()).toHaveLength(2);
    expect(mocks.upload).toHaveBeenCalledOnce();
  });

  it("fails before upload or selection when the registry binding is invalid", async () => {
    const backupPath = writeDirectoryBackup();
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: "fixture", gatewayName: "foreign" });

    const result = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "fixture",
    });

    expect(result).toMatchObject({ success: false, failedDirs: ["workspace"] });
    expect(result.error).toContain("Invalid persisted sandbox gateway binding");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
