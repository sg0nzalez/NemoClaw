// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));

vi.mock("../adapters/openshell/sandbox-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/sandbox-upload.js")>()),
  uploadSandboxPayloadFile: mocks.upload,
}));

import type { OpenShellSandboxControl } from "../adapters/openshell/sandbox-control";
import {
  SANDBOX_PAYLOAD_CLEANUP_OK,
  SANDBOX_PAYLOAD_CLEANUP_PYTHON,
} from "../adapters/openshell/sandbox-upload.js";
import type { StateFileKeyAllowlistRestoreOwnership } from "../agent/defs";
import { KEY_ALLOWLIST_MERGE_PYTHON } from "./state-file-key-merge";
import {
  KEY_ALLOWLIST_RESTORE_OK,
  MAX_STATE_FILE_RESTORE_BYTES,
  restoreStateFile,
  STATE_FILE_RESTORE_OK,
  STATE_FILE_RESTORE_PYTHON,
} from "./state-file-restore";

const execMock = vi.fn<OpenShellSandboxControl["exec"]>(async (request) => ({
  status: 0,
  stdout:
    request.stdin === SANDBOX_PAYLOAD_CLEANUP_PYTHON
      ? `${SANDBOX_PAYLOAD_CLEANUP_OK}\n`
      : request.command[0] === "/opt/venv/bin/python3"
        ? `${KEY_ALLOWLIST_RESTORE_OK}\n`
        : `${STATE_FILE_RESTORE_OK}\n`,
  stderr: "",
}));
const sandboxControl = { exec: execMock };

const fixtures: string[] = [];
const ownership: StateFileKeyAllowlistRestoreOwnership = {
  merge: "key-allowlist",
  userKeys: [{ key: "ui.show_scrollbar", type: "boolean" }],
  requireFreshTables: ["models"],
};

function createBackupFixture(): { backupPath: string; backupContents: Buffer } {
  const backupPath = fs.mkdtempSync(path.join(process.cwd(), ".nemoclaw-custom-state-"));
  fs.chmodSync(backupPath, 0o700);
  fixtures.push(backupPath);
  const backupContents = Buffer.from(
    '[models]\ndefault = "backup-owned"\n\n[ui]\nshow_scrollbar = true\n',
  );
  fs.writeFileSync(path.join(backupPath, "config.toml"), backupContents);
  return { backupPath, backupContents };
}

function restoreExecCalls() {
  return execMock.mock.calls.filter(
    ([request]) =>
      request.stdin === STATE_FILE_RESTORE_PYTHON || request.stdin === KEY_ALLOWLIST_MERGE_PYTHON,
  );
}

function cleanupExecCalls() {
  return execMock.mock.calls.filter(
    ([request]) => request.stdin === SANDBOX_PAYLOAD_CLEANUP_PYTHON,
  );
}

