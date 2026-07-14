// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CaptureOpenshellBinaryResult, CaptureOpenshellResult } from "./client";
import {
  createCliOpenShellSandboxControl,
  createGatewayScopedCliOpenShellSandboxControl,
} from "./sandbox-control";

describe("CLI OpenShell sandbox control", () => {
  it("maps a typed exec request to the existing CLI contract", async () => {
    const capture = vi.fn(
      (): CaptureOpenshellResult => ({
        status: 0,
        output: "hello",
        stdout: "hello\n",
        stderr: "warning\n",
      }),
    );
    const control = createCliOpenShellSandboxControl(capture);

    const result = await control.exec({
      sandboxName: "alpha",
      command: ["openclaw", "sessions", "list", "--json"],
      stdin: Buffer.from("request body"),
      maxOutputBytes: 4096,
      timeoutMs: 30_000,
    });

    expect(capture).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "sessions", "list", "--json"],
      {
        ignoreError: true,
        includeStreams: true,
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
    const capture = vi.fn(
      (): CaptureOpenshellResult => ({
        status: null,
        output: "partial",
        error,
        signal: "SIGTERM",
      }),
    );
    const control = createCliOpenShellSandboxControl(capture);

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
    const control = createCliOpenShellSandboxControl(vi.fn(), {
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
      ["sandbox", "exec", "--name", "alpha", "--", "tar", "-cf", "-", "workspace"],
      { input: undefined, maxBuffer: 1024, timeout: 120_000 },
    );
  });

  it("pins fallback execution to the requested gateway", async () => {
    const capture = vi.fn(
      (): CaptureOpenshellResult => ({
        status: 0,
        output: "ok",
        stdout: "ok\n",
        stderr: "",
      }),
    );
    const control = createGatewayScopedCliOpenShellSandboxControl("edge-west", capture);

    await control.exec({ sandboxName: "alpha", command: ["true"] });

    expect(capture).toHaveBeenCalledWith(
      ["--gateway", "edge-west", "sandbox", "exec", "--name", "alpha", "--", "true"],
      expect.objectContaining({ ignoreError: true, includeStreams: true }),
    );
  });
});
