// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { validateOpenShellExecRequest } from "../adapters/openshell/sandbox-control";

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

const {
  backupSandboxState,
  buildSandboxDirectoryAuditCommand,
  buildSandboxDirectoryAuditInput,
  buildSandboxDirectoryDiscoveryCommand,
  buildSandboxDirectoryNameList,
  MAX_SANDBOX_DIRECTORY_AUDIT_BYTES,
  MAX_SANDBOX_DIRECTORY_AUDIT_ENTRIES,
  MAX_SANDBOX_DIRECTORY_NAME_LIST_BYTES,
  parseSandboxDirectoryAudit,
  parseSandboxDirectoryNameList,
} = await import("./sandbox.js");
const BACKUPS_ROOT = path.join(TEST_HOME, ".nemoclaw", "rebuild-backups");
const STATE_DIR = "/sandbox/.fixture";

interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes?: Buffer;
  error?: Error;
  signal?: NodeJS.Signals;
}

function completed(stdout = ""): ExecResult {
  return { status: 0, stdout, stderr: "" };
}

function completedDirectoryProbe(names: readonly string[]): ExecResult {
  const encoded = buildSandboxDirectoryNameList(names);
  assert.ok(encoded.ok);
  return { ...completed(), stdoutBytes: encoded.input };
}

function encodeAuditEntries(
  entries: readonly (readonly [type: string, entryPath: string, linkTarget: string])[],
): Buffer {
  return Buffer.from(entries.flatMap((entry) => [...entry, ""]).join("\0"), "utf8");
}

function completedAudit(
  entries: readonly (readonly [type: string, entryPath: string, linkTarget: string])[] = [],
): ExecResult {
  return { ...completed(), stdoutBytes: encodeAuditEntries(entries) };
}

function queueSuccessfulProbeAndAudit(
  dirName: string | readonly string[] = "state",
  auditEntries: readonly (readonly [type: string, entryPath: string, linkTarget: string])[] = [],
): void {
  const names = typeof dirName === "string" ? [dirName] : dirName;
  mocks.execSandboxReadOnlyWithGrpcFallback
    .mockResolvedValueOnce(completedDirectoryProbe(names))
    .mockResolvedValueOnce(completedAudit(auditEntries));
}