beforeEach(() => {
  execMock.mockReset();
  execMock.mockImplementation(async (request) => ({
    status: 0,
    stdout:
      request.stdin === SANDBOX_PAYLOAD_CLEANUP_PYTHON
        ? `${SANDBOX_PAYLOAD_CLEANUP_OK}\n`
        : request.command[0] === "/opt/venv/bin/python3"
          ? `${KEY_ALLOWLIST_RESTORE_OK}\n`
          : `${STATE_FILE_RESTORE_OK}\n`,
    stderr: "",
  }));
  mocks.upload.mockReset();
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("custom-image state-file restore capability (#6334)", () => {
  it("restores the complete backup without invoking the managed key allowlist", async () => {
    const { backupPath, backupContents } = createBackupFixture();
    let uploadedContents = Buffer.alloc(0);
    mocks.upload.mockImplementation(
      (gateway: string, sandbox: string, localPath: string, remotePath: string) => {
        expect(gateway).toBe("nemoclaw-18080");
        expect(sandbox).toBe("alpha");
        uploadedContents = fs.readFileSync(localPath);
        return { ok: true, remotePath };
      },
    );

    const restored = await restoreStateFile(
      sandboxControl,
      "alpha",
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      ownership,
      true,
      vi.fn(),
      undefined,
      undefined,
      "nemoclaw-18080",
    );

    expect(restored).toBe(true);
    const request = execMock.mock.calls[0]?.[0];
    expect(request?.command).toEqual([
      "python3",
      "-I",
      "-",
      expect.stringMatching(/^\/tmp\/nemoclaw-state-restore-/),
      "/sandbox/.deepagents",
      "config.toml",
      "copy",
      "0",
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(request?.stdin).toBe(STATE_FILE_RESTORE_PYTHON);
    expect(request?.maxOutputBytes).toBe(64 * 1024);
    expect(uploadedContents).toEqual(backupContents);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(restoreExecCalls()).toHaveLength(1);
    expect(cleanupExecCalls()).toHaveLength(0);
  });

  it("requires the capability before bypassing the managed key allowlist", async () => {
    const { backupPath, backupContents } = createBackupFixture();
    let uploadedContents = Buffer.alloc(0);
    mocks.upload.mockImplementation(
      (_gateway: string, _sandbox: string, localPath: string, remotePath: string) => {
        uploadedContents = fs.readFileSync(localPath);
        return { ok: true, remotePath };
      },
    );

    const restored = await restoreStateFile(
      sandboxControl,
      "alpha",
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      ownership,
      false,
      vi.fn(),
      undefined,
      undefined,
      "nemoclaw-18080",
    );

    expect(restored).toBe(true);
    const request = execMock.mock.calls[0]?.[0];
    expect(request?.command.slice(0, 6)).toEqual([
      "/opt/venv/bin/python3",
      "-I",
      "-",
      "/sandbox/.deepagents",
      "config.toml",
      expect.stringContaining("show_scrollbar"),
    ]);
    expect(request?.command[6]).toEqual(expect.stringMatching(/^\/tmp\/nemoclaw-state-restore-/));
    expect(request?.command[7]).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(request?.stdin).toBe(KEY_ALLOWLIST_MERGE_PYTHON);
    expect(uploadedContents).toEqual(backupContents);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(restoreExecCalls()).toHaveLength(1);
    expect(cleanupExecCalls()).toHaveLength(0);
  });

  it("rejects an oversized sparse host backup before allocation or upload", async () => {
    const { backupPath } = createBackupFixture();
    fs.truncateSync(path.join(backupPath, "config.toml"), MAX_STATE_FILE_RESTORE_BYTES + 1);

    const restored = await restoreStateFile(
      sandboxControl,
      "alpha",
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      ownership,
      true,
      vi.fn(),
    );

    expect(restored).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(restoreExecCalls()).toHaveLength(0);
    expect(cleanupExecCalls()).toHaveLength(0);
  });

  it.each([
    ["error result", { status: null, stdout: "", stderr: "", error: new Error("unknown") }],
    [
      "signal result",
      { status: null, stdout: "", stderr: "", signal: "SIGTERM" as NodeJS.Signals },
    ],
  ])("does not replay an indeterminate selected-transport %s", async (_label, outcome) => {
    const { backupPath } = createBackupFixture();
    mocks.upload.mockImplementation(
      (_gateway: string, _sandbox: string, _localPath: string, remotePath: string) => ({
        ok: true,
        remotePath,
      }),
    );
    execMock.mockResolvedValue(outcome);

    const restored = await restoreStateFile(
      sandboxControl,
      "alpha",
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      undefined,
      true,
      vi.fn(),
      undefined,
      undefined,
      "nemoclaw-18080",
    );

    expect(restored).toBe(false);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(restoreExecCalls()).toHaveLength(1);
    expect(cleanupExecCalls()).toHaveLength(2);
  });

  it("rejects status zero without the fixed success sentinel", async () => {
    const { backupPath } = createBackupFixture();
    mocks.upload.mockImplementation(
      (_gateway: string, _sandbox: string, _localPath: string, remotePath: string) => ({
        ok: true,
        remotePath,
      }),
    );
    execMock.mockResolvedValue({ status: 0, stdout: "unexpected output", stderr: "" });

    const restored = await restoreStateFile(
      sandboxControl,
      "alpha",
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      undefined,
      true,
      vi.fn(),
    );

    expect(restored).toBe(false);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(restoreExecCalls()).toHaveLength(1);
    expect(cleanupExecCalls()).toHaveLength(2);
  });

  it("does not dispatch after a state-file upload failure", async () => {
    const { backupPath } = createBackupFixture();
    mocks.upload.mockReturnValue({
      ok: false,
      error: "upload failed",
      remotePath: "/tmp/nemoclaw-state-restore-failed",
    });

    const restored = await restoreStateFile(
      sandboxControl,
      "alpha",
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      undefined,
      true,
      vi.fn(),
      undefined,
      undefined,
      "nemoclaw-18080",
    );

    expect(restored).toBe(false);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(restoreExecCalls()).toHaveLength(0);
    expect(cleanupExecCalls()).toHaveLength(1);
  });
});
