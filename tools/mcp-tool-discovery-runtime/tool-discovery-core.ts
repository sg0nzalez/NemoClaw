// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MCP_TOOL_DISCOVERY_PROTOCOL = 1;

export const MCP_TOOL_DISCOVERY_LIMITS = {
  maxTotalTimeMs: 10_000,
  maxRequestTimeMs: 5_000,
  maxResponseBytes: 1_048_576,
  maxPages: 20,
  maxTools: 500,
  maxCursorBytes: 2_048,
  maxToolNameBytes: 256,
} as const;

export interface McpToolDiscoveryResult {
  ok: boolean;
  count: number;
  tools: string[];
  truncated: boolean;
  detail?: string;
}

export interface McpToolPage {
  tools: Array<{ name: string }>;
  nextCursor?: string;
}

export type McpToolPageLoader = (cursor?: string) => Promise<McpToolPage>;

type ToolDiscoveryErrorCode = "invalid-response" | "redirect" | "response-too-large" | "timeout";

export class ToolDiscoveryRuntimeError extends Error {
  readonly code: ToolDiscoveryErrorCode;

  constructor(code: ToolDiscoveryErrorCode) {
    super(code);
    this.name = "ToolDiscoveryRuntimeError";
    this.code = code;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validToolName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    utf8Bytes(name) <= MCP_TOOL_DISCOVERY_LIMITS.maxToolNameBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(name)
  );
}

function validateCursor(cursor: unknown): cursor is string {
  return (
    typeof cursor === "string" &&
    cursor.length > 0 &&
    utf8Bytes(cursor) <= MCP_TOOL_DISCOVERY_LIMITS.maxCursorBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(cursor)
  );
}

function truncatedResult(tools: string[], detail: string): McpToolDiscoveryResult {
  const sorted = [...tools].sort(compareNames);
  return {
    ok: false,
    count: sorted.length,
    tools: sorted,
    truncated: true,
    detail,
  };
}

export async function enumerateMcpToolNames(
  loadPage: McpToolPageLoader,
): Promise<McpToolDiscoveryResult> {
  const names: string[] = [];
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 1; pageNumber <= MCP_TOOL_DISCOVERY_LIMITS.maxPages; pageNumber += 1) {
    const page = await loadPage(cursor);
    if (!page || !Array.isArray(page.tools)) {
      throw new ToolDiscoveryRuntimeError("invalid-response");
    }

    for (const tool of page.tools) {
      if (!tool || !validToolName(tool.name) || seenNames.has(tool.name)) {
        throw new ToolDiscoveryRuntimeError("invalid-response");
      }
      seenNames.add(tool.name);
      if (names.length < MCP_TOOL_DISCOVERY_LIMITS.maxTools) names.push(tool.name);
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) {
      if (seenNames.size > MCP_TOOL_DISCOVERY_LIMITS.maxTools) {
        return truncatedResult(
          names,
          `tool discovery exceeded the ${MCP_TOOL_DISCOVERY_LIMITS.maxTools}-tool safety limit`,
        );
      }
      const sorted = [...names].sort(compareNames);
      return {
        ok: true,
        count: sorted.length,
        tools: sorted,
        truncated: false,
      };
    }

    if (!validateCursor(nextCursor) || seenCursors.has(nextCursor)) {
      throw new ToolDiscoveryRuntimeError("invalid-response");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;

    if (seenNames.size >= MCP_TOOL_DISCOVERY_LIMITS.maxTools) {
      return truncatedResult(
        names,
        `tool discovery reached the ${MCP_TOOL_DISCOVERY_LIMITS.maxTools}-tool safety limit before pagination completed`,
      );
    }
    if (pageNumber === MCP_TOOL_DISCOVERY_LIMITS.maxPages) {
      return truncatedResult(
        names,
        `tool discovery reached the ${MCP_TOOL_DISCOVERY_LIMITS.maxPages}-page safety limit`,
      );
    }
  }

  throw new ToolDiscoveryRuntimeError("invalid-response");
}

export type ToolDiscoveryFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function combinedSignal(left: AbortSignal | null | undefined, right: AbortSignal): AbortSignal {
  return left ? AbortSignal.any([left, right]) : right;
}

export function createBoundedMcpFetch(
  fetchImpl: ToolDiscoveryFetch,
  deadlineSignal: AbortSignal,
): ToolDiscoveryFetch {
  let responseBytes = 0;

  return async (input, init = {}) => {
    let response: Response;
    try {
      response = await fetchImpl(input, {
        ...init,
        redirect: "manual",
        signal: combinedSignal(init.signal, deadlineSignal),
      });
    } catch (error) {
      if (deadlineSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new ToolDiscoveryRuntimeError("timeout");
      }
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ToolDiscoveryRuntimeError("redirect");
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && /^\d+$/u.test(contentLength)) {
      const declaredBytes = Number(contentLength);
      if (
        !Number.isSafeInteger(declaredBytes) ||
        responseBytes + declaredBytes > MCP_TOOL_DISCOVERY_LIMITS.maxResponseBytes
      ) {
        await response.body?.cancel();
        throw new ToolDiscoveryRuntimeError("response-too-large");
      }
    }

    if (!response.body) return response;
    const reader = response.body.getReader();
    const boundedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          responseBytes += value.byteLength;
          if (responseBytes > MCP_TOOL_DISCOVERY_LIMITS.maxResponseBytes) {
            await reader.cancel();
            controller.error(new ToolDiscoveryRuntimeError("response-too-large"));
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function safeToolDiscoveryErrorDetail(error: unknown): string {
  if (error instanceof ToolDiscoveryRuntimeError) {
    switch (error.code) {
      case "invalid-response":
        return "MCP endpoint returned an invalid tool-list response";
      case "redirect":
        return "MCP endpoint redirect was rejected";
      case "response-too-large":
        return `MCP responses exceeded the ${MCP_TOOL_DISCOVERY_LIMITS.maxResponseBytes}-byte safety limit`;
      case "timeout":
        return `tool discovery timed out after ${MCP_TOOL_DISCOVERY_LIMITS.maxTotalTimeMs / 1_000}s`;
    }
  }

  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      /(?:request|maximum total) timeout|timed out/iu.test(error.message)
    ) {
      return `tool discovery timed out after ${MCP_TOOL_DISCOVERY_LIMITS.maxTotalTimeMs / 1_000}s`;
    }
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "number" && code >= 100 && code <= 599) {
      return `MCP endpoint rejected tool discovery (HTTP ${code})`;
    }
  }

  return "MCP tool discovery request failed";
}
