// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  buildDenseToolIndex,
  type CompositionalRouterOptions,
  type CompositionalRoutingEvidence,
  type DenseToolIndex,
  routeCompositionalTools,
  type ToolRoutingCatalogEntry,
} from "./compositional-tool-router";
import type {
  RecorderEndpoint,
  RecorderMethod,
  RecordingProxyRequestTransform,
  RecordingProxyTransformInput,
} from "./recorder";

const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

interface JsonRecord {
  [key: string]: unknown;
}

interface ParsedTool {
  name: string;
  description: string;
  definition: unknown;
  routable: boolean;
}

interface CachedRoute {
  selectedNames: ReadonlySet<string>;
  evidence: CompositionalTransformEvidence;
}

export interface CompositionalTransformEvidence {
  run_id: string;
  source_tool_count: number;
  routable_tool_count: number;
  preserved_tool_count: number;
  forwarded_tool_count: number;
  cache_hits: number;
  index_cache_hit: boolean;
  transform_bypass: "tool-choice-conflict" | null;
  routing: CompositionalRoutingEvidence;
}

export interface CompositionalToolRoutingTransformOptions extends CompositionalRouterOptions {
  /**
   * Explicitly identify the reviewed catalog under test while retaining every
   * framework, provider-native, and core tool.
   */
  isRoutableTool: (name: string) => boolean;
  /** Make unsupported/bypassed requests fail instead of silently acting as direct mode. */
  requireRouting?: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedTool(
  definition: unknown,
  isRoutableTool: (name: string) => boolean,
): ParsedTool | null {
  if (!isRecord(definition) || definition.type !== "function") return null;
  const nested = isRecord(definition.function) ? definition.function : null;
  if (!nested) return null;
  const rawName = nested.name;
  const rawDescription = nested.description ?? "";
  if (
    typeof rawName !== "string" ||
    !SAFE_TOOL_NAME.test(rawName) ||
    typeof rawDescription !== "string"
  ) {
    return null;
  }
  return {
    name: rawName,
    description: rawDescription,
    definition,
    routable: isRoutableTool(rawName),
  };
}

function textContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part) => {
    if (!isRecord(part)) return [];
    const text = part.text;
    return typeof text === "string" && text.trim() ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractChatQuery(payload: JsonRecord): string | null {
  if (!Array.isArray(payload.messages)) return null;
  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    const message = payload.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const content = textContent(message.content);
    if (content) return content;
  }
  return null;
}

