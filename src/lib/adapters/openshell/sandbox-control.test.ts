// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CaptureOpenshellBinaryResult } from "./client";
import { createCliOpenShellSandboxControl } from "./sandbox-control";

describe("CLI OpenShell sandbox control", () => {
  it("maps a typed exec request to the existing CLI contract", async () => {
    const captureBinary = vi.fn(
      (): CaptureOpenshellBinaryResult => ({
        status: 0,
        stdout: Buffer.from("hello\n"),
        stderr: Buffer.from("warning\n"),
      }),
    );
    const control = createCliOpenShellSandboxControl({
      resolveBinary: () => "/usr/bin/openshell",
      captureBinary,
    });

    const result = await control.exec({
      sandboxName: "alpha",
      command: ["openclaw", "sessions", "list", "--json"],
      stdin: Buffer.from("request body"),
      maxOutputBytes: 4096,
      timeoutMs: 30_000,
    });

    expect(captureBinary).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "sessions", "list", "--json"],
      {
        input: Buffer.from("request body"),
        maxBuffer: 4096,
        timeout: 30_000,
      },
    );
    expect(result).toEqual({
      status: 0,
      stdout: "hello\n",
      stderr: "warning\n",
    });
  });

  it("preserves transport failures without throwing", async () => {
    const error = Object.assign(new Error("spawnSync openshell ENOBUFS"), { code: "ENOBUFS" });
    const captureBinary = vi.fn(
      (): CaptureOpenshellBinaryResult => ({
        status: null,
        stdout: Buffer.from("partial"),
        stderr: Buffer.alloc(0),
        error,
        signal: "SIGTERM",
      }),
    );
    const control = createCliOpenShellSandboxControl({
      resolveBinary: () => "/usr/bin/openshell",
      captureBinary,
    });

    await expect(control.exec({ sandboxName: "alpha", command: ["true"] })).resolves.toEqual({
      status: null,
      stdout: "partial",
      stderr: "",
      error,
      signal: "SIGTERM",
    });
  });

  it("preserves archive bytes through the CLI fallback", async () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const captureBinary = vi.fn(
      (): CaptureOpenshellBinaryResult => ({
        status: 0,
        stdout: bytes,
        stderr: Buffer.from("warning"),
      }),
    );
    const control = createCliOpenShellSandboxControl({
      resolveBinary: () => "/usr/bin/openshell",
      captureBinary,
    });

    await expect(
      control.exec({
        sandboxName: "alpha",
        command: ["tar", "-cf", "-", "workspace"],
        maxOutputBytes: 1024,
        stdoutEncoding: "buffer",
        timeoutMs: 120_000,
      }),
    ).resolves.toEqual({
      status: 0,
      stdout: "",
      stdoutBytes: bytes,
      stderr: "warning",
    });
    expect(captureBinary).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "exec", "--name", "alpha", "--", "tar", "-cf", "-", "workspace"],
      { input: undefined, maxBuffer: 1024, timeout: 120_000 },
    );
  });
});
