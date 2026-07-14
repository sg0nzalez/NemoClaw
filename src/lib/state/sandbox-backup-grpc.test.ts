// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
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

function queueSuccessfulProbeAndAudit(dirName = "state", auditOutput = ""): void {
  mocks.execSandboxReadOnlyWithGrpcFallback
    .mockResolvedValueOnce(completed(`${dirName}\n`))
    .mockResolvedValueOnce(completed(auditOutput));
}

function createBinaryTarArchive(dirName = "state"): { archive: Buffer; payload: Buffer } {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-grpc-state-source-"));
  const payload = Buffer.from([0x53, 0x54, 0x41, 0x54, 0x45, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
  try {
    fs.mkdirSync(path.join(source, dirName), { recursive: true });
    fs.writeFileSync(path.join(source, dirName, "payload.bin"), payload);
    const result = spawnSync("tar", ["-cf", "-", "-C", source, dirName], {
      encoding: null,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, `Could not create test tar archive: ${String(result.stderr)}`);
    assert(result.stdout, `Test tar archive was empty: ${String(result.stderr)}`);
    return { archive: Buffer.from(result.stdout), payload };
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function expectProbeAndAuditRequests(dirName = "state"): void {
  const calls = mocks.execSandboxReadOnlyWithGrpcFallback.mock.calls;

  expect(calls[0]).toEqual([
    "nemoclaw",
    expect.objectContaining({
      sandboxName: "alpha",
      command: ["sh", "-c", expect.stringContaining(`[ -d '${STATE_DIR}/${dirName}' ]`)],
      timeoutMs: 30_000,
    }),
  ]);
  expect(calls[1]).toEqual([
    "nemoclaw",
    expect.objectContaining({
      sandboxName: "alpha",
      command: ["sh", "-c", expect.stringContaining(`find '${STATE_DIR}/${dirName}'`)],
      timeoutMs: 30_000,
    }),
  ]);

  // Directory backup must not recreate the removed SSH-config transport.
  expect(mocks.resolveOpenshell).not.toHaveBeenCalled();
  expect(mocks.captureSandboxSshConfigCommand).not.toHaveBeenCalled();
}

function expectProbeAuditAndBinaryTarRequests(dirName = "state"): void {
  expect(mocks.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledTimes(3);
  expectProbeAndAuditRequests(dirName);
  const calls = mocks.execSandboxReadOnlyWithGrpcFallback.mock.calls;
  expect(calls[2]).toEqual([
    "nemoclaw",
    {
      sandboxName: "alpha",
      command: ["sh", "-c", `tar -cf - -C '${STATE_DIR}' -- '${dirName}'`],
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024 * 1024,
      stdoutEncoding: "buffer",
    },
  ]);
}

afterAll(() => {
  void (ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME));
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

  it.each([
    ["symlink", `l\t${STATE_DIR}/state/leak\t/etc/passwd`],
    ["hard link", `f\t${STATE_DIR}/state/shared.db\t`],
    ["special file", `p\t${STATE_DIR}/state/control.fifo\t`],
  ])("rejects an unsafe %s audit row before requesting a tar archive", async (_kind, row) => {
    queueSuccessfulProbeAndAudit("state", `${row}\n`);

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
      backedUpDirs: [],
      failedDirs: ["state"],
      error: expect.stringContaining("Pre-backup audit rejected"),
    });
    expect(mocks.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledTimes(2);
    expectProbeAndAuditRequests();
  });

  it.each([
    "agents",
    "extensions",
  ])("fails closed when an OpenClaw %s subtree cannot be audited", async (dirName) => {
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      policies: [],
    });
    mocks.loadAgent.mockReturnValue({
      configPaths: { dir: STATE_DIR },
      expectedVersion: null,
      stateDirs: [dirName],
      stateFiles: [],
    });
    mocks.execSandboxReadOnlyWithGrpcFallback
      .mockResolvedValueOnce(completed(`${dirName}\n`))
      .mockResolvedValueOnce({
        status: 1,
        stdout: "",
        stderr: `find: '${STATE_DIR}/${dirName}/image-owned': Permission denied`,
      });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
      unreachable: false,
      backedUpDirs: [],
      failedDirs: [dirName],
      error: expect.stringContaining("Pre-backup audit failed"),
    });
    expect(mocks.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledTimes(2);
    expectProbeAndAuditRequests(dirName);
    const auditCommand = mocks.execSandboxReadOnlyWithGrpcFallback.mock.calls[1][1].command[2];
    expect(auditCommand).toContain("audit_status=0");
    expect(auditCommand).toContain('exit "$audit_status"');
    expect(auditCommand).not.toContain("|| true");
    expect(auditCommand).not.toContain("-prune");
  });

  it("accepts the reviewed image symlink audit row before downloading the archive", async () => {
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      policies: [],
    });
    mocks.loadAgent.mockReturnValue({
      configPaths: { dir: STATE_DIR },
      expectedVersion: null,
      stateDirs: ["extensions"],
      stateFiles: [],
    });
    const { archive, payload } = createBinaryTarArchive("extensions");
    const allowedAuditRow =
      `l\t${STATE_DIR}/extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal` +
      "\t../qrcode-terminal/bin/qrcode-terminal.js\n";
    queueSuccessfulProbeAndAudit("extensions", allowedAuditRow);
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      ...completed(),
      stdoutBytes: archive,
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: true,
      backedUpDirs: ["extensions"],
      failedDirs: [],
    });
    expect(
      fs.readFileSync(path.join(result.manifest!.backupPath, "extensions", "payload.bin")),
    ).toEqual(payload);
    expectProbeAuditAndBinaryTarRequests("extensions");
    const auditCommand = mocks.execSandboxReadOnlyWithGrpcFallback.mock.calls[1][1].command[2];
    expect(auditCommand).toContain("audit_status=0");
    expect(auditCommand).toContain('exit "$audit_status"');
    expect(auditCommand).not.toContain("|| true");
    expect(auditCommand).not.toContain("-prune");
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

  it("fails closed when a clean tar result omits binary stdout", async () => {
    queueSuccessfulProbeAndAudit();
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
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
