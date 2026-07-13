// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshellCommandBinary } from "./client";
import { resolveOpenshell } from "./resolve";

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

type CaptureOpenShellBinary = typeof captureOpenshellCommandBinary;

export interface CliOpenShellSandboxControlDependencies {
  captureBinary: CaptureOpenShellBinary;
  resolveBinary: typeof resolveOpenshell;
}

const defaultCliDependencies: CliOpenShellSandboxControlDependencies = {
  captureBinary: captureOpenshellCommandBinary,
  resolveBinary: resolveOpenshell,
};

export function createCliOpenShellSandboxControl(
  dependencies: CliOpenShellSandboxControlDependencies = defaultCliDependencies,
): OpenShellSandboxControl {
  return {
    async exec(request): Promise<SandboxExecResult> {
      const binary = dependencies.resolveBinary();
      if (!binary) {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: new Error("openshell CLI not found"),
        };
      }
      const result = dependencies.captureBinary(
        binary,
        ["sandbox", "exec", "--name", request.sandboxName, "--", ...request.command],
        {
          input: request.stdin,
          maxBuffer: request.maxOutputBytes,
          timeout: request.timeoutMs,
        },
      );
      const binaryStdout = request.stdoutEncoding === "buffer";
      return {
        status: result.status,
        stdout: binaryStdout ? "" : result.stdout.toString("utf8"),
        ...(binaryStdout ? { stdoutBytes: result.stdout } : {}),
        stderr: result.stderr.toString("utf8"),
        ...(result.error ? { error: result.error } : {}),
        ...(result.signal !== undefined ? { signal: result.signal } : {}),
      };
    },
  };
}
