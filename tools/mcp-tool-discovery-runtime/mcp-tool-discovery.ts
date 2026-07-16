// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  createBoundedMcpFetch,
  MCP_TOOL_DISCOVERY_LIMITS,
  MCP_TOOL_DISCOVERY_PROTOCOL,
  type McpToolDiscoveryResult,
  normalizeMcpToolPage,
  runMcpToolDiscoverySession,
} from "./tool-discovery-core.ts";

interface RuntimeArguments {
  url: URL;
  authorization: string;
}

function parseArguments(args: string[]): RuntimeArguments {
  if (args.length !== 4 || args[0] !== "--url" || args[2] !== "--authorization") {
    throw new Error("invalid arguments");
  }
  const url = new URL(args[1]);
  const authorization = args[3];
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    authorization.length === 0 ||
    authorization.length > 4_096 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(authorization)
  ) {
    throw new Error("invalid arguments");
  }
  return { url, authorization };
}

function writeResult(result: McpToolDiscoveryResult): void {
  process.stdout.write(`${JSON.stringify({ protocol: MCP_TOOL_DISCOVERY_PROTOCOL, ...result })}\n`);
}

async function main(): Promise<void> {
  let runtimeArguments: RuntimeArguments;
  try {
    runtimeArguments = parseArguments(process.argv.slice(2));
  } catch {
    writeResult({
      ok: false,
      count: 0,
      tools: [],
      truncated: false,
      detail: "tool discovery received invalid runtime arguments",
    });
    return;
  }

  const deadlineSignal = AbortSignal.timeout(MCP_TOOL_DISCOVERY_LIMITS.maxTotalTimeMs);
  const boundedFetch = createBoundedMcpFetch(globalThis.fetch, deadlineSignal);
  const transport = new StreamableHTTPClientTransport(runtimeArguments.url, {
    fetch: boundedFetch,
    requestInit: {
      headers: { authorization: runtimeArguments.authorization },
      redirect: "manual",
    },
    reconnectionOptions: {
      maxReconnectionDelay: 1,
      initialReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client(
    { name: "nemoclaw-mcp-tool-discovery", version: "1.0.0" },
    { capabilities: {} },
  );
  const requestOptions = {
    signal: deadlineSignal,
    timeout: MCP_TOOL_DISCOVERY_LIMITS.maxRequestTimeMs,
    maxTotalTimeout: MCP_TOOL_DISCOVERY_LIMITS.maxTotalTimeMs,
  };

  await runMcpToolDiscoverySession({
    connect: () => client.connect(transport, requestOptions),
    loadPage: async (cursor) => {
      const page = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
      return normalizeMcpToolPage(page);
    },
    hasSession: () => Boolean(transport.sessionId),
    terminateSession: () => transport.terminateSession(),
    close: () => client.close(),
    publishResult: writeResult,
  });
}

await main();
