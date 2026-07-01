// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// #6014 first PR: cover the loopback bind probe inside the Ollama auth proxy.
// The probe is the proxy's independent guard against an Ollama daemon listening
// on a non-loopback interface (which would bypass the proxy's token check).

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The proxy script is plain CommonJS. Require it directly so tests can cover
// the exported helpers without spawning the proxy as a subprocess.
type ProbeResult = { ok: boolean; listeners: Array<{ address: string; port: number }> } | null;
type ProxyExports = {
  parseProcNetTcpListeners: (
    text: string,
    port: number,
  ) => Array<{ address: string; port: number }>;
  isLoopbackProcAddress: (addr: string) => boolean;
  probeLinuxLoopbackBind: (port: number) => ProbeResult;
  EXIT_BACKEND_NOT_LOOPBACK: number;
};
const proxyExports = require("../scripts/ollama-auth-proxy.js") as ProxyExports;
const {
  parseProcNetTcpListeners,
  isLoopbackProcAddress,
  probeLinuxLoopbackBind,
  EXIT_BACKEND_NOT_LOOPBACK,
} = proxyExports;

// /proc/net/tcp header + one row template. Hex port 0x2CAA = 11434.
const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
function tcpRow(localAddrColonPort: string, state: string): string {
  return `   0: ${localAddrColonPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`;
}

// Independent fixtures (CR: do not reuse the production constants under test).
// IPv4 127.0.0.1 in /proc/net/tcp little-endian hex: bytes 7F 00 00 01 -> 0100007F.
const FIX_IPV4_LOOPBACK_1 = "0100007F";
// IPv4 127.0.0.42 -- also loopback (127.0.0.0/8) -- bytes 7F 00 00 2A -> 2A00007F.
const FIX_IPV4_LOOPBACK_42 = "2A00007F";
// IPv4 0.0.0.0 wildcard -- NOT loopback -- bytes 00 00 00 00 -> 00000000.
const FIX_IPV4_WILDCARD = "00000000";
// IPv4 10.0.0.1 -- NOT loopback -- bytes 0A 00 00 01 -> 0100000A.
const FIX_IPV4_NON_LOOPBACK = "0100000A";
// IPv6 ::1 in /proc/net/tcp6 per-group little-endian:
//   bytes 00..00 (12) + 00 00 00 01, grouped by 4 and byte-reversed inside each
//   group: 00000000 00000000 00000000 01000000.
const FIX_IPV6_LOOPBACK = "00000000000000000000000001000000";
// IPv6 ::ffff:127.0.0.1 (IPv4-mapped) per-group little-endian:
//   bytes 00..00 (10) + FF FF + 7F 00 00 01, grouped and reversed:
//   00000000 00000000 FFFF0000 0100007F.
const FIX_IPV6_MAPPED_LOOPBACK_1 = "00000000000000000000FFFF0100007F";
// IPv6 ::ffff:127.0.0.9 (also loopback under 127.0.0.0/8): 0900007F suffix.
const FIX_IPV6_MAPPED_LOOPBACK_9 = "00000000000000000000FFFF0900007F";
// IPv6 wildcard (all zeros) -- NOT loopback.
const FIX_IPV6_WILDCARD = "00000000000000000000000000000000";

describe("parseProcNetTcpListeners bind probe (#6014)", () => {
  it("returns a listener for a LISTEN state row matching the port", () => {
    const text = HEADER + tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0A");
    const listeners = parseProcNetTcpListeners(text, 11434);
    expect(listeners).toEqual([{ address: FIX_IPV4_LOOPBACK_1, port: 11434 }]);
  });

  it("skips rows whose state is not LISTEN (0A)", () => {
    // 01 = ESTABLISHED, 0B = CLOSING; neither should appear as a listener
    const text =
      HEADER +
      tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "01") +
      "\n" +
      tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0B");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([]);
  });

  it("skips rows whose port does not match", () => {
    // 0x2BB7 = 11191
    const text = HEADER + tcpRow(`${FIX_IPV4_LOOPBACK_1}:2BB7`, "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([]);
  });

  it("returns address uppercased so loopback comparison is canonical", () => {
    const text = HEADER + tcpRow("0100007f:2CAA", "0A");
    const [listener] = parseProcNetTcpListeners(text, 11434);
    expect(listener.address).toBe(FIX_IPV4_LOOPBACK_1);
  });

  it("ignores blank and malformed lines without throwing", () => {
    const text =
      HEADER + "\n\n" + "   garbage line\n" + tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([
      { address: FIX_IPV4_LOOPBACK_1, port: 11434 },
    ]);
  });

  it("returns multiple listeners when several LISTEN rows match the port", () => {
    const text =
      HEADER +
      tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0A") +
      "\n" +
      tcpRow(`${FIX_IPV4_WILDCARD}:2CAA`, "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([
      { address: FIX_IPV4_LOOPBACK_1, port: 11434 },
      { address: FIX_IPV4_WILDCARD, port: 11434 },
    ]);
  });
});

