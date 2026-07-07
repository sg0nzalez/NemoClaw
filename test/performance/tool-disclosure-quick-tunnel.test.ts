// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildQuickTunnelArgs,
  buildQuickTunnelEnvironment,
  parseQuickTunnelOrigin,
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
});
