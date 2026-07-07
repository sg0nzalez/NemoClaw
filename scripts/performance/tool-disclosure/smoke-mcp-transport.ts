// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const PERFORMANCE_SMOKE_MCP_URL_ENV = "NEMOCLAW_TOOL_DISCLOSURE_PERFORMANCE_MCP_URL";
export const PERFORMANCE_SMOKE_MCP_PORT_ENV = "NEMOCLAW_TOOL_DISCLOSURE_PERFORMANCE_MCP_PORT";

export type PerformanceSmokeMcpTransport =
  | { kind: "local-quick-tunnel" }
  | { kind: "external-ssh-forward"; mcpUrl: string; listenPort: number };

function externalMcpUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/mcp" ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/u.test(url.hostname)
  ) {
    throw new Error("external performance smoke MCP URL must be an exact trycloudflare /mcp URL");
  }
  return url.toString();
}

export function resolvePerformanceSmokeMcpTransport(
  env: NodeJS.ProcessEnv = process.env,
): PerformanceSmokeMcpTransport {
  const rawUrl = env[PERFORMANCE_SMOKE_MCP_URL_ENV]?.trim() ?? "";
  const rawPort = env[PERFORMANCE_SMOKE_MCP_PORT_ENV]?.trim() ?? "";
  if (!rawUrl && !rawPort) return { kind: "local-quick-tunnel" };
  if (!rawUrl || !rawPort) {
    throw new Error("external performance smoke MCP URL and port must be configured together");
  }
  if (!/^[0-9]{1,5}$/u.test(rawPort)) {
    throw new Error("external performance smoke MCP port must be an integer");
  }
  const listenPort = Number(rawPort);
  if (listenPort < 1_024 || listenPort > 65_535) {
    throw new Error("external performance smoke MCP port must be between 1024 and 65535");
  }
  return {
    kind: "external-ssh-forward",
    mcpUrl: externalMcpUrl(rawUrl),
    listenPort,
  };
}

export async function waitForPerformanceSmokeMcpEndpoint(
  mcpUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(mcpUrl, {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      if (response.status === 405) return;
    } catch {
      // The relay and server handoff are allowed a short convergence window.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("performance smoke MCP endpoint did not become ready before the timeout");
}
