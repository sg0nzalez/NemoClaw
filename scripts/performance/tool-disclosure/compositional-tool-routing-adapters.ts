// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";

import type { DecompositionPass, TaskDecomposer, TextEmbedder } from "./compositional-tool-router";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 256;
const DEFAULT_EMBEDDING_BATCH_SIZE = 128;
const DEFAULT_HASH_DIMENSIONS = 1_024;
const MAX_TEXT_CHARS = 32_768;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface JsonRecord {
  [key: string]: unknown;
}

export interface ModelUsageEvent {
  operation: "decomposition" | "embedding";
  pass?: DecompositionPass;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_ms: number;
}

interface OpenAIAdapterOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Required for non-loopback HTTPS endpoints because prompts leave the host. */
  allowRemote?: boolean;
  timeoutMs?: number;
  onUsage?: (event: ModelUsageEvent) => void;
}

export interface OpenAIChatDecomposerOptions extends OpenAIAdapterOptions {
  maxOutputTokens?: number;
  /** Endpoint-specific chat-template switch for concise output. */
  reasoningControl?: "enable_thinking_false" | "thinking_false";
  /** Request the OpenAI-compatible JSON-object response mode. */
  jsonObjectResponse?: boolean;
}

export interface OpenAITextEmbedderOptions extends OpenAIAdapterOptions {
  batchSize?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function endpoint(
  baseUrl: string,
  leaf: "chat/completions" | "embeddings",
  allowRemote: boolean,
): string {
  const value = new URL(baseUrl);
  if (value.protocol !== "http:" && value.protocol !== "https:") {
    throw new TypeError("model adapter baseUrl must use HTTP or HTTPS");
  }
  if (value.username || value.password || value.search || value.hash) {
    throw new TypeError("model adapter baseUrl must not contain credentials, query, or fragment");
  }
  const hostname = value.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const loopback =
    hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (!loopback && value.protocol !== "https:") {
    throw new TypeError("remote model adapter endpoints must use HTTPS");
  }
  if (!loopback && !allowRemote) {
    throw new TypeError("remote model adapter endpoints require allowRemote");
  }
  const path = value.pathname.replace(/\/+$/u, "");
  value.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/${leaf}`.replace(/\/{2,}/gu, "/");
  return value.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("model adapter response is too large");
  }
  if (!response.body) return JSON.parse(await response.text()) as unknown;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("model adapter response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function requestHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function boundedSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function usageFrom(
  value: unknown,
): Pick<ModelUsageEvent, "prompt_tokens" | "completion_tokens" | "total_tokens"> {
  if (!isRecord(value)) return {};
  const result: Pick<ModelUsageEvent, "prompt_tokens" | "completion_tokens" | "total_tokens"> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const item = value[key];
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) result[key] = item;
  }
  return result;
}

function reportUsage(callback: OpenAIAdapterOptions["onUsage"], event: ModelUsageEvent): void {
  try {
    callback?.(event);
  } catch {
    // Measurement callbacks must not change routing behavior.
  }
}

function boundedText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT_CHARS) {
    throw new TypeError(`${label} must contain 1-${MAX_TEXT_CHARS} characters`);
  }
  return normalized;
}

function decompositionMessages(
  query: string,
  pass: DecompositionPass,
  hints: readonly string[],
  jsonObjectResponse: boolean,
): Array<{ role: "system" | "user"; content: string }> {
  const system = [
    jsonObjectResponse
      ? 'Return only a JSON object with one field named "subtasks", whose value is an array of strings.'
      : "Return only a JSON array of strings.",
    "Split the request into a short ordered list of concrete actions.",
    "Each action must be solvable with one external capability.",
    "Return an empty array when the request needs no external capability.",
  ].join(" ");
  const user =
    pass === "initial"
      ? `Identify the atomic actions in this request:\n${query}`
      : [
          "Reconsider the action boundaries using these capability names as vocabulary hints:",
          hints.join(", "),
          "Request:",
          query,
        ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function jsonPayloadText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstNewline = trimmed.indexOf("\n");
  const lastFence = trimmed.lastIndexOf("```");
  if (firstNewline < 0 || lastFence <= firstNewline) return trimmed;
  return trimmed.slice(firstNewline + 1, lastFence).trim();
}

function parseDecompositionResponse(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new Error("decomposition response has an unsupported shape");
  }
  const first = value.choices[0];
  const content = isRecord(first) && isRecord(first.message) ? first.message.content : null;
  if (typeof content !== "string") {
    throw new Error("decomposition response has no text content");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayloadText(content));
  } catch {
    throw new Error("decomposition response contains invalid JSON");
  }
  return isRecord(parsed) && Array.isArray(parsed.subtasks) ? parsed.subtasks : parsed;
}

