// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  canonicalJson,
  executeSyntheticTool,
  type JsonObject,
  type SyntheticCatalog,
  type SyntheticTool,
} from "./catalog";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const NOTIFICATIONS = new Set([
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
  "notifications/elicitation/complete",
]);

export interface SyntheticMcpCallEvent {
  run_id: string;
  sequence: number;
  tool_name: string;
  arguments_sha256: string;
  result_nonce: string | null;
  success: boolean;
}

export interface SyntheticMcpServerAddress {
  host: "127.0.0.1";
  port: number;
  local_url: string;
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        request.resume();
        finish(null);
      } else {
        chunks.push(buffer);
      }
    });
    request.once("end", () => finish(Buffer.concat(chunks, size)));
    request.once("aborted", () => finish(null));
    request.once("error", () => finish(null));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArguments(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  return value as JsonObject;
}

function mcpTool(tool: SyntheticTool): Record<string, unknown> {
  return {
    name: tool.definition.function.name,
    description: tool.definition.function.description,
    inputSchema: tool.definition.function.parameters,
  };
}

export class SyntheticMcpServer {
  private readonly toolsByName: Map<string, SyntheticTool>;
  private readonly bearerToken: string;
  private readonly server: http.Server;
  private activeRun: { id: string; sequence: number; eventStartIndex: number } | null = null;
  private readonly events: SyntheticMcpCallEvent[] = [];

  constructor(catalog: SyntheticCatalog, bearerToken: string) {
    if (!bearerToken || bearerToken.length > 4_096) {
      throw new Error("performance test MCP bearer token must be non-empty and bounded");
    }
    this.bearerToken = bearerToken;
    this.toolsByName = new Map(
      catalog.tools.map((tool) => [tool.definition.function.name, tool] as const),
    );
    if (this.toolsByName.size !== catalog.size) {
      throw new Error("performance test MCP catalog contains duplicate tool names");
    }
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        jsonResponse(response, 500, { error: "performance test MCP server failure" });
      });
    });
    this.server.requestTimeout = 120_000;
    this.server.headersTimeout = 60_000;
  }

  async start(port = 0): Promise<SyntheticMcpServerAddress> {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("performance test MCP port must be between 0 and 65535");
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
    const address = this.server.address() as AddressInfo | null;
    if (!address || address.address !== "127.0.0.1") {
      await this.stop();
      throw new Error("performance test MCP server failed to bind loopback");
    }
    return {
      host: "127.0.0.1",
      port: address.port,
      local_url: `http://127.0.0.1:${address.port}/mcp`,
    };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  beginRun(runId: string): void {
    if (!SAFE_RUN_ID.test(runId)) throw new Error("invalid performance test MCP run id");
    if (this.activeRun) throw new Error("a performance test MCP run is already active");
    this.activeRun = { id: runId, sequence: 0, eventStartIndex: this.events.length };
  }

  endRun(): SyntheticMcpCallEvent[] {
    const run = this.activeRun;
    if (!run) throw new Error("no performance test MCP run is active");
    this.activeRun = null;
    return this.events
      .slice(run.eventStartIndex)
      .filter((event) => event.run_id === run.id)
      .map((event) => ({ ...event }));
  }

  private record(
    toolName: string,
    argumentsValue: JsonObject,
    nonce: string | null,
    success: boolean,
  ): void {
    const run = this.activeRun;
    if (!run) return;
    run.sequence += 1;
    this.events.push({
      run_id: run.id,
      sequence: run.sequence,
      tool_name: toolName,
      arguments_sha256: executeArgumentHash(argumentsValue),
      result_nonce: nonce,
      success,
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/mcp") {
      jsonResponse(response, 404, { error: "not found" });
      return;
    }
    if (request.method === "HEAD" || request.method === "GET") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "method not allowed" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.bearerToken}`) {
      jsonResponse(response, 401, { error: "authentication required" });
      return;
    }
    const body = await readBody(request);
    if (!body) {
      jsonResponse(response, 413, { error: "request rejected" });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      jsonResponse(response, 400, { error: "invalid JSON" });
      return;
    }
    if (!isRecord(payload) || typeof payload.method !== "string") {
      jsonResponse(response, 400, { error: "invalid JSON-RPC request" });
      return;
    }
    if (NOTIFICATIONS.has(payload.method)) {
      response.writeHead(202);
      response.end();
      return;
    }
    const id = payload.id ?? 1;
    if (payload.method === "initialize") {
      const params = isRecord(payload.params) ? payload.params : {};
      jsonResponse(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "nemoclaw-tool-disclosure-performance-test", version: "1.0.0" },
        },
      });
      return;
    }
    if (payload.method === "tools/list") {
      jsonResponse(response, 200, {
        jsonrpc: "2.0",
        id,
        result: { tools: [...this.toolsByName.values()].map(mcpTool) },
      });
      return;
    }
    if (payload.method === "tools/call") {
      const params = isRecord(payload.params) ? payload.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const argumentsValue = asArguments(params.arguments);
      const tool = this.toolsByName.get(name);
      if (!tool || !argumentsValue) {
        this.record(name || "[invalid-name]", argumentsValue ?? {}, null, false);
        jsonResponse(response, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "invalid performance test tool call" },
        });
        return;
      }
      try {
        const result = executeSyntheticTool(tool, argumentsValue);
        this.record(name, argumentsValue, result.nonce, true);
        jsonResponse(response, 200, {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false },
        });
      } catch {
        this.record(name, argumentsValue, null, false);
        jsonResponse(response, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "invalid performance test tool arguments" },
        });
      }
      return;
    }
    jsonResponse(response, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "method not found" },
    });
  }
}

export function executeArgumentHash(argumentsValue: JsonObject): string {
  return createHash("sha256").update(canonicalJson(argumentsValue), "utf8").digest("hex");
}
