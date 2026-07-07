// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import { canonicalJson, type JsonValue, sha256Hex } from "./catalog";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type RecorderEndpoint =
  | "chat-completions"
  | "responses"
  | "completions"
  | "embeddings"
  | "tokenize"
  | "models"
  | "other-v1";

export type RecorderMethod = "GET" | "POST" | "OTHER";

export type RecorderOutcome =
  | "completed"
  | "request-rejected"
  | "upstream-timeout"
  | "upstream-connection-error"
  | "upstream-response-error"
  | "client-aborted";

export type RecorderErrorReason =
  | "request-body-too-large"
  | "request-timeout"
  | "client-request-error"
  | "upstream-timeout"
  | "upstream-connection-error"
  | "upstream-response-error"
  | "proxy-failure"
  | "client-aborted";

/**
 * A deliberately content-free record of one proxied /v1 request.
 *
 * Do not add URLs, headers, request/response bodies, model identifiers, tool
 * descriptions, or thrown error messages to this interface. This object is
 * suitable for direct inclusion in the public performance test evidence bundle.
 */
export interface ToolDisclosureRecordingEvent {
  run_id: string;
  request_sequence: number;
  model_call_sequence: number | null;
  endpoint: RecorderEndpoint;
  method: RecorderMethod;
  visible_tool_count: number;
  canonical_tools_json_bytes: number;
  tools_sha256: string | null;
  tool_names: readonly string[];
  streaming: boolean | null;
  status_code: number | null;
  started_monotonic_ms: number;
  first_byte_monotonic_ms: number | null;
  ended_monotonic_ms: number;
  duration_ms: number;
  time_to_first_byte_ms: number | null;
  outcome: RecorderOutcome;
  error_reason: RecorderErrorReason | null;
}

export interface RecordingProxyOptions {
  upstreamBaseUrl: string;
  /** Explicitly allow a credential-free non-loopback HTTPS upstream. */
  allowRemoteHttpsUpstream?: boolean;
  /** Must be exactly 127.0.0.1. Exposed so unsafe configuration fails closed. */
  listenHost?: string;
  /** Zero selects an ephemeral port. */
  port?: number;
  maxRequestBodyBytes?: number;
  requestTimeoutMs?: number;
  requiredTemperature?: number;
  requestTransform?: RecordingProxyRequestTransform;
}

/**
 * Private request content supplied only to an opt-in transform invocation.
 *
 * The body is a defensive copy and is never retained by the proxy. Transform
 * implementations must likewise avoid logging or retaining it. Public evidence
 * continues to contain only the content-free metrics derived after transformation.
 */
export interface RecordingProxyTransformInput {
  readonly runId: string | null;
  readonly endpoint: RecorderEndpoint;
  readonly method: RecorderMethod;
  readonly modelCallSequence: number | null;
  readonly body: Buffer;
  readonly signal: AbortSignal;
}

/** Return the complete request body to forward upstream. */
export type RecordingProxyRequestTransform = (
  input: RecordingProxyTransformInput,
) => Buffer | Promise<Buffer>;

export interface RecordingProxyAddress {
  host: typeof LOOPBACK_HOST;
  port: number;
  base_url: string;
}

/**
 * Ephemeral schema material for exact tokenizer counting. This type must never
 * be serialized into the public evidence bundle.
 */
export interface EphemeralToolSchemaSnapshot {
  run_id: string;
  model_call_sequence: number;
  canonical_tools_json: string;
}

interface ToolMetrics {
  visibleToolCount: number;
  canonicalToolsJsonBytes: number;
  toolsSha256: string | null;
  toolNames: readonly string[];
  canonicalToolsJson: string | null;
  streaming: boolean | null;
  temperature: number | null;
}

interface PendingRecording {
  runId: string;
  requestSequence: number;
  modelCallSequence: number | null;
  endpoint: RecorderEndpoint;
  method: RecorderMethod;
  startedAt: number;
  metrics: ToolMetrics;
  finalized: boolean;
}

interface ActiveRun {
  id: string;
  requestSequence: number;
  modelCallSequence: number;
  pendingRequests: number;
  eventStartIndex: number;
}

interface ForwardContext {
  bodyComplete: boolean;
  transformComplete: boolean;
  cancelled: boolean;
  timedOut: boolean;
  abortController: AbortController;
  upstreamRequest: http.ClientRequest | null;
}

