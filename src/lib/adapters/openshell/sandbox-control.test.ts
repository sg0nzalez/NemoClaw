// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CaptureOpenshellResult } from "./client";
import {
  createCliOpenShellSandboxControl,
  OpenShellExecRequestValidationError,
  validateOpenShellExecCommand,
} from "./sandbox-control";

function expectValidationIssue(
  command: readonly string[],
  issue: OpenShellExecRequestValidationError["issue"],
): void {
  const error = validateOpenShellExecCommand(command);
  expect(error).toBeInstanceOf(OpenShellExecRequestValidationError);
  expect(error?.issue).toEqual(issue);
}

describe("OpenShell exec command validation", () => {
  it("requires a command", () => {
    expectValidationIssue([], { kind: "empty-command" });
  });

  it("allows 1024 arguments and rejects 1025", () => {
    expect(validateOpenShellExecCommand(Array.from({ length: 1024 }, () => "x"))).toBeNull();
    expectValidationIssue(
      Array.from({ length: 1025 }, () => "x"),
      {
        kind: "too-many-arguments",
        actual: 1025,
        max: 1024,
      },
    );
  });

  it("measures ASCII arguments in UTF-8 bytes", () => {
    expect(validateOpenShellExecCommand(["x".repeat(32 * 1024)])).toBeNull();
    expectValidationIssue(["x".repeat(32 * 1024 + 1)], {
      kind: "argument-too-large",
      index: 0,
      actualBytes: 32 * 1024 + 1,
      maxBytes: 32 * 1024,
    });
  });

  it("measures multibyte arguments in UTF-8 bytes", () => {
    expect(validateOpenShellExecCommand(["é".repeat(16 * 1024)])).toBeNull();
    expectValidationIssue(["é".repeat(16 * 1024 + 1)], {
      kind: "argument-too-large",
      index: 0,
      actualBytes: 32 * 1024 + 2,
      maxBytes: 32 * 1024,
    });
  });

  it.each([
    ["nul", "\0"],
    ["lf", "\n"],
    ["cr", "\r"],
  ] as const)("rejects %s characters", (character, value) => {
    expectValidationIssue(["sh", `bad${value}argument`], {
      kind: "argument-control-character",
      index: 1,
      character,
    });
  });

  it("allows tabs, shell metacharacters, and empty non-command arguments", () => {
    expect(validateOpenShellExecCommand(["sh", "", "\t; | & $() <> * ?"])).toBeNull();
  });
});

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
      maxOutputBytes: 4096,
      timeoutMs: 30_000,
    });

    expect(capture).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "sessions", "list", "--json"],
      { ignoreError: true, includeStreams: true, maxBuffer: 4096, timeout: 30_000 },
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

  it("returns a standard failure without capture for invalid commands", async () => {
    const capture = vi.fn<() => CaptureOpenshellResult>();
    const control = createCliOpenShellSandboxControl(capture);

    const result = await control.exec({ sandboxName: "alpha", command: ["bad\ncommand"] });

    expect(capture).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: null, stdout: "", stderr: "" });
    expect(result.error).toBeInstanceOf(OpenShellExecRequestValidationError);
    expect((result.error as OpenShellExecRequestValidationError).issue).toEqual({
      kind: "argument-control-character",
      index: 0,
      character: "lf",
    });
  });

  it("forwards an exact-boundary argument unchanged", async () => {
    const capture = vi.fn(
      (): CaptureOpenshellResult => ({ status: 0, output: "", stdout: "", stderr: "" }),
    );
    const control = createCliOpenShellSandboxControl(capture);
    const boundaryArgument = "é".repeat(16 * 1024);

    await control.exec({ sandboxName: "alpha", command: ["printf", boundaryArgument] });

    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "printf",
      boundaryArgument,
    ]);
    expect(capture.mock.calls[0]?.[0]?.at(-1)).toBe(boundaryArgument);
  });
});
