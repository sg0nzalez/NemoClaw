// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { startSpan, type TraceArgs } from "../../profiling";

export interface HttpProbeSpanOptions {
  timeoutMs?: number;
}

export function withHttpProbeSpan<T extends { ok: boolean; httpStatus: number; curlStatus: number }>(
  argv: string[],
  opts: HttpProbeSpanOptions,
  fn: () => T,
  args: TraceArgs = {},
): T {
  const span = startHttpProbeSpan(argv, opts, args);
  try {
    const result = fn();
    span.end({ ok: result.ok, httpStatus: result.httpStatus, curlStatus: result.curlStatus });
    return result;
  } catch (error) {
    span.end({ ok: false, httpStatus: 0, curlStatus: 1, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export function withStreamingEventProbeSpan<T extends { ok: boolean; missingEvents: unknown[] }>(
  argv: string[],
  opts: HttpProbeSpanOptions,
  fn: () => T,
  args: TraceArgs = {},
): T {
  const span = startHttpProbeSpan(argv, opts, args);
  try {
    const result = fn();
    span.end({ ok: result.ok, missingEvents: result.missingEvents.length });
    return result;
  } catch (error) {
    span.end({ ok: false, missingEvents: 0, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function startHttpProbeSpan(argv: string[], opts: HttpProbeSpanOptions = {}, args: TraceArgs = {}) {
  return startSpan("http_probe.curl", {
    ...getCurlSpanArgs(argv, opts),
    ...args,
  });
}

function getCurlSpanArgs(
  argv: string[],
  opts: HttpProbeSpanOptions = {},
): Record<string, unknown> {
  const url = argv[argv.length - 1];
  let endpointHost: string | undefined;
  try {
    endpointHost = new URL(String(url)).hostname;
  } catch {
    endpointHost = undefined;
  }
  return {
    endpointHost,
    timeoutMs: opts.timeoutMs ?? 30_000,
  };
}