describe("isLoopbackProcAddress bind probe (#6014)", () => {
  it("accepts the canonical IPv4 loopback 127.0.0.1", () => {
    expect(isLoopbackProcAddress(FIX_IPV4_LOOPBACK_1)).toBe(true);
  });

  it("accepts every address in the 127.0.0.0/8 loopback block, not just 127.0.0.1", () => {
    // CR flagged the earlier implementation only accepted the single
    // 127.0.0.1 encoding. The full IPv4 loopback range is 127.0.0.0/8.
    expect(isLoopbackProcAddress(FIX_IPV4_LOOPBACK_42)).toBe(true);
  });

  it("accepts the canonical IPv6 loopback ::1", () => {
    expect(isLoopbackProcAddress(FIX_IPV6_LOOPBACK)).toBe(true);
  });

  it("accepts IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    expect(isLoopbackProcAddress(FIX_IPV6_MAPPED_LOOPBACK_1)).toBe(true);
  });

  it("accepts IPv4-mapped IPv6 addresses in the 127.0.0.0/8 block", () => {
    expect(isLoopbackProcAddress(FIX_IPV6_MAPPED_LOOPBACK_9)).toBe(true);
  });

  it("rejects IPv4 wildcard 0.0.0.0", () => {
    expect(isLoopbackProcAddress(FIX_IPV4_WILDCARD)).toBe(false);
  });

  it("rejects a non-loopback IPv4 address (e.g. 10.0.0.1)", () => {
    expect(isLoopbackProcAddress(FIX_IPV4_NON_LOOPBACK)).toBe(false);
  });

  it("rejects an IPv6 wildcard (all zeros)", () => {
    expect(isLoopbackProcAddress(FIX_IPV6_WILDCARD)).toBe(false);
  });
});

// Helpers kept at module scope so test bodies stay linear and free of
// conditional branching (per the repository's growth guardrail on new `if`
// statements in test files).
function bindEphemeralLoopback(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function closeServer(server: net.Server | null): Promise<void> {
  return new Promise((resolve) => {
    server === null ? resolve() : server.close(() => resolve());
  });
}

describe("probeLinuxLoopbackBind bind probe (#6014)", () => {
  let ephemeralServer: net.Server | null = null;
  let ephemeralPort = 0;

  beforeEach(async () => {
    // CR follow-up: do not assume a static port is unused. Bind an ephemeral
    // loopback listener the test controls, so the probe has a real listener
    // to observe.
    const { server, port } = await bindEphemeralLoopback();
    ephemeralServer = server;
    ephemeralPort = port;
  });

  afterEach(async () => {
    await closeServer(ephemeralServer);
    ephemeralServer = null;
  });

  it.skipIf(process.platform !== "linux")(
    "reports the ephemeral loopback server as an ok loopback listener",
    () => {
      const result = probeLinuxLoopbackBind(ephemeralPort);
      expect(result).not.toBeNull();
      const ok = result as NonNullable<typeof result>;
      expect(ok.ok).toBe(true);
      expect(ok.listeners.length).toBeGreaterThanOrEqual(1);
      expect(ok.listeners.every((l) => isLoopbackProcAddress(l.address))).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reports ok: true with empty listeners once the ephemeral server is closed",
    async () => {
      await closeServer(ephemeralServer);
      ephemeralServer = null;
      const result = probeLinuxLoopbackBind(ephemeralPort);
      expect(result).not.toBeNull();
      const ok = result as NonNullable<typeof result>;
      expect(ok.ok).toBe(true);
      expect(ok.listeners).toEqual([]);
    },
  );

  it.skipIf(process.platform === "linux")(
    "returns null on non-Linux platforms so the caller falls back to lsof",
    () => {
      expect(probeLinuxLoopbackBind(ephemeralPort)).toBeNull();
    },
  );
});

describe("public surface bind probe (#6014)", () => {
  it("exports EXIT_BACKEND_NOT_LOOPBACK as 2 (locked-in contract with the host CLI)", () => {
    // The host (src/lib/inference/ollama/proxy.ts) maps this code to a
    // specific remediation. Changing it would break the structured signal.
    expect(EXIT_BACKEND_NOT_LOOPBACK).toBe(2);
  });
});
