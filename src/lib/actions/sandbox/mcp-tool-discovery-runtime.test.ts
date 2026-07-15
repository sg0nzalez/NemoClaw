// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createBoundedMcpFetch,
  enumerateMcpToolNames,
  MCP_TOOL_DISCOVERY_LIMITS,
  MCP_TOOL_DISCOVERY_PROTOCOL,
  safeToolDiscoveryErrorDetail,
  ToolDiscoveryRuntimeError,
} from "../../../../tools/mcp-tool-discovery-runtime/tool-discovery-core.ts";
import {
  MCP_TOOL_DISCOVERY_MAX_NAME_BYTES,
  MCP_TOOL_DISCOVERY_MAX_TOOLS,
  MCP_TOOL_DISCOVERY_RESULT_PROTOCOL,
} from "./mcp-bridge-tool-discovery";

describe("shared MCP tool discovery runtime", () => {
  it("enumerates every page and returns deterministic names only", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [{ name: "zeta", description: "discard me" }],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({ tools: [{ name: "alpha" }] });

    await expect(enumerateMcpToolNames(loadPage)).resolves.toEqual({
      ok: true,
      count: 2,
      tools: ["alpha", "zeta"],
      truncated: false,
    });
    expect(loadPage).toHaveBeenNthCalledWith(1, undefined);
    expect(loadPage).toHaveBeenNthCalledWith(2, "next");
  });

  it("fails closed on duplicate names and repeated cursors", async () => {
    await expect(
      enumerateMcpToolNames(async () => ({
        tools: [{ name: "same" }, { name: "same" }],
      })),
    ).rejects.toMatchObject({ code: "invalid-response" });

    let page = 0;
    await expect(
      enumerateMcpToolNames(async () => {
        page += 1;
        return { tools: [{ name: `tool-${page}` }], nextCursor: "repeat" };
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects empty, control-bearing, and overlong tool names", async () => {
    for (const name of [
      "",
      "bad\nname",
      "x".repeat(MCP_TOOL_DISCOVERY_LIMITS.maxToolNameBytes + 1),
    ]) {
      await expect(
        enumerateMcpToolNames(async () => ({ tools: [{ name }] })),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("returns an explicit partial failure at tool and page safety limits", async () => {
    const tools = Array.from({ length: MCP_TOOL_DISCOVERY_LIMITS.maxTools + 1 }, (_, index) => ({
      name: `tool-${String(index).padStart(3, "0")}`,
    }));
    await expect(enumerateMcpToolNames(async () => ({ tools }))).resolves.toMatchObject({
      ok: false,
      count: MCP_TOOL_DISCOVERY_LIMITS.maxTools,
      truncated: true,
      detail: expect.stringContaining("tool safety limit"),
    });

    let page = 0;
    await expect(
      enumerateMcpToolNames(async () => {
        page += 1;
        return { tools: [], nextCursor: `cursor-${page}` };
      }),
    ).resolves.toEqual({
      ok: false,
      count: 0,
      tools: [],
      truncated: true,
      detail: `tool discovery reached the ${MCP_TOOL_DISCOVERY_LIMITS.maxPages}-page safety limit`,
    });
  });

  it("rejects redirects and declared oversized responses before reading bodies", async () => {
    const deadline = AbortSignal.timeout(1_000);
    const redirectFetch = createBoundedMcpFetch(
      async () => new Response(null, { status: 307, headers: { location: "https://other/" } }),
      deadline,
    );
    await expect(redirectFetch("https://example.test/mcp")).rejects.toMatchObject({
      code: "redirect",
    });

    const oversizedFetch = createBoundedMcpFetch(
      async () =>
        new Response("small", {
          headers: {
            "content-length": String(MCP_TOOL_DISCOVERY_LIMITS.maxResponseBytes + 1),
          },
        }),
      deadline,
    );
    await expect(oversizedFetch("https://example.test/mcp")).rejects.toMatchObject({
      code: "response-too-large",
    });
  });

  it("maps failures to bounded details without echoing untrusted messages", () => {
    expect(safeToolDiscoveryErrorDetail(new ToolDiscoveryRuntimeError("redirect"))).toBe(
      "MCP endpoint redirect was rejected",
    );
    expect(
      safeToolDiscoveryErrorDetail(
        Object.assign(new Error("remote body contains Bearer secret-value"), { code: 401 }),
      ),
    ).toBe("MCP endpoint rejected tool discovery (HTTP 401)");
    expect(safeToolDiscoveryErrorDetail(new Error("Bearer secret-value"))).toBe(
      "MCP tool discovery request failed",
    );
  });

  it("keeps the host parser and image runtime on the same result limits", () => {
    expect(MCP_TOOL_DISCOVERY_RESULT_PROTOCOL).toBe(MCP_TOOL_DISCOVERY_PROTOCOL);
    expect(MCP_TOOL_DISCOVERY_MAX_TOOLS).toBe(MCP_TOOL_DISCOVERY_LIMITS.maxTools);
    expect(MCP_TOOL_DISCOVERY_MAX_NAME_BYTES).toBe(MCP_TOOL_DISCOVERY_LIMITS.maxToolNameBytes);
  });
});