/** Build the two-pass decomposer using any OpenAI-compatible chat endpoint. */
export function createOpenAIChatTaskDecomposer(
  options: OpenAIChatDecomposerOptions,
): TaskDecomposer {
  if (
    options.reasoningControl !== undefined &&
    options.reasoningControl !== "enable_thinking_false" &&
    options.reasoningControl !== "thinking_false"
  ) {
    throw new TypeError("reasoningControl is not supported");
  }
  if (options.jsonObjectResponse !== undefined && typeof options.jsonObjectResponse !== "boolean") {
    throw new TypeError("jsonObjectResponse must be boolean");
  }
  const target = endpoint(options.baseUrl, "chat/completions", options.allowRemote === true);
  const model = boundedText(options.model, "decomposition model");
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxOutputTokens = positiveInteger(
    options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    "maxOutputTokens",
  );
  return {
    decompose: async (request) => {
      const query = boundedText(request.query, "decomposition query");
      const startedAt = performance.now();
      let body: unknown;
      try {
        const response = await fetch(target, {
          method: "POST",
          headers: requestHeaders(options.apiKey),
          body: JSON.stringify({
            model,
            messages: decompositionMessages(
              query,
              request.pass,
              request.tool_hints,
              options.jsonObjectResponse === true,
            ),
            temperature: 0,
            max_tokens: maxOutputTokens,
            stream: false,
            ...(options.reasoningControl === "enable_thinking_false"
              ? { chat_template_kwargs: { enable_thinking: false } }
              : options.reasoningControl === "thinking_false"
                ? { chat_template_kwargs: { thinking: false } }
                : {}),
            ...(options.jsonObjectResponse ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: boundedSignal(timeoutMs, request.signal),
        });
        if (!response.ok) throw new Error("decomposition request failed");
        body = await readBoundedJson(response);
      } catch {
        throw new Error("decomposition request failed");
      } finally {
        // Never include prompts, endpoints, model IDs, keys, or response text.
        const usage = isRecord(body) ? usageFrom(body.usage) : {};
        reportUsage(options.onUsage, {
          operation: "decomposition",
          pass: request.pass,
          ...usage,
          duration_ms: performance.now() - startedAt,
        });
      }
      return parseDecompositionResponse(body);
    },
  };
}

function parseEmbeddingResponse(value: unknown, expected: number): number[][] {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== expected) {
    throw new Error("embedding response has an unsupported shape");
  }
  const ordered = [...value.data].sort((left, right) => {
    const leftIndex = isRecord(left) && typeof left.index === "number" ? left.index : -1;
    const rightIndex = isRecord(right) && typeof right.index === "number" ? right.index : -1;
    return leftIndex - rightIndex;
  });
  return ordered.map((item, expectedIndex) => {
    if (!isRecord(item) || item.index !== expectedIndex || !Array.isArray(item.embedding)) {
      throw new Error("embedding response has an unsupported shape");
    }
    const vector = item.embedding;
    if (
      vector.length === 0 ||
      vector.some((number) => typeof number !== "number" || !Number.isFinite(number))
    ) {
      throw new Error("embedding response has an invalid vector");
    }
    return vector as number[];
  });
}

/** Build a dense embedder using an OpenAI-compatible embeddings endpoint. */
export function createOpenAITextEmbedder(options: OpenAITextEmbedderOptions): TextEmbedder {
  const target = endpoint(options.baseUrl, "embeddings", options.allowRemote === true);
  const model = boundedText(options.model, "embedding model");
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE, "batchSize");
  return {
    embed: async (texts, signal) => {
      const output: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const input = texts
          .slice(start, start + batchSize)
          .map((text) => boundedText(text, "embedding input"));
        const startedAt = performance.now();
        let body: unknown;
        try {
          const response = await fetch(target, {
            method: "POST",
            headers: requestHeaders(options.apiKey),
            body: JSON.stringify({ model, input }),
            signal: boundedSignal(timeoutMs, signal),
          });
          if (!response.ok) throw new Error("embedding request failed");
          body = await readBoundedJson(response);
          output.push(...parseEmbeddingResponse(body, input.length));
        } catch {
          throw new Error("embedding request failed");
        } finally {
          const usage = isRecord(body) ? usageFrom(body.usage) : {};
          reportUsage(options.onUsage, {
            operation: "embedding",
            ...usage,
            duration_ms: performance.now() - startedAt,
          });
        }
      }
      return output;
    },
  };
}

function fnv1a(text: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
}

function lexicalFeatures(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const features = [...words];
  for (let index = 0; index + 1 < words.length; index += 1) {
    features.push(`${words[index]}_${words[index + 1]}`);
  }
  for (const word of words) {
    if (word.length < 4) continue;
    for (let index = 0; index + 2 < word.length; index += 1) {
      features.push(`#${word.slice(index, index + 3)}`);
    }
  }
  return features;
}

/**
 * Dependency-free lexical hashing for unit tests and portable smoke runs.
 * This adapter is not a semantic model. Measured runs should use
 * `createOpenAITextEmbedder` with a recorded model and immutable revision.
 */
export class PortableHashingTextEmbedder implements TextEmbedder {
  readonly dimensions: number;

  constructor(dimensions = DEFAULT_HASH_DIMENSIONS) {
    this.dimensions = positiveInteger(dimensions, "dimensions");
  }

  async embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (signal?.aborted) throw new DOMException("embedding aborted", "AbortError");
    return texts.map((text) => {
      const counts = new Map<string, number>();
      for (const feature of lexicalFeatures(text)) {
        counts.set(feature, (counts.get(feature) ?? 0) + 1);
      }
      const vector = Array.from<number>({ length: this.dimensions }).fill(0);
      for (const [feature, count] of counts) {
        const hash = fnv1a(feature);
        const index = hash % this.dimensions;
        const sign = (hash & 0x80_00_00_00) === 0 ? 1 : -1;
        vector[index] += sign * (1 + Math.log(count));
      }
      // Empty strings are rejected by callers; keep a defined vector for text
      // made only of punctuation so the router can fail safely during L2 normalization.
      return vector;
    });
  }
}
