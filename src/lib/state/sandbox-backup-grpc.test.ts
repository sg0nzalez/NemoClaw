// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureSandboxSshConfigCommand: vi.fn(),
  execSandboxReadOnlyWithGrpcFallback: vi.fn(),
  getSandbox: vi.fn(),
  loadAgent: vi.fn(),
  resolveOpenshell: vi.fn(),
}));

vi.mock("../adapters/openshell/sandbox-control-routing.js", () => ({
  execSandboxReadOnlyWithGrpcFallback: mocks.execSandboxReadOnlyWithGrpcFallback,
}));

vi.mock("../adapters/openshell/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/client.js")>()),
  captureSandboxSshConfigCommand: mocks.captureSandboxSshConfigCommand,
}));

vi.mock("../adapters/openshell/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve.js")>()),
  resolveOpenshell: mocks.resolveOpenshell,
}));

vi.mock("../agent/defs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/defs.js")>()),
  loadAgent: mocks.loadAgent,
}));

vi.mock("./registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry.js")>()),
  getSandbox: mocks.getSandbox,
}));

const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-grpc-state-backup-"));
process.env.HOME = TEST_HOME;

const { backupSandboxState } = await import("./sandbox.js");
const BACKUPS_ROOT = path.join(TEST_HOME, ".nemoclaw", "rebuild-backups");
const STATE_DIR = "/sandbox/.fixture";

interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes?: Buffer;
  error?: Error;
}

function completed(stdout = ""): ExecResult {
  return { status: 0, stdout, stderr: "" };
}

function queueSuccessfulProbeAndAudit(): void {
  mocks.execSandboxReadOnlyWithGrpcFallback
    .mockResolvedValueOnce(completed("state\n"))
    .mockResolvedValueOnce(completed());
}

function createBinaryTarArchive(): { archive: Buffer; payload: Buffer } {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-grpc-state-source-"));
  const payload = Buffer.from([0x53, 0x54, 0x41, 0x54, 0x45, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
  try {
    fs.mkdirSync(path.join(source, "state"), { recursive: true });
    fs.writeFileSync(path.join(source, "state", "payload.bin"), payload);
    const result = spawnSync("tar", ["-cf", "-", "-C", source, "state"], {
      encoding: null,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout) {
      throw new Error(`Could not create test tar archive: ${String(result.stderr)}`);
    }
    return { archive: Buffer.from(result.stdout), payload };
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function expectProbeAuditAndBinaryTarRequests(): void {
  expect(mocks.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledTimes(3);
  const calls = mocks.execSandboxReadOnlyWithGrpcFallback.mock.calls;

  expect(calls[0]).toEqual([
    "nemoclaw",
    expect.objectContaining({
      sandboxName: "alpha",
      command: ["sh", "-c", expect.stringContaining(`[ -d '${STATE_DIR}/state' ]`)],
      timeoutMs: 30_000,
    }),
  ]);
  expect(calls[1]).toEqual([
    "nemoclaw",
    expect.objectContaining({
      sandboxName: "alpha",
      command: ["sh", "-c", expect.stringContaining(`find '${STATE_DIR}/state'`)],
      timeoutMs: 30_000,
    }),
  ]);
  expect(calls[2]).toEqual([
    "nemoclaw",
    {
      sandboxName: "alpha",
      command: ["sh", "-c", `tar -cf - -C '${STATE_DIR}' -- 'state'`],
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024 * 1024,
      stdoutEncoding: "buffer",
    },
  ]);

  // Directory backup must not recreate the removed SSH-config transport.
  expect(mocks.resolveOpenshell).not.toHaveBeenCalled();
  expect(mocks.captureSandboxSshConfigCommand).not.toHaveBeenCalled();
}

afterAll(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
  vi.clearAllMocks();
  mocks.getSandbox.mockReturnValue({
    name: "alpha",
    agent: "fixture",
    policies: [],
  });
  mocks.loadAgent.mockReturnValue({
    configPaths: { dir: STATE_DIR },
    expectedVersion: null,
    stateDirs: ["state"],
    stateFiles: [],
  });
});

describe("backupSandboxState OpenShell directory transport", () => {
  it("probes, audits, and extracts binary tar bytes through the reviewed read-only route", async () => {
    const { archive, payload } = createBinaryTarArchive();
    expect(Buffer.from(archive.toString("utf8"), "utf8")).not.toEqual(archive);
    queueSuccessfulProbeAndAudit();
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      ...completed(),
      stdoutBytes: archive,
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: true,
      unreachable: false,
      backedUpDirs: ["state"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
    });
    expect(result.manifest?.backedUpDirs).toEqual(["state"]);
    expect(fs.readFileSync(path.join(result.manifest!.backupPath, "state", "payload.bin"))).toEqual(
      payload,
    );
    expectProbeAuditAndBinaryTarRequests();
  });

  it("marks a binary tar transport failure unreachable and does not restore partial state", async () => {
    queueSuccessfulProbeAndAudit();
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("sandbox exec stream reset"),
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
      unreachable: true,
      backedUpDirs: [],
      failedDirs: ["state"],
    });
    expect(result.manifest?.backedUpDirs).toEqual([]);
    expect(fs.existsSync(path.join(result.manifest!.backupPath, "state"))).toBe(false);
    expectProbeAuditAndBinaryTarRequests();
  });

  it("fails closed without claiming unreachable for a completed nonzero tar result", async () => {
    queueSuccessfulProbeAndAudit();
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      status: 13,
      stdout: "",
      stderr: "tar: state: Permission denied",
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
      unreachable: false,
      backedUpDirs: [],
      failedDirs: ["state"],
    });
    expect(result.manifest?.backedUpDirs).toEqual([]);
    expect(fs.existsSync(path.join(result.manifest!.backupPath, "state"))).toBe(false);
    expectProbeAuditAndBinaryTarRequests();
  });
});