interface FinalizeOptions {
  statusCode: number | null;
  firstByteAt?: number;
  outcome: RecorderOutcome;
  errorReason?: RecorderErrorReason;
}

type BodyReadResult =
  | { kind: "body"; body: Buffer }
  | { kind: "too-large" }
  | { kind: "client-error" };

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function parseUpstreamBaseUrl(value: string, allowRemoteHttpsUpstream: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("upstreamBaseUrl must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("upstreamBaseUrl must use HTTP or HTTPS");
  }
  const hostname = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  // URL canonicalizes equivalent IPv6 spellings to ::1. Keep the plaintext
  // allowlist exact; IPv4-mapped and scoped IPv6 forms are intentionally rejected.
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (!loopback && !allowRemoteHttpsUpstream) {
    throw new Error("upstreamBaseUrl is allowed only on loopback");
  }
  if (!loopback && url.protocol !== "https:") {
    throw new Error("a remote recording upstream must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("upstreamBaseUrl must not contain credentials");
  }
  // Query values are never recorded, but accepting them in long-lived
  // configuration makes it too easy to embed an API key in a report command.
  if (url.search || url.hash) {
    throw new Error("upstreamBaseUrl must not contain a query or fragment");
  }
  // Do not delegate the accepted localhost alias to ambient DNS resolution.
  if (hostname === "localhost") {
    url.hostname = LOOPBACK_HOST;
  }
  return url;
}

function classifyEndpoint(pathname: string): RecorderEndpoint {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/v1/chat/completions") return "chat-completions";
  if (normalized === "/v1/responses") return "responses";
  if (normalized === "/v1/completions") return "completions";
  if (normalized === "/v1/embeddings") return "embeddings";
  if (normalized === "/v1/tokenize") return "tokenize";
  if (normalized === "/v1/models") return "models";
  return "other-v1";
}

function classifyMethod(method: string | undefined): RecorderMethod {
  if (method === "GET") return "GET";
  if (method === "POST") return "POST";
  return "OTHER";
}

function isModelCall(endpoint: RecorderEndpoint, method: RecorderMethod): boolean {
  return (
    method === "POST" &&
    ["chat-completions", "responses", "completions", "embeddings"].includes(endpoint)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeToolName(tool: unknown): string | null {
  if (!isRecord(tool)) return null;
  let candidate: unknown;
  if (isRecord(tool.function)) candidate = tool.function.name;
  else candidate = tool.name ?? tool.type;
  if (typeof candidate !== "string") return null;
  return SAFE_TOOL_NAME.test(candidate) ? candidate : "[invalid-name]";
}

function inspectTools(body: Buffer): ToolMetrics {
  const empty: ToolMetrics = {
    visibleToolCount: 0,
    canonicalToolsJsonBytes: 0,
    toolsSha256: null,
    toolNames: [],
    canonicalToolsJson: null,
    streaming: null,
    temperature: null,
  };
  if (body.length === 0) return empty;

  try {
    const payload: unknown = JSON.parse(body.toString("utf8"));
    if (!isRecord(payload)) return empty;
    empty.temperature = typeof payload.temperature === "number" ? payload.temperature : null;
    if (!Array.isArray(payload.tools)) return empty;
    const canonicalTools = canonicalJson(payload.tools as JsonValue);
    return {
      visibleToolCount: payload.tools.length,
      canonicalToolsJsonBytes: Buffer.byteLength(canonicalTools),
      toolsSha256: sha256Hex(canonicalTools),
      toolNames: payload.tools.flatMap((tool) => {
        const name = safeToolName(tool);
        return name === null ? [] : [name];
      }),
      canonicalToolsJson: canonicalTools,
      streaming: typeof payload.stream === "boolean" ? payload.stream : null,
      temperature: typeof payload.temperature === "number" ? payload.temperature : null,
    };
  } catch {
    // Invalid JSON and pathological nesting are forwarded unchanged, but no
    // body-derived diagnostic is retained in the public event stream.
    return empty;
  }
}

function connectionHeaderNames(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(
    joined
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  bodyLength: number,
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const connectionNames = connectionHeaderNames(headers);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      normalized === "host" ||
      normalized === "content-length" ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      connectionNames.has(normalized)
    ) {
      continue;
    }
    result[name] = value;
  }
  result["content-length"] = String(bodyLength);
  return result;
}

function forwardedResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const connectionNames = connectionHeaderNames(headers);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      connectionNames.has(normalized)
    ) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function fixedResponse(response: ServerResponse, status: number, error: string): void {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify({ error });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  response.end(body);
}

function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    let chunks: Buffer[] = [];

    const finish = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      chunks = [];
      resolve(result);
    };

    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        request.resume();
        finish({ kind: "too-large" });
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => {
      if (!settled) finish({ kind: "body", body: Buffer.concat(chunks, size) });
    });
    request.once("aborted", () => finish({ kind: "client-error" }));
    request.once("error", () => finish({ kind: "client-error" }));
  });
}

