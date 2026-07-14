// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "./client";
import { captureOpenshell } from "./runtime";

export interface SandboxExecRequest {
  sandboxName: string;
  command: readonly string[];
  maxOutputBytes?: number;
}

export interface SandboxExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

export interface OpenShellSandboxControl {
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
}

export type OpenShellExecRequestValidationIssue =
  | { kind: "empty-command" }
  | { kind: "too-many-arguments"; actual: number; max: number }
  | {
      kind: "argument-too-large";
      index: number;
      actualBytes: number;
      maxBytes: number;
    }
  | {
      kind: "argument-control-character";
      index: number;
      character: "nul" | "lf" | "cr";
    };

export const OPENSHELL_EXEC_INVALID_ARGUMENT = "OPENSHELL_EXEC_INVALID_ARGUMENT";

/** A command OpenShell v0.0.72 will reject before attempting sandbox execution. */
export class OpenShellExecRequestValidationError extends Error {
  readonly code = OPENSHELL_EXEC_INVALID_ARGUMENT;

  constructor(readonly issue: OpenShellExecRequestValidationIssue) {
    super(openShellExecRequestValidationMessage(issue));
    this.name = "OpenShellExecRequestValidationError";
  }
}

type CaptureOpenShell = typeof captureOpenshell;

const OPENSHELL_V0072_MAX_EXEC_COMMAND_ARGS = 1024;
const OPENSHELL_V0072_MAX_EXEC_ARGUMENT_BYTES = 32 * 1024;

function openShellExecRequestValidationMessage(issue: OpenShellExecRequestValidationIssue): string {
  switch (issue.kind) {
    case "empty-command":
      return "command is required";
    case "too-many-arguments":
      return `command array exceeds ${String(issue.max)} argument limit`;
    case "argument-too-large":
      return `command argument ${String(issue.index)} exceeds ${String(issue.maxBytes)} byte limit`;
    case "argument-control-character":
      return issue.character === "nul"
        ? `command argument ${String(issue.index)} contains null bytes`
        : `command argument ${String(issue.index)} contains newline or carriage return characters`;
  }
}

/** Match OpenShell v0.0.72's pre-dispatch command validation. */
export function validateOpenShellExecCommand(
  command: readonly string[],
): OpenShellExecRequestValidationError | null {
  if (command.length === 0) {
    return new OpenShellExecRequestValidationError({ kind: "empty-command" });
  }
  if (command.length > OPENSHELL_V0072_MAX_EXEC_COMMAND_ARGS) {
    return new OpenShellExecRequestValidationError({
      kind: "too-many-arguments",
      actual: command.length,
      max: OPENSHELL_V0072_MAX_EXEC_COMMAND_ARGS,
    });
  }

  for (const [index, argument] of command.entries()) {
    const actualBytes = Buffer.byteLength(argument, "utf8");
    if (actualBytes > OPENSHELL_V0072_MAX_EXEC_ARGUMENT_BYTES) {
      return new OpenShellExecRequestValidationError({
        kind: "argument-too-large",
        index,
        actualBytes,
        maxBytes: OPENSHELL_V0072_MAX_EXEC_ARGUMENT_BYTES,
      });
    }
    if (argument.includes("\0")) {
      return new OpenShellExecRequestValidationError({
        kind: "argument-control-character",
        index,
        character: "nul",
      });
    }
    const newlineIndex = argument.search(/[\n\r]/);
    if (newlineIndex !== -1) {
      return new OpenShellExecRequestValidationError({
        kind: "argument-control-character",
        index,
        character: argument[newlineIndex] === "\n" ? "lf" : "cr",
      });
    }
  }

  return null;
}

export function openShellExecRequestValidationFailure(
  error: OpenShellExecRequestValidationError,
): SandboxExecResult {
  return { status: null, stdout: "", stderr: "", error };
}

function normalizeExecResult(result: CaptureOpenshellResult): SandboxExecResult {
  const normalized: SandboxExecResult = {
    status: result.status,
    stdout: result.stdout ?? result.output,
    stderr: result.stderr ?? "",
  };
  if (result.error) normalized.error = result.error;
  if (result.signal !== undefined) normalized.signal = result.signal;
  return normalized;
}

export function createCliOpenShellSandboxControl(
  capture: CaptureOpenShell = captureOpenshell,
): OpenShellSandboxControl {
  return {
    async exec(request): Promise<SandboxExecResult> {
      const validationError = validateOpenShellExecCommand(request.command);
      if (validationError) return openShellExecRequestValidationFailure(validationError);

      const result = capture(
        ["sandbox", "exec", "--name", request.sandboxName, "--", ...request.command],
        {
          ignoreError: true,
          includeStreams: true,
          maxBuffer: request.maxOutputBytes,
        },
      );
      return normalizeExecResult(result);
    },
  };
}

export const openShellSandboxControl = createCliOpenShellSandboxControl();
