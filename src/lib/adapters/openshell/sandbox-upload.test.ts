// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxControl } from "./sandbox-control.js";
import {
  cleanupSandboxPayloadAfterFailure,
  createPrivateSandboxPayloadFile,
  createPrivateSandboxPayloadFileFromPath,
  createSandboxPayloadRemotePath,
  SANDBOX_PAYLOAD_CLEANUP_MAX_OUTPUT_BYTES,
  SANDBOX_PAYLOAD_CLEANUP_OK,
  SANDBOX_PAYLOAD_CLEANUP_PYTHON,
  SANDBOX_PAYLOAD_CLEANUP_TIMEOUT_MS,
  SANDBOX_PAYLOAD_UPLOAD_MAX_OUTPUT_BYTES,
  SANDBOX_PAYLOAD_UPLOAD_TIMEOUT_MS,
  type SandboxPayloadUploadDependencies,
  uploadSandboxPayloadFile,
} from "./sandbox-upload.js";

describe("OpenShell sandbox payload upload", () => {
  it("uses the exact gateway, option terminator, timeout, and output cap", () => {
    const capture = vi.fn<NonNullable<SandboxPayloadUploadDependencies["capture"]>>(() => ({
      status: 0,
      output: "",
      stdout: "",
      stderr: "",
    }));

    const result = uploadSandboxPayloadFile(
      "nemoclaw-18080",
      "-sandbox",
      "/private/input",
      "/tmp/nemoclaw-state-restore-fixed",
      { capture },
    );

    expect(result).toEqual({
      ok: true,
      remotePath: "/tmp/nemoclaw-state-restore-fixed",
    });
    expect(capture).toHaveBeenCalledWith(
      [
        "sandbox",
        "upload",
        "-g",
        "nemoclaw-18080",
        "--",
        "-sandbox",
        "/private/input",
        "/tmp/nemoclaw-state-restore-fixed",
      ],
      {
        ignoreError: true,
        includeStreams: true,
        timeout: SANDBOX_PAYLOAD_UPLOAD_TIMEOUT_MS,
        maxBuffer: SANDBOX_PAYLOAD_UPLOAD_MAX_OUTPUT_BYTES,
      },
    );
  });

  it("rejects an ambient endpoint override before invoking OpenShell", () => {
    const capture = vi.fn<NonNullable<SandboxPayloadUploadDependencies["capture"]>>();
    const result = uploadSandboxPayloadFile(
      "nemoclaw",
      "alpha",
      "/private/input",
      "/tmp/nemoclaw-state-restore-fixed",
      { capture, env: { OPENSHELL_GATEWAY_ENDPOINT: "https://wrong.example" } },
    );

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("may bypass") });
    expect(capture).not.toHaveBeenCalled();
  });

  it("stages private bytes and removes the host artifact idempotently", () => {
    const staged = createPrivateSandboxPayloadFile(Buffer.from([0x00, 0xff, 0x41]));
    expect(staged.ok).toBe(true);
    assert(staged.ok);

    try {
      expect(fs.statSync(path.dirname(staged.payload.localPath)).mode & 0o777).toBe(0o700);
      const payloadFd = fs.openSync(
        staged.payload.localPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        expect(fs.fstatSync(payloadFd).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(payloadFd)).toEqual(Buffer.from([0x00, 0xff, 0x41]));
      } finally {
        fs.closeSync(payloadFd);
      }
    } finally {
      staged.payload.cleanup();
    }
    staged.payload.cleanup();
    expect(fs.existsSync(staged.payload.localPath)).toBe(false);
  });

  it("removes private staging when the source file cannot be opened", () => {
    const trustedSourceRoot = fs.mkdtempSync(
      path.join(process.cwd(), ".nemoclaw-sandbox-upload-source-"),
    );
    fs.chmodSync(trustedSourceRoot, 0o700);
    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("nemoclaw-state-upload-")),
    );

    try {
      const staged = createPrivateSandboxPayloadFileFromPath(
        path.join(trustedSourceRoot, "missing"),
        1024,
      );

      expect(staged.ok).toBe(false);
      expect(
        fs
          .readdirSync(os.tmpdir())
          .filter((entry) => entry.startsWith("nemoclaw-state-upload-") && !before.has(entry)),
      ).toEqual([]);
    } finally {
      fs.rmSync(trustedSourceRoot, { recursive: true, force: true });
    }
  });

  it("creates unguessable remote paths in the reviewed namespace", () => {
    expect(createSandboxPayloadRemotePath(() => "fixed-id")).toBe(
      "/tmp/nemoclaw-state-restore-fixed-id",
    );
  });

  it("builds one fixed bounded cleanup request and rejects arbitrary paths", async () => {
    const exec = vi.fn<OpenShellSandboxControl["exec"]>(async () => ({
      status: 0,
      stdout: `${SANDBOX_PAYLOAD_CLEANUP_OK}\n`,
      stderr: "",
    }));
    const control = { exec };

    expect(await cleanupSandboxPayloadAfterFailure(control, "alpha", "/tmp/unrelated")).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(
      await cleanupSandboxPayloadAfterFailure(
        control,
        "alpha",
        "/tmp/nemoclaw-state-restore-fixed-id",
      ),
    ).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith({
      sandboxName: "alpha",
      command: ["python3", "-I", "-", "/tmp/nemoclaw-state-restore-fixed-id"],
      stdin: SANDBOX_PAYLOAD_CLEANUP_PYTHON,
      timeoutMs: SANDBOX_PAYLOAD_CLEANUP_TIMEOUT_MS,
      maxOutputBytes: SANDBOX_PAYLOAD_CLEANUP_MAX_OUTPUT_BYTES,
    });
  });
});