/**
 * Loopback-only OpenAI-compatible recording proxy for performance test measurements.
 * The proxy never logs and keeps only content-free events in memory.
 */
export class ToolDisclosureRecordingProxy {
  private readonly upstream: URL;
  private readonly listenHost: typeof LOOPBACK_HOST;
  private readonly configuredPort: number;
  private readonly maxRequestBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly requiredTemperature: number | undefined;
  private readonly requestTransform: RecordingProxyRequestTransform | undefined;
  private readonly clock: () => number;
  private readonly sockets = new Set<Socket>();
  private readonly events: ToolDisclosureRecordingEvent[] = [];
  private readonly ephemeralSchemas = new Map<string, EphemeralToolSchemaSnapshot>();
  private server: Server | null = null;
  private activeRun: ActiveRun | null = null;

  constructor(options: RecordingProxyOptions) {
    const listenHost = options.listenHost ?? LOOPBACK_HOST;
    if (listenHost !== LOOPBACK_HOST) {
      throw new Error(`recording proxy listenHost must be exactly ${LOOPBACK_HOST}`);
    }
    const port = options.port ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new Error("recording proxy port must be an integer from 0 through 65535");
    }
    const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    validatePositiveInteger(maxRequestBodyBytes, "maxRequestBodyBytes");
    validatePositiveInteger(requestTimeoutMs, "requestTimeoutMs");

