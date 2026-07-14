// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "./client";
import { captureOpenshell } from "./runtime";

export interface SandboxExecRequest {
  sandboxName: string;
  command: readonly string[];
  /** Optional bytes supplied to the remote command's standard input. */
  stdin?: string | Buffer;
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
  | { kind: "encoded-request-too-large"; actualBytes: number; maxBytes: number }
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
const OPENSHELL_V0072_MAX_ASSEMBLED_COMMAND_BYTES = 256 * 1024;
const OPENSHELL_V0072_MAX_DECODED_GRPC_MESSAGE_BYTES = 1024 * 1024;
const OPENSHELL_V0072_SANDBOX_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

function openShellExecRequestValidationMessage(issue: OpenShellExecRequestValidationIssue): string {
  switch (issue.kind) {
    case "empty-command":
      return "command is required";
    case "too-many-arguments":
      return `command array exceeds ${String(issue.max)} argument limit`;
    case "assembled-command-too-large":
      return `assembled command string exceeds ${String(issue.maxBytes)} byte limit`;
    case "encoded-request-too-large":
      return `encoded exec request exceeds ${String(issue.maxBytes)} byte limit`;
    case "argument-too-large":
      return `command argument ${String(issue.index)} exceeds ${String(issue.maxBytes)} byte limit`;
    case "argument-control-character":
      return issue.character === "nul"
        ? `command argument ${String(issue.index)} contains null bytes`
        : `command argument ${String(issue.index)} contains newline or carriage return characters`;
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

  const assembledBytes =
    command.reduce((total, argument) => total + openShellEscapedArgumentByteLength(argument), 0) +
    command.length -
    1;
  if (assembledBytes > OPENSHELL_V0072_MAX_ASSEMBLED_COMMAND_BYTES) {
    return new OpenShellExecRequestValidationError({
      kind: "assembled-command-too-large",
      actualBytes: assembledBytes,
      maxBytes: OPENSHELL_V0072_MAX_ASSEMBLED_COMMAND_BYTES,
    });
  }

  return null;
}

function protobufVarintByteLength(value: number): number {
  let remaining = value;
  let bytes = 1;
  while (remaining >= 0x80) {
    remaining = Math.floor(remaining / 0x80);
    bytes += 1;
  }
  return bytes;
}

function protobufLengthDelimitedFieldByteLength(valueBytes: number): number {
  // Every ExecSandboxRequest field used here has a one-byte protobuf tag.
  return 1 + protobufVarintByteLength(valueBytes) + valueBytes;
}

function openShellExecRequestEncodedByteLength(
  request: SandboxExecRequest,
  sandboxId: string,
): number {
  let bytes = protobufLengthDelimitedFieldByteLength(Buffer.byteLength(sandboxId, "utf8"));
  for (const argument of request.command) {
    bytes += protobufLengthDelimitedFieldByteLength(Buffer.byteLength(argument, "utf8"));
  }
  if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
    const timeoutSeconds = Math.min(Math.ceil(request.timeoutMs / 1000), 0xffff_ffff);
    bytes += 1 + protobufVarintByteLength(timeoutSeconds);
  }
  if (request.stdin !== undefined) {
    const stdinBytes = Buffer.isBuffer(request.stdin)
      ? request.stdin.length
      : Buffer.byteLength(request.stdin, "utf8");
    bytes += protobufLengthDelimitedFieldByteLength(stdinBytes);
  }
  return bytes;
}

/** Match v0.0.72's 1 MiB decoded unary gRPC request boundary. */
export function validateOpenShellExecRequest(
  request: SandboxExecRequest,
  sandboxId: string = OPENSHELL_V0072_SANDBOX_ID_PLACEHOLDER,
): OpenShellExecRequestValidationError | null {
  const commandError = validateOpenShellExecCommand(request.command);
  if (commandError) return commandError;

  const actualBytes = openShellExecRequestEncodedByteLength(request, sandboxId);
  if (actualBytes > OPENSHELL_V0072_MAX_DECODED_GRPC_MESSAGE_BYTES) {
    return new OpenShellExecRequestValidationError({
      kind: "encoded-request-too-large",
      actualBytes,
      maxBytes: OPENSHELL_V0072_MAX_DECODED_GRPC_MESSAGE_BYTES,
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

export function createCliOpenShellSandboxControl(
  capture: CaptureOpenShell = captureOpenshell,
): OpenShellSandboxControl {
  return {
    async exec(request): Promise<SandboxExecResult> {
      // v0.0.72 creates UUID sandbox ids. Reserve that exact encoded width
      // before invoking the CLI, which resolves the name to the id internally.
      const validationError = validateOpenShellExecRequest(request);
      if (validationError) return openShellExecRequestValidationFailure(validationError);

      const result = capture(
        ["sandbox", "exec", "--name", request.sandboxName, "--", ...request.command],
        {
          ignoreError: true,
          includeStreams: true,
          input: request.stdin,
          maxBuffer: request.maxOutputBytes,
          timeout: request.timeoutMs,
        },
      );
      return normalizeExecResult(result);
    },
  };
}

export const openShellSandboxControl = createCliOpenShellSandboxControl();