function catalogFingerprint(tools: readonly ParsedTool[]): string {
  const hash = createHash("sha256");
  for (const tool of tools) {
    hash.update(tool.name, "utf8");
    hash.update("\0", "utf8");
    hash.update(tool.description, "utf8");
    hash.update("\0", "utf8");
    hash.update(tool.routable ? "route" : "preserve", "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function queryFingerprint(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

function namedToolChoice(payload: JsonRecord): string | null {
  if (!isRecord(payload.tool_choice) || !isRecord(payload.tool_choice.function)) return null;
  const name = payload.tool_choice.function.name;
  return typeof name === "string" ? name : null;
}

function cloneEvidence(value: CompositionalTransformEvidence): CompositionalTransformEvidence {
  return structuredClone(value);
}

function abortError(): DOMException {
  return new DOMException("routing aborted", "AbortError");
}

/**
 * Let each request stop waiting independently without cancelling shared index
 * or route work that another live request may still need.
 */
function awaitWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Connect the pure refined router to the recording proxy without changing
 * an agent's executor registry. Only the forwarded model request is filtered.
 */
export class CompositionalToolRoutingTransform {
  readonly requestTransform: RecordingProxyRequestTransform;

  private readonly isRoutableTool: (name: string) => boolean;
  private readonly routes = new Map<string, Promise<CachedRoute>>();
  private readonly routeKeysByRun = new Map<string, Set<string>>();
  private readonly indexes = new Map<string, Promise<DenseToolIndex>>();

  constructor(private readonly options: CompositionalToolRoutingTransformOptions) {
    if (typeof options.isRoutableTool !== "function") {
      throw new TypeError("compositional routing requires an explicit isRoutableTool predicate");
    }
    this.isRoutableTool = options.isRoutableTool;
    this.requestTransform = (input) => this.transform(input);
  }

  async consumeEvidence(runId: string): Promise<readonly CompositionalTransformEvidence[]> {
    const keys = this.routeKeysByRun.get(runId);
    if (!keys) return [];
    this.routeKeysByRun.delete(runId);
    const evidence: CompositionalTransformEvidence[] = [];
    for (const key of keys) {
      const pending = this.routes.get(key);
      this.routes.delete(key);
      if (!pending) continue;
      try {
        evidence.push(cloneEvidence((await pending).evidence));
      } catch {
        // Aborted/failed routes do not retain partial evidence.
      }
    }
    return evidence;
  }

  private bypass(body: Buffer, reason: string): Buffer {
    if (this.options.requireRouting) {
      throw new Error(`required compositional routing bypassed: ${reason}`);
    }
    return body;
  }

  private preparedIndex(
    fingerprint: string,
    catalog: readonly ToolRoutingCatalogEntry<unknown>[],
  ): { promise: Promise<DenseToolIndex>; hit: boolean } {
    const existing = this.indexes.get(fingerprint);
    if (existing) return { promise: existing, hit: true };
    // Cached work must not inherit one request's cancellation signal.
    const promise = buildDenseToolIndex(catalog, this.options.embedder);
    this.indexes.set(fingerprint, promise);
    void promise.catch(() => {
      if (this.indexes.get(fingerprint) === promise) this.indexes.delete(fingerprint);
    });
    if (this.indexes.size > 32) {
      const oldest = this.indexes.keys().next().value as string | undefined;
      if (oldest && oldest !== fingerprint) this.indexes.delete(oldest);
    }
    return { promise, hit: false };
  }

  private shouldTransform(
    endpoint: RecorderEndpoint,
    method: RecorderMethod,
    modelCallSequence: number | null,
    runId: string | null,
  ): runId is string {
    return (
      endpoint === "chat-completions" &&
      method === "POST" &&
      modelCallSequence !== null &&
      runId !== null
    );
  }

  private async transform(input: RecordingProxyTransformInput): Promise<Buffer> {
    if (!this.shouldTransform(input.endpoint, input.method, input.modelCallSequence, input.runId)) {
      return this.bypass(input.body, "unsupported request boundary");
    }
    const runId = input.runId;

    let payload: JsonRecord;
    try {
      const value: unknown = JSON.parse(input.body.toString("utf8"));
      if (!isRecord(value)) return this.bypass(input.body, "request body is not an object");
      payload = value;
    } catch {
      return this.bypass(input.body, "request body is not valid JSON");
    }
    if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
      return this.bypass(input.body, "request has no tools");
    }

    const parsed = payload.tools.map((tool) => parsedTool(tool, this.isRoutableTool));
    // Preserve the whole request when any schema shape is unknown; never drop a
    // tool the transformer cannot identify safely.
    if (parsed.some((tool) => tool === null)) {
      return this.bypass(input.body, "request contains an unsupported tool schema");
    }
    const tools = parsed as ParsedTool[];
    const routable = tools.filter((tool) => tool.routable);
    if (routable.length === 0) return this.bypass(input.body, "request has no routable tools");

    const fingerprint = catalogFingerprint(tools);
    const query = extractChatQuery(payload);
    if (!query) return this.bypass(input.body, "request has no user query");
    const routeKey = `${runId}:${queryFingerprint(query)}:${fingerprint}`;
    let pending = this.routes.get(routeKey);
    const cacheHit = pending !== undefined;

    if (!pending) {
      const catalog: ToolRoutingCatalogEntry<unknown>[] = routable.map((tool) => ({
        name: tool.name,
        description: tool.description,
        definition: tool.definition,
      }));
      const prepared = this.preparedIndex(fingerprint, catalog);
      pending = (async (): Promise<CachedRoute> => {
        const result = await routeCompositionalTools(query, catalog, {
          ...this.options,
          preparedIndex: prepared.promise,
          // Requests cancel only their own wait; shared work stays usable.
          signal: undefined,
        });
        const selected =
          result.disposition === "passthrough"
            ? new Set(routable.map((tool) => tool.name))
            : new Set(result.selected_tool_names);
        if (
          result.selected_tool_names.some((name) => !routable.some((tool) => tool.name === name))
        ) {
          throw new Error("router selected a tool outside the reviewed catalog");
        }
        const forwardedToolCount = tools.filter(
          (tool) => !tool.routable || selected.has(tool.name),
        ).length;
        return {
          selectedNames: selected,
          evidence: {
            run_id: runId,
            source_tool_count: tools.length,
            routable_tool_count: routable.length,
            preserved_tool_count: tools.length - routable.length,
            forwarded_tool_count:
              result.disposition === "passthrough" ? tools.length : forwardedToolCount,
            cache_hits: 0,
            index_cache_hit: prepared.hit,
            transform_bypass: null,
            routing: result.evidence,
          },
        };
      })();
      this.routes.set(routeKey, pending);
      const runKeys = this.routeKeysByRun.get(runId) ?? new Set<string>();
      runKeys.add(routeKey);
      this.routeKeysByRun.set(runId, runKeys);
      void pending.catch(() => {
        if (this.routes.get(routeKey) === pending) this.routes.delete(routeKey);
        this.routeKeysByRun.get(runId)?.delete(routeKey);
      });
    }

    const cached = await awaitWithAbort(pending, input.signal);
    if (cacheHit) cached.evidence.cache_hits += 1;

    if (cached.evidence.routing.fallback !== null) {
      return this.bypass(input.body, `routing fallback: ${cached.evidence.routing.fallback}`);
    }
    const choice = namedToolChoice(payload);
    if (
      choice &&
      routable.some((tool) => tool.name === choice) &&
      !cached.selectedNames.has(choice)
    ) {
      cached.evidence.transform_bypass = "tool-choice-conflict";
      cached.evidence.forwarded_tool_count = tools.length;
      return this.bypass(input.body, "named tool choice conflicts with routed catalog");
    }
    payload.tools = tools
      .filter((tool) => !tool.routable || cached.selectedNames.has(tool.name))
      .map((tool) => tool.definition);
    return Buffer.from(JSON.stringify(payload), "utf8");
  }
}