    this.upstream = parseUpstreamBaseUrl(
      options.upstreamBaseUrl,
      options.allowRemoteHttpsUpstream === true,
    );
    this.listenHost = listenHost;
    this.configuredPort = port;
    this.maxRequestBodyBytes = maxRequestBodyBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requiredTemperature = options.requiredTemperature;
    this.requestTransform = options.requestTransform;
    this.clock = () => performance.now();
  }

  async start(): Promise<RecordingProxyAddress> {
    if (this.server) throw new Error("recording proxy is already started");

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        // Keep thrown implementation errors content-free at the network and
        // evidence boundaries. The performance test runner receives a fixed class.
        fixedResponse(response, 502, "recording proxy failure");
      });
    });
    server.requestTimeout = this.requestTimeoutMs;
    server.headersTimeout = Math.min(this.requestTimeoutMs, 60_000);
    server.maxHeadersCount = 200;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.configuredPort, this.listenHost);
    });
    this.server = server;

    const address = server.address();
    if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
      await this.stop();
      throw new Error("recording proxy failed to bind the required loopback address");
    }
    return {
      host: LOOPBACK_HOST,
      port: address.port,
      base_url: `http://${LOOPBACK_HOST}:${address.port}`,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  beginRun(runId: string = randomUUID()): string {
    if (this.activeRun) throw new Error("a recording run is already active");
    if (!SAFE_RUN_ID.test(runId)) {
      throw new Error(
        "recording run ID must be 1-256 public-safe letters, digits, dots, underscores, colons, or hyphens",
      );
    }
    this.activeRun = {
      id: runId,
      requestSequence: 0,
      modelCallSequence: 0,
      pendingRequests: 0,
      eventStartIndex: this.events.length,
    };
    return runId;
  }

  endRun(): readonly ToolDisclosureRecordingEvent[] {
    const run = this.activeRun;
    if (!run) throw new Error("no recording run is active");
    if (run.pendingRequests !== 0) {
      throw new Error("cannot end a recording run while requests are in flight");
    }
    this.activeRun = null;
    return this.events
      .slice(run.eventStartIndex)
      .filter((event) => event.run_id === run.id)
      .map((event) => ({ ...event, tool_names: [...event.tool_names] }));
  }

  getEvents(runId?: string): readonly ToolDisclosureRecordingEvent[] {
    return this.events
      .filter((event) => runId === undefined || event.run_id === runId)
      .map((event) => ({ ...event, tool_names: [...event.tool_names] }));
  }

  resetEvents(): void {
    if (this.activeRun) throw new Error("cannot reset events while a recording run is active");
    this.events.length = 0;
    this.ephemeralSchemas.clear();
  }

  /** Return and erase private schema content after a run so it can be tokenized exactly. */
  consumeToolSchemaSnapshots(runId: string): readonly EphemeralToolSchemaSnapshot[] {
    if (this.activeRun?.id === runId)
      throw new Error("cannot consume schemas while a run is active");
    const snapshots = [...this.ephemeralSchemas.values()]
      .filter((snapshot) => snapshot.run_id === runId)
      .sort((left, right) => left.model_call_sequence - right.model_call_sequence)
      .map((snapshot) => ({ ...snapshot }));
    for (const snapshot of snapshots) {
      this.ephemeralSchemas.delete(`${snapshot.run_id}:${snapshot.model_call_sequence}`);
    }
    return snapshots;
  }

  private reserveRecording(
    endpoint: RecorderEndpoint,
    method: RecorderMethod,
  ): PendingRecording | null {
    const run = this.activeRun;
    if (!run) return null;
    run.requestSequence += 1;
    run.pendingRequests += 1;
    let modelCallSequence: number | null = null;
    if (isModelCall(endpoint, method)) {
      run.modelCallSequence += 1;
      modelCallSequence = run.modelCallSequence;
    }
    return {
      runId: run.id,
      requestSequence: run.requestSequence,
      modelCallSequence,
      endpoint,
      method,
      startedAt: this.clock(),
      metrics: {
        visibleToolCount: 0,
        canonicalToolsJsonBytes: 0,
        toolsSha256: null,
        toolNames: [],
        canonicalToolsJson: null,
        streaming: null,
        temperature: null,
      },
      finalized: false,
    };
  }

  private finalizeRecording(pending: PendingRecording | null, options: FinalizeOptions): void {
    if (!pending || pending.finalized) return;
    pending.finalized = true;
    const endedAt = this.clock();
    const firstByteAt = options.firstByteAt ?? null;
    const event: ToolDisclosureRecordingEvent = {
      run_id: pending.runId,
      request_sequence: pending.requestSequence,
      model_call_sequence: pending.modelCallSequence,
      endpoint: pending.endpoint,
      method: pending.method,
      visible_tool_count: pending.metrics.visibleToolCount,
      canonical_tools_json_bytes: pending.metrics.canonicalToolsJsonBytes,
      tools_sha256: pending.metrics.toolsSha256,
      tool_names: [...pending.metrics.toolNames],
      streaming: pending.metrics.streaming,
      status_code: options.statusCode,
      started_monotonic_ms: pending.startedAt,
      first_byte_monotonic_ms: firstByteAt,
      ended_monotonic_ms: endedAt,
      duration_ms: endedAt - pending.startedAt,
      time_to_first_byte_ms: firstByteAt === null ? null : firstByteAt - pending.startedAt,
      outcome: options.outcome,
      error_reason: options.errorReason ?? null,
    };
    this.events.push(Object.freeze(event));
    if (pending.modelCallSequence !== null && pending.metrics.canonicalToolsJson !== null) {
      const snapshot: EphemeralToolSchemaSnapshot = {
        run_id: pending.runId,
        model_call_sequence: pending.modelCallSequence,
        canonical_tools_json: pending.metrics.canonicalToolsJson,
      };
      this.ephemeralSchemas.set(
        `${snapshot.run_id}:${snapshot.model_call_sequence}`,
        Object.freeze(snapshot),
      );
    }
    if (this.activeRun?.id === pending.runId) {
      this.activeRun.pendingRequests -= 1;
    }
  }

  private buildUpstreamUrl(incoming: URL): URL {
    const target = new URL(this.upstream.toString());
    const basePath = target.pathname.replace(/\/+$/, "");
    const prefix = basePath.endsWith("/v1") ? basePath.slice(0, -3) : basePath;
    target.pathname = `${prefix}${incoming.pathname}` || "/";
    target.search = incoming.search;
    return target;
  }

  private async transformRequestBody(
    body: Buffer,
    pending: PendingRecording | null,
    endpoint: RecorderEndpoint,
    method: RecorderMethod,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (!this.requestTransform) return body;
    const transformed = await this.requestTransform({
      runId: pending?.runId ?? null,
      endpoint,
      method,
      modelCallSequence: pending?.modelCallSequence ?? null,
      body: Buffer.from(body),
      signal,
    });
    if (!Buffer.isBuffer(transformed)) {
      throw new TypeError("recording proxy request transform must return a Buffer");
    }
    // Detach forwarding from any reference retained by the transform so later
    // mutation cannot alter the bytes inspected, recorded, or sent upstream.
    return Buffer.from(transformed);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let incoming: URL;
    try {
      incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      fixedResponse(response, 400, "invalid request target");
      return;
    }
    if (incoming.pathname !== "/v1" && !incoming.pathname.startsWith("/v1/")) {
      fixedResponse(response, 404, "not found");
      return;
    }

    const endpoint = classifyEndpoint(incoming.pathname);
    const method = classifyMethod(request.method);
    const pending = this.reserveRecording(endpoint, method);
    const context: ForwardContext = {
      bodyComplete: false,
      transformComplete: false,
      cancelled: false,
      timedOut: false,
      abortController: new AbortController(),
      upstreamRequest: null,
    };
    request.once("aborted", () => context.abortController.abort());
    response.once("close", () => {
      if (!response.writableEnded) context.abortController.abort();
    });

    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxRequestBodyBytes) {
      request.resume();
      fixedResponse(response, 413, "request body too large");
      this.finalizeRecording(pending, {
        statusCode: 413,
        outcome: "request-rejected",
        errorReason: "request-body-too-large",
      });
      return;
    }

    const timer = setTimeout(() => {
      context.cancelled = true;
      context.timedOut = true;
      context.abortController.abort();
      if (context.upstreamRequest) {
        context.upstreamRequest.destroy();
        return;
      }
      const waitingForUpstream = context.bodyComplete && context.transformComplete;
      const statusCode = waitingForUpstream ? 504 : 408;
      fixedResponse(
        response,
        statusCode,
        waitingForUpstream ? "upstream timeout" : "request timeout",
      );
      this.finalizeRecording(pending, {
        statusCode,
        outcome: waitingForUpstream ? "upstream-timeout" : "request-rejected",
        errorReason: waitingForUpstream ? "upstream-timeout" : "request-timeout",
      });
      request.destroy();
    }, this.requestTimeoutMs);
    timer.unref();

    try {
      const bodyResult = await readBoundedBody(request, this.maxRequestBodyBytes);
      context.bodyComplete = true;
      if (context.cancelled) return;
      if (bodyResult.kind === "too-large") {
        fixedResponse(response, 413, "request body too large");
        this.finalizeRecording(pending, {
          statusCode: 413,
          outcome: "request-rejected",
          errorReason: "request-body-too-large",
        });
        return;
      }
      if (bodyResult.kind === "client-error") {
        this.finalizeRecording(pending, {
          statusCode: null,
          outcome: "client-aborted",
          errorReason: "client-request-error",
        });
        return;
      }

      let forwardedBody = await this.transformRequestBody(
        bodyResult.body,
        pending,
        endpoint,
        method,
        context.abortController.signal,
      );
      context.transformComplete = true;
      if (context.cancelled) return;
      if (forwardedBody.length > this.maxRequestBodyBytes) {
        fixedResponse(response, 413, "request body too large");
        this.finalizeRecording(pending, {
          statusCode: 413,
          outcome: "request-rejected",
          errorReason: "request-body-too-large",
        });
        return;
      }
      let forwardedMetrics = inspectTools(forwardedBody);
      if (pending) pending.metrics = forwardedMetrics;
      if (
        pending?.modelCallSequence != null &&
        this.requiredTemperature !== undefined &&
        forwardedMetrics.temperature !== null &&
        forwardedMetrics.temperature !== this.requiredTemperature
      ) {
        fixedResponse(response, 400, "performance test temperature mismatch");
        this.finalizeRecording(pending, {
          statusCode: 400,
          outcome: "request-rejected",
          errorReason: "proxy-failure",
        });
        return;
      }
      if (
        pending?.modelCallSequence != null &&
        this.requiredTemperature !== undefined &&
        forwardedMetrics.temperature === null
      ) {
        const payload = JSON.parse(forwardedBody.toString("utf8")) as Record<string, unknown>;
        payload.temperature = this.requiredTemperature;
        forwardedBody = Buffer.from(JSON.stringify(payload), "utf8");
        if (forwardedBody.length > this.maxRequestBodyBytes) {
          fixedResponse(response, 413, "request body too large");
          this.finalizeRecording(pending, {
            statusCode: 413,
            outcome: "request-rejected",
            errorReason: "request-body-too-large",
          });
          return;
        }
        forwardedMetrics = inspectTools(forwardedBody);
        if (pending) pending.metrics = forwardedMetrics;
      }
      await this.forwardRequest(
        request,
        response,
        this.buildUpstreamUrl(incoming),
        forwardedBody,
        pending,
        context,
      );
    } catch {
      fixedResponse(response, 502, "recording proxy failure");
      this.finalizeRecording(pending, {
        statusCode: response.headersSent ? response.statusCode : 502,
        outcome: "request-rejected",
        errorReason: "proxy-failure",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private forwardRequest(
    incomingRequest: IncomingMessage,
    response: ServerResponse,
    target: URL,
    body: Buffer,
    pending: PendingRecording | null,
    context: ForwardContext,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let statusCode: number | null = null;
      let firstByteAt: number | undefined;

      const finish = (options: FinalizeOptions): void => {
        if (settled) return;
        settled = true;
        this.finalizeRecording(pending, options);
        resolve();
      };

      const transport = target.protocol === "https:" ? https : http;
      const upstreamRequest = transport.request(
        target,
        {
          method: incomingRequest.method,
          headers: forwardedRequestHeaders(incomingRequest.headers, body.length),
        },
        (upstreamResponse) => {
          statusCode = upstreamResponse.statusCode ?? 502;
          if (statusCode >= 300 && statusCode < 400) {
            upstreamResponse.resume();
            fixedResponse(response, 502, "upstream redirect rejected");
            finish({
              statusCode: 502,
              outcome: "request-rejected",
              errorReason: "proxy-failure",
            });
            return;
          }
          if (!response.headersSent && !response.destroyed) {
            response.writeHead(statusCode, forwardedResponseHeaders(upstreamResponse.headers));
          }

          upstreamResponse.once("data", () => {
            firstByteAt = this.clock();
          });
          upstreamResponse.once("end", () => {
            finish({
              statusCode,
              firstByteAt,
              outcome: "completed",
            });
          });
          upstreamResponse.once("aborted", () => {
            finish({
              statusCode,
              firstByteAt,
              outcome: context.timedOut ? "upstream-timeout" : "upstream-response-error",
              errorReason: context.timedOut ? "upstream-timeout" : "upstream-response-error",
            });
            if (!response.writableEnded) response.destroy();
          });
          upstreamResponse.once("error", () => {
            finish({
              statusCode,
              firstByteAt,
              outcome: context.timedOut ? "upstream-timeout" : "upstream-response-error",
              errorReason: context.timedOut ? "upstream-timeout" : "upstream-response-error",
            });
            if (!response.writableEnded) response.destroy();
          });
          upstreamResponse.pipe(response);
        },
      );
      context.upstreamRequest = upstreamRequest;

      response.once("close", () => {
        if (settled || response.writableEnded) return;
        upstreamRequest.destroy();
        finish({
          statusCode,
          firstByteAt,
          outcome: "client-aborted",
          errorReason: "client-aborted",
        });
      });
      upstreamRequest.once("error", () => {
        if (context.timedOut) {
          const recordedStatus = response.headersSent ? statusCode : 504;
          fixedResponse(response, 504, "upstream timeout");
          finish({
            statusCode: recordedStatus,
            firstByteAt,
            outcome: "upstream-timeout",
            errorReason: "upstream-timeout",
          });
          return;
        }
        const recordedStatus = response.headersSent ? statusCode : 502;
        fixedResponse(response, 502, "upstream unavailable");
        finish({
          statusCode: recordedStatus,
          firstByteAt,
          outcome: "upstream-connection-error",
          errorReason: "upstream-connection-error",
        });
      });
      upstreamRequest.end(body);
    });
  }
}

export function createToolDisclosureRecordingProxy(
  options: RecordingProxyOptions,
): ToolDisclosureRecordingProxy {
  return new ToolDisclosureRecordingProxy(options);
}
