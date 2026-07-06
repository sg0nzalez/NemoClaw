// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildSyntheticArguments,
  generateSyntheticCatalog,
} from "../../scripts/bench/tool-disclosure/catalog";
import {
  executeArgumentHash,
  SyntheticMcpServer,
} from "../../scripts/bench/tool-disclosure/mcp-server";

async function rpc(
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("synthetic benchmark MCP server", () => {
  it("lists and executes the generated catalog while retaining content-free call evidence", async () => {
    const catalog = generateSyntheticCatalog({ size: 16, seed: "mcp-server-test" });
    const token = "fixture-token-that-must-not-be-recorded";
    const server = new SyntheticMcpServer(catalog, token);
    const address = await server.start();
    try {
      const unauthorized = await fetch(address.local_url, { method: "POST", body: "{}" });
      expect(unauthorized.status).toBe(401);

      const initialized = await rpc(address.local_url, token, "initialize", {
        protocolVersion: "2025-03-26",
      });
      expect((await initialized.json()) as object).toMatchObject({
        result: { serverInfo: { name: "nemoclaw-tool-disclosure-benchmark" } },
      });

      const listed = await rpc(address.local_url, token, "tools/list");
      const listPayload = (await listed.json()) as { result: { tools: unknown[] } };
      expect(listPayload.result.tools).toHaveLength(16);

      const tool = catalog.tools[0];
      const args = buildSyntheticArguments(tool, 42);
      server.beginRun("c1-primary-openclaw-progressive");
      const called = await rpc(address.local_url, token, "tools/call", {
        name: tool.definition.function.name,
        arguments: args,
      });
      const callPayload = (await called.json()) as { result: { content: Array<{ text: string }> } };
      expect(callPayload.result.content[0].text).toContain('"nonce"');
      const events = server.endRun();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        run_id: "c1-primary-openclaw-progressive",
        sequence: 1,
        tool_name: tool.definition.function.name,
        arguments_sha256: executeArgumentHash(args),
        success: true,
      });
      expect(JSON.stringify(events)).not.toContain(token);
      expect(JSON.stringify(events)).not.toContain(JSON.stringify(args));
    } finally {
      await server.stop();
    }
  });
});
