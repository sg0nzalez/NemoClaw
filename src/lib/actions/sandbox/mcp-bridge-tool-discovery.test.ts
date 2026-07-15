// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry } from "../../state/registry";
import {
  buildMcpToolDiscoveryCommand,
  classifyMcpToolDiscoveryResult,
  MCP_TOOL_DISCOVERY_RUNTIME_PATH,
  toolDiscoveryReadinessSkipDetail,
} from "./mcp-bridge-tool-discovery";

const marker = "__NEMOCLAW_SANDBOX_EXEC_STARTED___0123456789abcdef0123456789abcdef";
const entry = {
  server: "github",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
} as McpBridgeEntry;

function framedResult(value: unknown) {
  return {
    status: 0,
    stdout: `${marker}\n${JSON.stringify(value)}`,
    stderr: "",
  };
}

describe("MCP tool discovery host boundary (#6901)", () => {
  it("launches the same shared runtime below every adapter policy ancestor", () => {
    const expectedAncestor: Record<AgentMcpAdapter, string> = {
      mcporter: "nemoclaw-start node -e",
      "hermes-config": "/opt/hermes/.venv/bin/python -c",
      "deepagents-config": "/opt/venv/bin/python3 -c",
    };

    for (const adapter of Object.keys(expectedAncestor) as AgentMcpAdapter[]) {
      const built = buildMcpToolDiscoveryCommand(entry, adapter);
      expect(built).not.toBeNull();
      expect(built?.command).toContain(expectedAncestor[adapter]);
      expect(built?.command).toContain(MCP_TOOL_DISCOVERY_RUNTIME_PATH);
      expect(built?.command).toContain("--experimental-strip-types");
      expect(built?.command).toContain("openshell:resolve:env:GITHUB_TOKEN");
      expect(built?.command).not.toContain("tools/call");
      expect(built?.command).toContain("rebuild the sandbox");
    }
  });

  it("refuses command construction without a credential binding or canonical URL", () => {
    expect(buildMcpToolDiscoveryCommand({ ...entry, env: [] }, "mcporter")).toBeNull();
    expect(
      buildMcpToolDiscoveryCommand(
        { ...entry, url: "https://api.githubcopilot.com:443/mcp/" },
        "mcporter",
      ),
    ).toBeNull();
  });

  it("accepts one framed, deterministic, names-only runtime result", () => {
    expect(
      classifyMcpToolDiscoveryResult(
        framedResult({
          protocol: 1,
          ok: true,
          count: 2,
          tools: ["alpha", "zeta"],
          truncated: false,
        }),
        entry,
        marker,
      ),
    ).toEqual({
      ok: true,
      count: 2,
      tools: ["alpha", "zeta"],
      truncated: false,
    });
  });

  it("fails closed on malformed, duplicate, unsorted, or unframed results", () => {
    for (const result of [
      framedResult({ protocol: 1, ok: true, count: 1, tools: ["bad\nname"], truncated: false }),
      framedResult({
        protocol: 1,
        ok: true,
        count: 2,
        tools: ["same", "same"],
        truncated: false,
      }),
      framedResult({
        protocol: 1,
        ok: true,
        count: 2,
        tools: ["zeta", "alpha"],
        truncated: false,
      }),
      { status: 0, stdout: JSON.stringify({ protocol: 1 }), stderr: "" },
    ]) {
      expect(classifyMcpToolDiscoveryResult(result, entry, marker)).toMatchObject({
        ok: false,
        count: 0,
        tools: [],
      });
    }
  });

  it("does not surface process output when the image runtime cannot start", () => {
    const result = classifyMcpToolDiscoveryResult(
      {
        status: 1,
        stdout: `${marker}\nBearer should-not-leak`,
        stderr: "authorization: should-not-leak",
      },
      entry,
      marker,
    );
    expect(result.detail).toContain("rebuild the sandbox");
    expect(JSON.stringify(result)).not.toContain("should-not-leak");
  });

  it("gates network traffic on the existing policy and provider readiness", () => {
    expect(
      toolDiscoveryReadinessSkipDetail({
        policyGatewayPresent: false,
        providerAttached: true,
        providerCredentialReady: true,
      }),
    ).toContain("policy does not match");
    expect(
      toolDiscoveryReadinessSkipDetail({
        policyGatewayPresent: true,
        providerAttached: false,
        providerCredentialReady: true,
      }),
    ).toContain("provider is not attached");
    expect(
      toolDiscoveryReadinessSkipDetail({
        policyGatewayPresent: true,
        providerAttached: true,
        providerCredentialReady: false,
      }),
    ).toContain("does not match");
    expect(
      toolDiscoveryReadinessSkipDetail({
        policyGatewayPresent: true,
        providerAttached: true,
        providerCredentialReady: true,
      }),
    ).toBeUndefined();
  });
});
