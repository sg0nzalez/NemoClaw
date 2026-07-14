// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findMultilineExecArg } from "../actions/sandbox/exec";
import {
  buildStateFileBackupExecRequest,
  classifyStateFileBackupExecResult,
  isSandboxExecTransportFailure,
  SQLITE_BACKUP_PY,
} from "./sandbox";

describe("state-file backup exec request", () => {
  it("streams the SQLite program through stdin and keeps every command argument single-line", () => {
    const request = buildStateFileBackupExecRequest("hermes", "/sandbox/.hermes", {
      path: "runtime/state.db",
      strategy: "sqlite_backup",
    });

    expect(request.command).toEqual([
      "sh",
      "-c",
      expect.stringContaining('python3 - "$src" "$tmp"'),
    ]);
    expect(request.command.every((argument) => !/[\r\n]/.test(argument))).toBe(true);
    expect(findMultilineExecArg(request.command)).toBe(-1);
    expect(request.command.join("\n")).not.toContain("sqlite3.connect");
    expect(request.command.join("\n")).toContain('python3 - "$src" "$tmp" || exit $?');
    expect(request.stdin).toBe(SQLITE_BACKUP_PY);
    expect(SQLITE_BACKUP_PY).toContain("sqlite3.connect");
    expect(SQLITE_BACKUP_PY).toContain("src_conn.backup(dst_conn)");
    expect(SQLITE_BACKUP_PY).toContain("PRAGMA quick_check");
    expect(request).toMatchObject({
      sandboxName: "hermes",
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024 * 1024,
      stdoutEncoding: "buffer",
    });
  });

  it("does not attach the SQLite program to copy requests", () => {
    const request = buildStateFileBackupExecRequest("hermes", "/sandbox/.hermes", {
      path: "SOUL.md",
      strategy: "copy",
    });

    expect(request.command).toEqual(["sh", "-c", expect.stringContaining('cat -- "$src"')]);
    expect(request).not.toHaveProperty("stdin");
  });

  it("does not emit a temporary database when the streamed Python backup fails", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-backup-failure-"));
    try {
      fs.writeFileSync(path.join(tempDir, "state.db"), "source");
      const request = buildStateFileBackupExecRequest("hermes", tempDir, {
        path: "state.db",
        strategy: "sqlite_backup",
      });
      const failingProgram = [
        "import pathlib, sys",
        "pathlib.Path(sys.argv[2]).write_bytes(b'partial-backup')",
        "raise SystemExit(41)",
      ].join("\n");

      const result = spawnSync("sh", request.command.slice(1), {
        encoding: "utf8",
        input: failingProgram,
      });

      expect(result.status).toBe(41);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("accepts only an error-free binary result as a completed backup", () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    expect(
      classifyStateFileBackupExecResult({
        status: 0,
        stdout: "",
        stdoutBytes: bytes,
        stderr: "",
      }),
    ).toBe("backed_up");
    expect(
      classifyStateFileBackupExecResult({
        status: 0,
        stdout: "",
        stdoutBytes: bytes,
        stderr: "",
        error: new Error("stream failed"),
      }),
    ).toBe("failed");
    expect(
      classifyStateFileBackupExecResult({
        status: 0,
        stdout: "",
        stdoutBytes: bytes,
        stderr: "",
        signal: "SIGTERM",
      }),
    ).toBe("failed");
    expect(
      classifyStateFileBackupExecResult({
        status: 2,
        stdout: "",
        stderr: "",
        error: new Error("lookup failed"),
      }),
    ).toBe("failed");
    expect(classifyStateFileBackupExecResult({ status: 0, stdout: "", stderr: "" })).toBe("failed");
  });

  it("does not classify terminal local validation and output limits as unreachable", () => {
    const outputLimit = Object.assign(new Error("output limit"), { code: "ENOBUFS" });
    const invalidRequest = Object.assign(new Error("invalid request"), {
      code: "OPENSHELL_EXEC_INVALID_ARGUMENT",
    });

    expect(isSandboxExecTransportFailure({ status: null, error: outputLimit })).toBe(false);
    expect(isSandboxExecTransportFailure({ status: null, error: invalidRequest })).toBe(false);
    expect(isSandboxExecTransportFailure({ status: null, error: new Error("UNAVAILABLE") })).toBe(
      true,
    );
    expect(isSandboxExecTransportFailure({ status: null, signal: "SIGKILL" })).toBe(true);
  });
});
