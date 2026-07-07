// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  PERFORMANCE_SMOKE_MCP_PORT_ENV,
  PERFORMANCE_SMOKE_MCP_URL_ENV,
  resolvePerformanceSmokeMcpTransport,
  waitForPerformanceSmokeMcpEndpoint,
} from "../../scripts/performance/tool-disclosure/smoke-mcp-transport";

function externalEnv(url = "https://forwarded-smoke-123.trycloudflare.com/mcp") {
  return {
    [PERFORMANCE_SMOKE_MCP_URL_ENV]: url,
    [PERFORMANCE_SMOKE_MCP_PORT_ENV]: "43117",
  };
}

describe("tool-disclosure performance smoke MCP transport", () => {
  it("uses the local quick tunnel when no external transport is configured", () => {
    expect(resolvePerformanceSmokeMcpTransport({})).toEqual({ kind: "local-quick-tunnel" });
  });

  it("accepts only a paired exact external tunnel URL and loopback listener port", () => {
    expect(resolvePerformanceSmokeMcpTransport(externalEnv())).toEqual({
      kind: "external-ssh-forward",
      mcpUrl: "https://forwarded-smoke-123.trycloudflare.com/mcp",
      listenPort: 43117,
    });
    expect(() =>
      resolvePerformanceSmokeMcpTransport({
        [PERFORMANCE_SMOKE_MCP_URL_ENV]: externalEnv()[PERFORMANCE_SMOKE_MCP_URL_ENV],
      }),
    ).toThrow("configured together");
  });

  it.each([
    "http://forwarded-smoke-123.trycloudflare.com/mcp",
    "https://forwarded-smoke-123.trycloudflare.com/other",
    "https://forwarded-smoke-123.trycloudflare.com/mcp?token=x",
    "https://user:pass@forwarded-smoke-123.trycloudflare.com/mcp",
    "https://forwarded-smoke-123.trycloudflare.com.attacker.invalid/mcp",
  ])("rejects unsafe external URL %s", (url) => {
    expect(() => resolvePerformanceSmokeMcpTransport(externalEnv(url))).toThrow(
      "exact trycloudflare /mcp URL",
    );
  });

  it.each(["0", "1023", "65536", "12x"])("rejects unsafe external listener port %s", (port) => {
    expect(() =>
      resolvePerformanceSmokeMcpTransport({
        ...externalEnv(),
        [PERFORMANCE_SMOKE_MCP_PORT_ENV]: port,
      }),
    ).toThrow(/port/);
  });

  it("waits through relay handoff responses until the MCP endpoint is ready", async () => {
    const statuses = [502, 405];
    await expect(
      waitForPerformanceSmokeMcpEndpoint("https://forwarded-smoke-123.trycloudflare.com/mcp", {
        fetchImpl: (() =>
          Promise.resolve(new Response(null, { status: statuses.shift() ?? 405 }))) as typeof fetch,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
  });
});
