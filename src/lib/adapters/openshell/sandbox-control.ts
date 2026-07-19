// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "./client";
import { captureOpenshell } from "./runtime";
import {
  assertNoOpenShellGatewayEndpointOverride,
  type OpenShellGatewayEndpointEnvironment,
} from "../../openshell-gateway-endpoint-guard";

export interface SandboxExecRequest {
  sandboxName: string;
  command: readonly string[];
  /** Maximum combined stdout and stderr bytes retained by the transport. */
  maxOutputBytes?: number;
  /** End-to-end lookup and execution deadline. Zero means no deadline. */
  timeoutMs?: number;
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
  | { kind: "assembled-command-too-large"; actualBytes: number; maxBytes: number }
  | {
      kind: "argument-too-large";
      index: number;
      actualBytes: number;
      maxBytes: number;
    }
  | {
      kind: "argument-control-character";
      index: number;
      character: "nul";
    };

export const OPENSHELL_EXEC_INVALID_ARGUMENT = "OPENSHELL_EXEC_INVALID_ARGUMENT";

/** A command OpenShell v0.0.85 will reject before attempting sandbox execution. */
export class OpenShellExecRequestValidationError extends Error {
  readonly code = OPENSHELL_EXEC_INVALID_ARGUMENT;

  constructor(readonly issue: OpenShellExecRequestValidationIssue) {
    super(openShellExecRequestValidationMessage(issue));
    this.name = "OpenShellExecRequestValidationError";
  }
}

type CaptureOpenShell = typeof captureOpenshell;

const OPENSHELL_V0085_MAX_EXEC_COMMAND_ARGS = 1024;
const OPENSHELL_V0085_MAX_EXEC_ARGUMENT_BYTES = 32 * 1024;
const OPENSHELL_V0085_MAX_ASSEMBLED_COMMAND_BYTES = 256 * 1024;

function openShellExecRequestValidationMessage(issue: OpenShellExecRequestValidationIssue): string {
  switch (issue.kind) {
    case "empty-command":
      return "command is required";
    case "too-many-arguments":
      return `command array exceeds ${String(issue.max)} argument limit`;
    case "assembled-command-too-large":
      return `assembled command string exceeds ${String(issue.maxBytes)} byte limit`;
    case "argument-too-large":
      return `command argument ${String(issue.index)} exceeds ${String(issue.maxBytes)} byte limit`;
    case "argument-control-character":
      return `command argument ${String(issue.index)} contains null bytes`;
  }
}

function openShellEscapedArgumentByteLength(argument: string): number {
  const bytes = Buffer.from(argument, "utf8");
  if (bytes.length === 0) return 2;

  let safe = true;
  let singleQuotes = 0;
  for (const byte of bytes) {
    if (byte === 0x27) singleQuotes += 1;
    if (
      !(
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        byte === 0x2e ||
        byte === 0x2f ||
        byte === 0x2d ||
        byte === 0x5f
      )
    ) {
      safe = false;
    }
  }
  if (safe) return bytes.length;

  // OpenShell wraps unsafe arguments in single quotes and expands each
  // embedded quote from one byte to the five-byte '\"'\"' sequence.
  return bytes.length + 2 + singleQuotes * 4;
}

/** Match OpenShell v0.0.85's pre-dispatch command validation. */
export function validateOpenShellExecCommand(
  command: readonly string[],
): OpenShellExecRequestValidationError | null {
  if (command.length === 0 || command[0]?.trim().length === 0) {
    return new OpenShellExecRequestValidationError({ kind: "empty-command" });
  }
  if (command.length > OPENSHELL_V0085_MAX_EXEC_COMMAND_ARGS) {
    return new OpenShellExecRequestValidationError({
      kind: "too-many-arguments",
      actual: command.length,
      max: OPENSHELL_V0085_MAX_EXEC_COMMAND_ARGS,
    });
  }

  for (const [index, argument] of command.entries()) {
    const actualBytes = Buffer.byteLength(argument, "utf8");
    if (actualBytes > OPENSHELL_V0085_MAX_EXEC_ARGUMENT_BYTES) {
      return new OpenShellExecRequestValidationError({
        kind: "argument-too-large",
        index,
        actualBytes,
        maxBytes: OPENSHELL_V0085_MAX_EXEC_ARGUMENT_BYTES,
      });
    }
    if (argument.includes("\0")) {
      return new OpenShellExecRequestValidationError({
        kind: "argument-control-character",
        index,
        character: "nul",
      });
    }
  }

  const assembledBytes =
    command.reduce((total, argument) => total + openShellEscapedArgumentByteLength(argument), 0) +
    command.length -
    1;
  if (assembledBytes > OPENSHELL_V0085_MAX_ASSEMBLED_COMMAND_BYTES) {
    return new OpenShellExecRequestValidationError({
      kind: "assembled-command-too-large",
      actualBytes: assembledBytes,
      maxBytes: OPENSHELL_V0085_MAX_ASSEMBLED_COMMAND_BYTES,
    });
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

function createCliSandboxControl(
  capture: CaptureOpenShell,
  gatewayName?: string,
): OpenShellSandboxControl {
  return {
    async exec(request): Promise<SandboxExecResult> {
      const validationError = validateOpenShellExecCommand(request.command);
      if (validationError) return openShellExecRequestValidationFailure(validationError);

      const gatewayArgs = gatewayName ? ["--gateway", gatewayName] : [];
      const result = capture(
        [
          ...gatewayArgs,
          "sandbox",
          "exec",
          "--name",
          request.sandboxName,
          "--",
          ...request.command,
        ],
        {
          ignoreError: true,
          includeStreams: true,
          maxBuffer: request.maxOutputBytes,
          timeout: request.timeoutMs,
        },
      );
      return normalizeExecResult(result);
    },
  };
}

export function createCliOpenShellSandboxControl(
  capture: CaptureOpenShell = captureOpenshell,
): OpenShellSandboxControl {
  return createCliSandboxControl(capture);
}

/** Bind every CLI fallback invocation to the gateway selected by the caller. */
export function createGatewayScopedCliOpenShellSandboxControl(
  gatewayName: string,
  capture: CaptureOpenShell = captureOpenshell,
  env: OpenShellGatewayEndpointEnvironment = process.env,
): OpenShellSandboxControl {
  assertNoOpenShellGatewayEndpointOverride(env);
  return createCliSandboxControl(capture, gatewayName);
}

export const openShellSandboxControl = createCliOpenShellSandboxControl();
