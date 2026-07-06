// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

const METRIC_NAMES = {
  prompt: ["vllm:prompt_tokens_total", "vllm_prompt_tokens_total"],
  generation: ["vllm:generation_tokens_total", "vllm_generation_tokens_total"],
} as const;

export interface VllmTokenSnapshot {
  prompt_tokens: number;
  generation_tokens: number;
}

export interface VllmTokenDelta extends VllmTokenSnapshot {
  available: boolean;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

export function validatedTelemetryUrl(raw: string, endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("vLLM telemetry URL must be a valid HTTP(S) URL");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("vLLM telemetry URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("vLLM telemetry URL must not contain credentials");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("plaintext vLLM telemetry is allowed only on loopback");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = endpoint;
  return url;
}

function metricFamilyValue(text: string, names: readonly string[]): number | undefined {
  let total = 0;
  let found = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.lastIndexOf(" ");
    if (separator < 1) continue;
    const identity = line.slice(0, separator);
    const name = identity.replace(/\{.*$/u, "");
    if (!names.includes(name)) continue;
    const value = Number(line.slice(separator + 1));
    if (!Number.isFinite(value) || value < 0) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

export function parseVllmTokenMetrics(text: string): VllmTokenSnapshot | null {
  const prompt = metricFamilyValue(text, METRIC_NAMES.prompt);
  const generation = metricFamilyValue(text, METRIC_NAMES.generation);
  if (prompt === undefined || generation === undefined) return null;
  return { prompt_tokens: prompt, generation_tokens: generation };
}

export function parseProcessStartTime(text: string): number | null {
  return metricFamilyValue(text, ["process_start_time_seconds"]) ?? null;
}

export async function readVllmProcessStartTime(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<number> {
  const response = await fetchImpl(validatedTelemetryUrl(baseUrl, "/metrics"), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`vLLM metrics request failed with HTTP ${response.status}`);
  }
  const started = parseProcessStartTime(await response.text());
  if (started === null) throw new Error("vLLM metrics did not expose process_start_time_seconds");
  return started;
}

export async function readVllmTokenSnapshot(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<VllmTokenSnapshot | null> {
  const response = await fetchImpl(validatedTelemetryUrl(baseUrl, "/metrics"), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  return parseVllmTokenMetrics(await response.text());
}

export function tokenDelta(
  before: VllmTokenSnapshot | null,
  after: VllmTokenSnapshot | null,
): VllmTokenDelta {
  if (!before || !after) return { prompt_tokens: 0, generation_tokens: 0, available: false };
  const prompt = after.prompt_tokens - before.prompt_tokens;
  const generation = after.generation_tokens - before.generation_tokens;
  if (prompt < 0 || generation < 0) {
    return { prompt_tokens: 0, generation_tokens: 0, available: false };
  }
  return { prompt_tokens: prompt, generation_tokens: generation, available: true };
}

function tokenCountFromResponse(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["count", "token_count", "num_tokens"]) {
    const value = record[key];
    if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  }
  const tokens = record.tokens;
  return Array.isArray(tokens) ? tokens.length : null;
}

export async function countTokensWithVllm(
  baseUrl: string,
  model: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<number> {
  if (!model.trim()) throw new Error("tokenizer model must not be empty");
  const response = await fetchImpl(validatedTelemetryUrl(baseUrl, "/tokenize"), {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`vLLM tokenizer request failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  const count = tokenCountFromResponse(payload);
  if (count === null) throw new Error("vLLM tokenizer response did not contain a token count");
  return count;
}
