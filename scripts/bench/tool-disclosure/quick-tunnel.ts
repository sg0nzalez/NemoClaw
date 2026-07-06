// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";

const ORIGIN_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s"'\\/])/iu;
// Deliberately omit HOME/XDG_CONFIG_HOME so cloudflared cannot load ambient
// account credentials or configuration into this ephemeral benchmark tunnel.
const SAFE_ENV = new Set([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export interface QuickTunnel {
  origin: string;
  mcpUrl: string;
  close(): Promise<void>;
}

export function parseQuickTunnelOrigin(text: string): string | null {
  return text.match(ORIGIN_PATTERN)?.[0] ?? null;
}

export function buildQuickTunnelArgs(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("quick-tunnel origin port must be between 1 and 65535");
  }
  return [
    "tunnel",
    "--no-autoupdate",
    "--protocol",
    "http2",
    "--url",
    `http://127.0.0.1:${port}`,
    "--loglevel",
    "info",
  ];
}

function subprocessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (SAFE_ENV.has(name) || name.startsWith("LC_"))) {
      selected[name] = value;
    }
  }
  return selected;
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process exited between the state check and signal.
      }
    }, 5_000);
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function probe(origin: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${origin}/mcp`, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return response.status === 405;
  } catch {
    return false;
  }
}

export async function startQuickTunnel(options: {
  port: number;
  binary?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<QuickTunnel> {
  const child = spawn(options.binary ?? "cloudflared", buildQuickTunnelArgs(options.port), {
    detached: false,
    env: subprocessEnv(options.env ?? process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeoutMs = options.timeoutMs ?? 45_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  let origin: string | null = null;
  let carry = "";
  let spawnError: Error | undefined;
  const inspect = (chunk: Buffer | string): void => {
    const candidate = `${carry}${chunk.toString()}`;
    origin ??= parseQuickTunnelOrigin(candidate);
    carry = candidate.slice(-512);
  };
  child.stdout?.on("data", inspect);
  child.stderr?.on("data", inspect);
  child.once("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) break;
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (origin && (await probe(origin, fetchImpl))) {
      const published = origin;
      return {
        origin: published,
        mcpUrl: `${published}/mcp`,
        close: () => stopChild(child),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stopChild(child);
  if (spawnError) throw new Error(`cloudflared quick tunnel failed to start (${spawnError.name})`);
  throw new Error("cloudflared quick tunnel did not become ready before the timeout");
}
