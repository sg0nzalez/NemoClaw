// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isErrnoException } from "../../core/errno";
import { compactText } from "../../core/url-utils";
import type { ProbeResult } from "../../onboard/types";
import { startSpan } from "../../profiling";
import { ROOT } from "../../state/paths";

export type CurlProbeResult = ProbeResult;

export interface CurlProbeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  replaceEnv?: boolean;
  timeoutMs?: number;
  spawnSyncImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
}

export interface StreamingProbeResult {
  ok: boolean;
  missingEvents: string[];
  message: string;
}

function validateTempPrefix(prefix: string): string {
  if (
    prefix.length === 0 ||
    prefix !== path.basename(prefix) ||
    prefix.includes(path.posix.sep) ||
    prefix.includes(path.win32.sep)
  ) {
    throw new Error(`Invalid temp file prefix: ${prefix}`);
  }
  return prefix;
}

function secureTempFile(prefix: string, ext = ""): string {
  const safePrefix = validateTempPrefix(prefix);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${safePrefix}-`));
  return path.join(dir, `${safePrefix}${ext}`);
}

function cleanupTempDir(filePath: string, expectedPrefix: string): void {
  const safePrefix = validateTempPrefix(expectedPrefix);
  const tempRoot = path.resolve(os.tmpdir());
  const parentDir = path.resolve(path.dirname(filePath));
  const relativeParent = path.relative(tempRoot, parentDir);
  const isInsideTempRoot =
    relativeParent !== "" && !relativeParent.startsWith("..") && !path.isAbsolute(relativeParent);
  if (isInsideTempRoot && path.basename(parentDir).startsWith(`${safePrefix}-`)) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
}

export function getCurlTimingArgs(): string[] {
  return ["--connect-timeout", "10", "--max-time", "60"];
}

function getCurlSpanArgs(argv: string[], opts: CurlProbeOptions = {}): Record<string, unknown> {
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

export function summarizeCurlFailure(curlStatus = 0, stderr = "", body = ""): string {
  const detail = compactText(stderr || body);
  return detail
    ? `curl failed (exit ${curlStatus}): ${detail.slice(0, 200)}`
    : `curl failed (exit ${curlStatus})`;
}

type ProbeErrorDetail =
  | string
  | number
  | boolean
  | null
  | { [key: string]: string | number | boolean | null }
  | Array<string | number | boolean | null>;

type ProbeErrorBody = {
  error?: { message?: ProbeErrorDetail; details?: ProbeErrorDetail };
  message?: ProbeErrorDetail;
  detail?: ProbeErrorDetail;
  details?: ProbeErrorDetail;
};

function formatProbeErrorDetail(detail: ProbeErrorDetail): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (typeof detail === "number" || typeof detail === "boolean" || detail === null) {
    return String(detail);
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return "[unserializable detail]";
  }
}

export function summarizeProbeError(body = "", status = 0): string {
  if (!body) return `HTTP ${status} with no response body`;
  try {
    const parsed: ProbeErrorBody = JSON.parse(body);
    const message =
      parsed?.error?.message ||
      parsed?.error?.details ||
      parsed?.message ||
      parsed?.detail ||
      parsed?.details;
    if (message !== undefined) return `HTTP ${status}: ${formatProbeErrorDetail(message)}`;
  } catch {
    /* non-JSON body — fall through to raw text */
  }
  const compact = String(body).replace(/\s+/g, " ").trim();
  return `HTTP ${status}: ${compact.slice(0, 200)}`;
}

export function summarizeProbeFailure(body = "", status = 0, curlStatus = 0, stderr = ""): string {
  if (curlStatus) {
    return summarizeCurlFailure(curlStatus, stderr, body);
  }
  return summarizeProbeError(body, status);
}

export function runCurlProbe(argv: string[], opts: CurlProbeOptions = {}): CurlProbeResult {
  const bodyFile = secureTempFile("nemoclaw-curl-probe", ".json");
  const span = startSpan("http_probe.curl", getCurlSpanArgs(argv, opts));
  try {
    const args = [...argv];
    const url = args.pop();
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const result = spawnSyncImpl(
      "curl",
      [...args, "-o", bodyFile, "-w", "%{http_code}", String(url || "")],
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout: opts.timeoutMs ?? 30_000,
        env: opts.replaceEnv ? (opts.env ?? {}) : { ...process.env, ...opts.env },
      },
    );
    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    if (result.error) {
      const rawErrorCode = isErrnoException(result.error)
        ? (result.error.errno ?? result.error.code)
        : undefined;
      const errorCode = typeof rawErrorCode === "number" ? rawErrorCode : 1;
      const errorMessage = compactText(
        `${result.error.message || String(result.error)} ${String(result.stderr || "")}`,
      );
      const failure = {
        ok: false,
        httpStatus: 0,
        curlStatus: errorCode,
        body,
        stderr: errorMessage,
        message: summarizeProbeFailure(body, 0, errorCode, errorMessage),
      };
      span.end({ ok: false, httpStatus: 0, curlStatus: errorCode });
      return failure;
    }
    const status = Number(String(result.stdout || "").trim());
    const probeResult = {
      ok: result.status === 0 && status >= 200 && status < 300,
      httpStatus: Number.isFinite(status) ? status : 0,
      curlStatus: result.status || 0,
      body,
      stderr: String(result.stderr || ""),
      message: summarizeProbeFailure(
        body,
        status || 0,
        result.status || 0,
        String(result.stderr || ""),
      ),
    };
    span.end({
      ok: probeResult.ok,
      httpStatus: probeResult.httpStatus,
      curlStatus: probeResult.curlStatus,
    });
    return probeResult;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const curlStatus =
      typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1;
    span.end({ ok: false, httpStatus: 0, curlStatus, error: detail });
    return {
      ok: false,
      httpStatus: 0,
      curlStatus,
      body: "",
      stderr: detail,
      message: summarizeCurlFailure(curlStatus, detail),
    };
  } finally {
    cleanupTempDir(bodyFile, "nemoclaw-curl-probe");
  }
}

function hasChatCompletionsStreamingData(body: string): boolean {
  let seenChoices = false;
  for (const line of body.split("\n")) {
    const match = /^data:\s*(.+)$/i.exec(line.trim());
    if (!match) continue;
    const data = match[1].trim();
    if (data === "[DONE]") return seenChoices;
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) {
        seenChoices = true;
      }
    } catch {
      /* Ignore malformed SSE data lines and keep scanning. */
    }
  }
  return seenChoices;
}

export function runChatCompletionsStreamingProbe(
  argv: string[],
  opts: CurlProbeOptions = {},
): CurlProbeResult {
  const bodyFile = secureTempFile("nemoclaw-chat-streaming-probe", ".sse");
  const span = startSpan("http_probe.curl", {
    ...getCurlSpanArgs(argv, opts),
    streaming: true,
    api: "chat-completions",
  });
  try {
    const args = [...argv];
    const url = args.pop();
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const result = spawnSyncImpl(
      "curl",
      [...args, "-N", "-o", bodyFile, "-w", "%{http_code}", String(url || "")],
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout: opts.timeoutMs ?? 30_000,
        env: {
          ...process.env,
          ...opts.env,
        },
      },
    );

    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    if (result.error) {
      const rawErrorCode = isErrnoException(result.error)
        ? (result.error.errno ?? result.error.code)
        : undefined;
      const errorCode = typeof rawErrorCode === "number" ? rawErrorCode : 1;
      const errorMessage = compactText(
        `${result.error.message || String(result.error)} ${String(result.stderr || "")}`,
      );
      const failure = {
        ok: false,
        httpStatus: 0,
        curlStatus: errorCode,
        body,
        stderr: errorMessage,
        message: summarizeProbeFailure(body, 0, errorCode, errorMessage),
      };
      span.end({ ok: false, httpStatus: 0, curlStatus: errorCode });
      return failure;
    }

    const status = Number(String(result.stdout || "").trim());
    const curlStatus = result.status || 0;
    const hasStreamingData = hasChatCompletionsStreamingData(body);
    const httpOk = Number.isFinite(status) && status >= 200 && status < 300;
    if (httpOk && hasStreamingData && (curlStatus === 0 || curlStatus === 28)) {
      const success = {
        ok: true,
        httpStatus: status,
        curlStatus,
        body,
        stderr: String(result.stderr || ""),
        message: `HTTP ${status}: chat completions stream returned SSE data`,
      };
      span.end({ ok: true, httpStatus: status, curlStatus });
      return success;
    }

    const message =
      httpOk && !hasStreamingData
        ? `HTTP ${status}: chat completions stream did not return SSE data`
        : summarizeProbeFailure(body, status || 0, curlStatus, String(result.stderr || ""));
    const failure = {
      ok: false,
      httpStatus: Number.isFinite(status) ? status : 0,
      curlStatus,
      body,
      stderr: String(result.stderr || ""),
      message,
    };
    span.end({ ok: false, httpStatus: failure.httpStatus, curlStatus });
    return failure;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const curlStatus =
      typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1;
    span.end({ ok: false, httpStatus: 0, curlStatus, error: detail });
    return {
      ok: false,
      httpStatus: 0,
      curlStatus,
      body: "",
      stderr: detail,
      message: summarizeCurlFailure(curlStatus, detail),
    };
  } finally {
    cleanupTempDir(bodyFile, "nemoclaw-chat-streaming-probe");
  }
}

/**
 * The minimum set of streaming events that OpenClaw requires from a
 * `/v1/responses` endpoint. Backends that only emit the top-level lifecycle
 * events (created / in_progress / completed) will cause runtime failures
 * because OpenClaw never receives the incremental content deltas.
 */
const REQUIRED_STREAMING_EVENTS = ["response.output_text.delta"];

/**
 * Send a streaming request to a `/v1/responses`-style endpoint and verify
 * that the SSE event stream includes the granular events OpenClaw needs.
 *
 * This catches backends like SGLang that return valid non-streaming
 * responses but emit only `response.created`, `response.in_progress`, and
 * `response.completed` in streaming mode — missing the content deltas that
 * OpenClaw relies on.
 */
export function runStreamingEventProbe(
  argv: string[],
  opts: CurlProbeOptions = {},
): StreamingProbeResult {
  const bodyFile = secureTempFile("nemoclaw-streaming-probe", ".sse");
  const span = startSpan("http_probe.curl", {
    ...getCurlSpanArgs(argv, opts),
    streaming: true,
    api: "responses",
  });
  try {
    const args = [...argv];
    const url = args.pop();
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const result = spawnSyncImpl("curl", [...args, "-N", "-o", bodyFile, String(url || "")], {
      cwd: opts.cwd ?? ROOT,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 30_000,
      env: {
        ...process.env,
        ...opts.env,
      },
    });

    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";

    if (result.error || (result.status !== null && result.status !== 0 && result.status !== 28)) {
      // curl exit 28 = timeout, which is expected — we cap with --max-time
      // and may still have collected enough events before the timeout.
      const detail = result.error
        ? String(result.error.message || result.error)
        : String(result.stderr || "");
      const failure = {
        ok: false,
        missingEvents: REQUIRED_STREAMING_EVENTS,
        message: `Streaming probe failed: ${compactText(detail).slice(0, 200)}`,
      };
      span.end({ ok: false, missingEvents: REQUIRED_STREAMING_EVENTS.length });
      return failure;
    }

    // Parse SSE event types from the raw output.
    // Each event line looks like: "event: response.output_text.delta"
    const eventTypes = new Set<string>();
    for (const line of body.split("\n")) {
      const match = /^event:\s*(.+)$/i.exec(line.trim());
      if (match) {
        eventTypes.add(match[1].trim());
      }
    }

    const missing = REQUIRED_STREAMING_EVENTS.filter((e) => !eventTypes.has(e));
    if (missing.length > 0) {
      const failure = {
        ok: false,
        missingEvents: missing,
        message:
          `Responses API streaming is missing required events: ${missing.join(", ")}. ` +
          "Falling back to chat completions API.",
      };
      span.end({ ok: false, missingEvents: missing.length });
      return failure;
    }

    span.end({ ok: true, missingEvents: 0 });
    return { ok: true, missingEvents: [], message: "" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    span.end({ ok: false, missingEvents: REQUIRED_STREAMING_EVENTS.length, error: detail });
    return {
      ok: false,
      missingEvents: REQUIRED_STREAMING_EVENTS,
      message: `Streaming probe error: ${detail}`,
    };
  } finally {
    cleanupTempDir(bodyFile, "nemoclaw-streaming-probe");
  }
}
