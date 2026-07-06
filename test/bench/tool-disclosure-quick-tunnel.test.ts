// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildQuickTunnelArgs,
  parseQuickTunnelOrigin,
} from "../../scripts/bench/tool-disclosure/quick-tunnel";

describe("tool-disclosure quick tunnel", () => {
  it("extracts only a bounded trycloudflare origin", () => {
    expect(
      parseQuickTunnelOrigin("INF Requesting new quick Tunnel https://bench-123.trycloudflare.com"),
    ).toBe("https://bench-123.trycloudflare.com");
    expect(parseQuickTunnelOrigin("https://example.com/secret")).toBeNull();
  });

  it("builds a loopback origin command and rejects invalid ports", () => {
    expect(buildQuickTunnelArgs(31337)).toEqual([
      "tunnel",
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