function createBinaryTarArchive(dirName: string | readonly string[] = "state"): {
  archive: Buffer;
  payload: Buffer;
} {
  const names = typeof dirName === "string" ? [dirName] : [...dirName];
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-grpc-state-source-"));
  const payload = Buffer.from([0x53, 0x54, 0x41, 0x54, 0x45, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
  try {
    for (const name of names) fs.mkdirSync(path.join(source, name), { recursive: true });
    fs.writeFileSync(path.join(source, names[0], "payload.bin"), payload);
    const result = spawnSync("tar", ["-cf", "-", "-C", source, ...names], {
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
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
  const expectedNames = buildSandboxDirectoryNameList([dirName]);
  assert.ok(expectedNames.ok);
  const expectedAuditInput = buildSandboxDirectoryAuditInput(STATE_DIR, [dirName]);
  assert.ok(expectedAuditInput.ok);

  expect(calls[0]).toEqual([
    "nemoclaw",
    expect.objectContaining({
      sandboxName: "alpha",
      command: ["sh", "-c", expect.stringContaining("xargs -0")],
      stdin: expectedNames.input,
      maxOutputBytes: MAX_SANDBOX_DIRECTORY_NAME_LIST_BYTES + 1,
      stdoutEncoding: "buffer",
      timeoutMs: 30_000,
    }),
  ]);
  expect(calls[1]).toEqual([
    "nemoclaw",
    expect.objectContaining({
      sandboxName: "alpha",
      command: ["sh", "-c", expect.stringContaining("find -files0-from=-")],
      stdin: expectedAuditInput.input,
      maxOutputBytes: MAX_SANDBOX_DIRECTORY_AUDIT_BYTES + 1,
      stdoutEncoding: "buffer",
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
  const expectedNames = buildSandboxDirectoryNameList([dirName]);
  assert.ok(expectedNames.ok);
  expect(calls[2]).toEqual([
    "nemoclaw",
    {
      sandboxName: "alpha",
      command: [
        "sh",
        "-c",
        `tar -cf - -C '${STATE_DIR}' --null --verbatim-files-from --files-from=-`,
      ],
      stdin: expectedNames.input,
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
    ["unterminated NUL list", Buffer.from("state", "utf8"), "truncated name list"],
    ["empty element", Buffer.from("state\0\0", "utf8"), "empty path"],
    ["invalid UTF-8", Buffer.from([0xff, 0]), "invalid UTF-8"],
    ["traversal", Buffer.from("../state\0", "utf8"), "unsafe path"],
  ])("rejects directory discovery output with an %s", (_kind, output, expectedError) => {
    expect(parseSandboxDirectoryNameList(output)).toEqual({
      ok: false,
      error: expect.stringContaining(expectedError),
    });
  });

  it("accepts a directory name list exactly at the byte budget", () => {
    const name = "x".repeat(MAX_SANDBOX_DIRECTORY_NAME_LIST_BYTES - 1);
    const encoded = buildSandboxDirectoryNameList([name]);
    assert.ok(encoded.ok);
    expect(encoded.input).toHaveLength(MAX_SANDBOX_DIRECTORY_NAME_LIST_BYTES);

    const parsed = parseSandboxDirectoryNameList(encoded.input);
    assert.ok(parsed.ok);
    expect(parsed.names).toEqual([name]);
  });

  it.each([
    ["symlink", ["l", `${STATE_DIR}/state/leak`, "/etc/passwd"]],
    ["hard link", ["f", `${STATE_DIR}/state/shared.db`, ""]],
    ["special file", ["p", `${STATE_DIR}/state/control.fifo`, ""]],
  ] as const)("rejects an unsafe %s audit row before requesting a tar archive", async (_kind, row) => {
    queueSuccessfulProbeAndAudit("state", [row]);

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

  it("parses newline-bearing paths as one NUL-framed audit record", () => {
    const entry = ["p", `${STATE_DIR}/state/line\nfeed`, ""] as const;

    expect(parseSandboxDirectoryAudit(encodeAuditEntries([entry]), STATE_DIR, ["state"])).toEqual({
      ok: true,
      entries: [{ type: "p", path: entry[1], linkTarget: "" }],
    });
    expect(buildSandboxDirectoryAuditCommand()).toContain('-printf "%y\\0%p\\0%l\\0"');
  });

  it.each([
    [
      "incomplete field count",
      Buffer.from(`l\0${STATE_DIR}/state/leak\0/etc/passwd\0extra\0`, "utf8"),
      "incomplete record",
    ],
    [
      "invalid UTF-8",
      Buffer.concat([Buffer.from("l\0"), Buffer.from([0xff]), Buffer.from("\0/etc/passwd\0")]),
      "invalid UTF-8",
    ],
    [
      "unterminated record",
      Buffer.from(`l\0${STATE_DIR}/state/leak\0/etc/passwd`, "utf8"),
      "truncated record",
    ],
    ["unexpected type", encodeAuditEntries([["d", `${STATE_DIR}/state`, ""]]), "invalid file type"],
    ["outside root", encodeAuditEntries([["l", "/etc/passwd", "/tmp/x"]]), "outside its root"],
    [
      "path traversal",
      encodeAuditEntries([["l", `${STATE_DIR}/state/../config/leak`, "/tmp/x"]]),
      "outside its root",
    ],
    [
      "outside expected directory",
      encodeAuditEntries([["l", `${STATE_DIR}/config/leak`, "/tmp/x"]]),
      "outside its expected state directories",
    ],
    [
      "non-link target",
      encodeAuditEntries([["f", `${STATE_DIR}/state/shared.db`, "unexpected"]]),
      "invalid link target field",
    ],
  ])("rejects an audit with %s", (_kind, output, expectedError) => {
    expect(parseSandboxDirectoryAudit(output, STATE_DIR, ["state"])).toEqual({
      ok: false,
      error: expect.stringContaining(expectedError),
    });
  });

  it("bounds audit bytes and record count before parsing fields", () => {
    expect(
      parseSandboxDirectoryAudit(Buffer.alloc(MAX_SANDBOX_DIRECTORY_AUDIT_BYTES + 1), STATE_DIR, [
        "state",
      ]),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("bytes"),
    });
    expect(
      parseSandboxDirectoryAudit(
        Buffer.from("f\0\0\0".repeat(MAX_SANDBOX_DIRECTORY_AUDIT_ENTRIES + 1), "utf8"),
        STATE_DIR,
        ["state"],
      ),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("entries"),
    });
  });

  it.each([
    "error",
    "signal",
  ] as const)("fails closed when the audit returns status zero with a transport %s", async (failureKind) => {
    mocks.execSandboxReadOnlyWithGrpcFallback
      .mockResolvedValueOnce(completedDirectoryProbe(["state"]))
      .mockResolvedValueOnce({
        ...completed(),
        ...(failureKind === "error"
          ? { error: new Error("audit stream reset") }
          : { signal: "SIGTERM" }),
      });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
      backedUpDirs: [],
      failedDirs: ["state"],
      error: expect.stringContaining(
        failureKind === "error" ? "audit stream reset" : "signal SIGTERM",
      ),
    });
    expect(mocks.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(completedDirectoryProbe([dirName]))
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
    expect(auditCommand).toContain("find -files0-from=-");
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
    const allowedAuditRow = [
      "l",
      `${STATE_DIR}/extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal`,
      "../qrcode-terminal/bin/qrcode-terminal.js",
    ] as const;
    queueSuccessfulProbeAndAudit("extensions", [allowedAuditRow]);
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
    expect(auditCommand).toContain("find -files0-from=-");
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

  it.each([
    ["error", { error: new Error("sandbox exec stream reset") }],
    ["signal", { signal: "SIGTERM" as const }],
  ])("rejects tar bytes returned with a transport %s even when tar reports success", async (_failureKind, transportFailure) => {
    const { archive } = createBinaryTarArchive();
    queueSuccessfulProbeAndAudit();
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      ...completed(),
      stdoutBytes: archive,
      ...transportFailure,
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

  it.each([
    ["LF", "workspace-line\nfeed"],
    ["CR", "workspace-carriage\rreturn"],
  ])("fails closed when discovery returns a directory name containing %s", async (_kind, name) => {
    const discoveryOutput = Buffer.from(`state\0${name}\0`, "utf8");
    expect(parseSandboxDirectoryNameList(discoveryOutput)).toEqual({
      ok: false,
      error: "sandbox directory name list contains an unsafe CR/LF path",
    });
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      ...completed(),
      stdoutBytes: discoveryOutput,
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
      backedUpDirs: [],
      failedDirs: ["state"],
      error: "sandbox directory name list contains an unsafe CR/LF path",
    });
    expect(mocks.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledOnce();
  });

  it("executes discovery successfully when a declared directory is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-directory-discovery-"));
    try {
      fs.mkdirSync(path.join(root, "present"));
      fs.mkdirSync(path.join(root, "workspace-dynamic"));
      const input = buildSandboxDirectoryNameList(["present", "missing"]);
      expect(input).toMatchObject({ ok: true });
      assert.ok(input.ok);

      const result = spawnSync("sh", ["-c", buildSandboxDirectoryDiscoveryCommand(root)], {
        input: input.input,
        encoding: null,
      });

      expect(result.status).toBe(0);
      expect(parseSandboxDirectoryNameList(Buffer.from(result.stdout ?? ""))).toMatchObject({
        ok: true,
        names: ["present", "workspace-dynamic"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("backs up 95 long workspace directories without oversized gRPC argv", async () => {
    const names = Array.from({ length: 95 }, (_, index) => {
      const prefix = `workspace-${String(index).padStart(3, "0")}-`;
      return `${prefix}${"x".repeat(200 - prefix.length)}`;
    });
    mocks.loadAgent.mockReturnValue({
      configPaths: { dir: STATE_DIR },
      expectedVersion: null,
      stateDirs: names,
      stateFiles: [],
    });
    const { archive } = createBinaryTarArchive(names);
    queueSuccessfulProbeAndAudit(names);
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      ...completed(),
      stdoutBytes: archive,
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: true,
      backedUpDirs: names,
      failedDirs: [],
    });
    expect(mocks.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledTimes(3);
    const calls = mocks.execSandboxReadOnlyWithGrpcFallback.mock.calls;
    for (const [, request] of calls) {
      expect(validateOpenShellExecRequest(request)).toBeNull();
    }
    const encoded = buildSandboxDirectoryNameList(names);
    expect(encoded).toMatchObject({ ok: true });
    assert.ok(encoded.ok);
    const auditInput = buildSandboxDirectoryAuditInput(STATE_DIR, names);
    expect(auditInput).toMatchObject({ ok: true });
    assert.ok(auditInput.ok);
    expect(encoded.input.length).toBeLessThanOrEqual(MAX_SANDBOX_DIRECTORY_NAME_LIST_BYTES);
    expect(calls[0][1].stdin).toEqual(encoded.input);
    expect(calls[1][1].stdin).toEqual(auditInput.input);
    expect(calls[2][1].stdin).toEqual(encoded.input);
  });

  it("fails closed before discovery when the declared NUL list exceeds the request budget", async () => {
    const names = Array.from({ length: 5_500 }, (_, index) => {
      const prefix = `state-${String(index).padStart(4, "0")}-`;
      return `${prefix}${"x".repeat(200 - prefix.length)}`;
    });
    mocks.loadAgent.mockReturnValue({
      configPaths: { dir: STATE_DIR },
      expectedVersion: null,
      stateDirs: names,
      stateFiles: [],
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
      backedUpDirs: [],
      failedDirs: names,
      error: expect.stringContaining("directory name list exceeds"),
    });
    expect(mocks.execSandboxReadOnlyWithGrpcFallback).not.toHaveBeenCalled();
  });

  it("fails closed before audit when the discovered NUL list exceeds the request budget", async () => {
    mocks.execSandboxReadOnlyWithGrpcFallback.mockResolvedValueOnce({
      ...completed(),
      stdoutBytes: Buffer.alloc(MAX_SANDBOX_DIRECTORY_NAME_LIST_BYTES + 1, 0x61),
    });

    const result = await backupSandboxState("alpha");

    expect(result).toMatchObject({
      success: false,
      backedUpDirs: [],
      failedDirs: ["state"],
      error: expect.stringContaining("directory name list exceeds"),
    });
    expect(mocks.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledOnce();
  });
});
