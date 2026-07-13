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

type CaptureOpenShell = typeof captureOpenshell;

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
