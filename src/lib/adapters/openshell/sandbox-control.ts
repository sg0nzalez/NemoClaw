// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "./client";
import { captureOpenshell, captureOpenshellBinary } from "./runtime";

export interface SandboxExecRequest {
  sandboxName: string;
  command: readonly string[];
  /** Optional bytes supplied to the remote command's standard input. */
  stdin?: string | Buffer;
  /** Maximum combined stdout and stderr bytes retained by the transport. */
  maxOutputBytes?: number;
  /** End-to-end lookup and execution deadline. Zero means no deadline. */
  timeoutMs?: number;
  /** Preserve stdout bytes instead of decoding them as UTF-8. */
  stdoutEncoding?: "utf8" | "buffer";
}

export interface SandboxExecResult {
  status: number | null;
  stdout: string;
  /** Present when stdoutEncoding is `buffer`; stdout remains an empty string. */
  stdoutBytes?: Buffer;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

export interface OpenShellSandboxControl {
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
}

type CaptureOpenShell = typeof captureOpenshell;
type CaptureOpenShellBinary = typeof captureOpenshellBinary;

export interface CliOpenShellSandboxControlDependencies {
  captureBinary: CaptureOpenShellBinary;
}

const defaultCliDependencies: CliOpenShellSandboxControlDependencies = {
  captureBinary: captureOpenshellBinary,
};

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
  dependencies: CliOpenShellSandboxControlDependencies = defaultCliDependencies,
): OpenShellSandboxControl {
  return {
    async exec(request): Promise<SandboxExecResult> {
      if (request.stdoutEncoding === "buffer") {
        const result = dependencies.captureBinary(
          ["sandbox", "exec", "--name", request.sandboxName, "--", ...request.command],
          {
            input: request.stdin,
            maxBuffer: request.maxOutputBytes,
            timeout: request.timeoutMs,
          },
        );
        return {
          status: result.status,
          stdout: "",
          stdoutBytes: result.stdout,
          stderr: result.stderr.toString("utf8"),
          ...(result.error ? { error: result.error } : {}),
          ...(result.signal !== undefined ? { signal: result.signal } : {}),
        };
      }
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
