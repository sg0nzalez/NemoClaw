// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface SubprocessResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  elapsed_ms: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  output_truncated: boolean;
}

function scrub(text: string, redactions: readonly string[]): string {
  let result = text;
  for (const value of redactions) {
    if (value) result = result.replaceAll(value, "<REDACTED>");
  }
  return result;
}

export async function runBoundedCommand(options: {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  redactions?: readonly string[];
}): Promise<SubprocessResult> {
  if (!options.command || options.command.includes("\0"))
    throw new Error("invalid performance test command");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("performance test command timeout must be a positive integer");
  }
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startedAt = performance.now();
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let truncated = false;
  const append = (
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
  ): Buffer<ArrayBufferLike> => {
    if (current.length >= maxOutputBytes) {
      truncated = true;
      return current;
    }
    const remaining = maxOutputBytes - current.length;
    if (chunk.length > remaining) truncated = true;
    return Buffer.concat([current, chunk.subarray(0, remaining)]);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });

  let timedOut = false;
  let hardStop: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // Process already exited.
    }
    hardStop = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
    }, 5_000);
    hardStop.unref();
  }, options.timeoutMs);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => {
    clearTimeout(timer);
    if (hardStop) clearTimeout(hardStop);
  });
  const redactions = options.redactions ?? [];
  return {
    exit_code: result.code,
    signal: result.signal,
    elapsed_ms: Number((performance.now() - startedAt).toFixed(3)),
    stdout: scrub(stdout.toString("utf8"), redactions),
    stderr: scrub(stderr.toString("utf8"), redactions),
    timed_out: timedOut,
    output_truncated: truncated,
  };
}
