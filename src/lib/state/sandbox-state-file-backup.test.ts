// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { findMultilineExecArg } from "../actions/sandbox/exec";
import { buildStateFileBackupExecRequest, SQLITE_BACKUP_PY } from "./sandbox";

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
});
