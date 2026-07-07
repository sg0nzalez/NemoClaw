// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildQuickTunnelArgs,
  buildQuickTunnelEnvironment,
  parseQuickTunnelOrigin,
  startQuickTunnel,
} from "../../scripts/performance/tool-disclosure/quick-tunnel";

describe("tool-disclosure quick tunnel", () => {
  it("extracts only a bounded trycloudflare origin", () => {
    expect(
      parseQuickTunnelOrigin(
        "INF Requesting new quick Tunnel https://performance-test-123.trycloudflare.com",
      ),
    ).toBe("https://performance-test-123.trycloudflare.com");
    expect(parseQuickTunnelOrigin("https://example.com/secret")).toBeNull();
  });

  it("uses the latest origin when cloudflared reports more than one", () => {
    expect(
      parseQuickTunnelOrigin(
        "old https://stale-123.trycloudflare.com\nnew https://current-456.trycloudflare.com\n",
      ),
    ).toBe("https://current-456.trycloudflare.com");
  });

  it("omits ambient Cloudflare account configuration from the subprocess", () => {
    expect(
      buildQuickTunnelEnvironment(
        {
          PATH: "/usr/bin",
          HOME: "/home/operator",
          XDG_CONFIG_HOME: "/home/operator/.config",
          LC_ALL: "C.UTF-8",
        },
        "/tmp/isolated-cloudflared-home",
      ),
    ).toEqual({
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HOME: "/tmp/isolated-cloudflared-home",
      XDG_CONFIG_HOME: "/tmp/isolated-cloudflared-home",
    });
  });

  it("builds a loopback origin command and rejects invalid ports", () => {
    expect(buildQuickTunnelArgs(31337)).toEqual([
      "tunnel",
      "--config=",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      "http://127.0.0.1:31337",
      "--loglevel",
      "info",
    ]);
    expect(() => buildQuickTunnelArgs(0)).toThrow("between 1 and 65535");
  });

  it("discovers a tunnel origin from the bounded child log and closes the child", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-quick-tunnel-test-"));
    const binary = path.join(fixture, "fake-cloudflared");
    fs.writeFileSync(
      binary,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s\\n' 'INF Requesting new quick Tunnel https://log-backed-123.trycloudflare.com' >&2",
        "trap 'exit 0' TERM INT",
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const tunnel = await startQuickTunnel({
        port: 31_337,
        binary,
        env: { PATH: process.env.PATH },
        fetchImpl: (async (input) => {
          expect(String(input)).toBe("https://log-backed-123.trycloudflare.com/mcp");
          return new Response(null, { status: 405 });
        }) as typeof fetch,
        timeoutMs: 5_000,
      });
      expect(tunnel.mcpUrl).toBe("https://log-backed-123.trycloudflare.com/mcp");
      await tunnel.close();
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
