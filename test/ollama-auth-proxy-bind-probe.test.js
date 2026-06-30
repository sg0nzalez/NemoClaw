// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// #6014 first PR: cover the loopback bind probe inside the Ollama auth proxy.
// The probe is the proxy's independent guard against an Ollama daemon listening
// on a non-loopback interface (which would bypass the proxy's token check).

import { describe, expect, it } from "vitest";
import {
  parseProcNetTcpListeners,
  isLoopbackProcAddress,
  probeLinuxLoopbackBind,
  IPV4_LOOPBACK_PROC,
  IPV6_LOOPBACK_PROC,
  IPV6_MAPPED_IPV4_LOOPBACK_PROC,
  EXIT_BACKEND_NOT_LOOPBACK,
} from "../scripts/ollama-auth-proxy.js";

// /proc/net/tcp header + one row template. Hex port 0x2CAA = 11434.
const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
function tcpRow(localAddrColonPort, state) {
  return `   0: ${localAddrColonPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`;
}

describe("parseProcNetTcpListeners bind probe (#6014)", () => {
  it("returns a listener for a LISTEN state row matching the port", () => {
    const text = HEADER + tcpRow("0100007F:2CAA", "0A");
    const listeners = parseProcNetTcpListeners(text, 11434);
    expect(listeners).toEqual([{ address: "0100007F", port: 11434 }]);
  });

  it("skips rows whose state is not LISTEN (0A)", () => {
    // 01 = ESTABLISHED, 0B = CLOSING; neither should appear as a listener
    const text = HEADER + tcpRow("0100007F:2CAA", "01") + "\n" + tcpRow("0100007F:2CAA", "0B");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([]);
  });

  it("skips rows whose port does not match", () => {
    // 0x2BB7 = 11191
    const text = HEADER + tcpRow("0100007F:2BB7", "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([]);
  });

  it("returns address uppercased so loopback comparison is canonical", () => {
    const text = HEADER + tcpRow("0100007f:2CAA", "0A");
    const [listener] = parseProcNetTcpListeners(text, 11434);
    expect(listener.address).toBe("0100007F");
  });

  it("ignores blank and malformed lines without throwing", () => {
    const text = HEADER + "\n\n" + "   garbage line\n" + tcpRow("0100007F:2CAA", "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([{ address: "0100007F", port: 11434 }]);
  });

  it("returns multiple listeners when several LISTEN rows match the port", () => {
    const text = HEADER + tcpRow("0100007F:2CAA", "0A") + "\n" + tcpRow("00000000:2CAA", "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([
      { address: "0100007F", port: 11434 },
      { address: "00000000", port: 11434 },
    ]);
  });
});

describe("isLoopbackProcAddress bind probe (#6014)", () => {
  it("accepts the canonical IPv4 loopback encoding (127.0.0.1)", () => {
    expect(isLoopbackProcAddress(IPV4_LOOPBACK_PROC)).toBe(true);
  });

  it("accepts the canonical IPv6 loopback encoding (::1)", () => {
    expect(isLoopbackProcAddress(IPV6_LOOPBACK_PROC)).toBe(true);
  });

  it("accepts IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    expect(isLoopbackProcAddress(IPV6_MAPPED_IPV4_LOOPBACK_PROC)).toBe(true);
  });

  it("rejects IPv4 wildcard 0.0.0.0", () => {
    expect(isLoopbackProcAddress("00000000")).toBe(false);
  });

  it("rejects a non-loopback IPv4 address (e.g. 10.0.0.1)", () => {
    // 10.0.0.1 little-endian hex = 0100000A
    expect(isLoopbackProcAddress("0100000A")).toBe(false);
  });

  it("rejects an IPv6 wildcard (all zeros)", () => {
    expect(isLoopbackProcAddress("00000000000000000000000000000000")).toBe(false);
  });
});

// The integration of parse + classify into probeLinuxLoopbackBind is what the
// proxy actually calls. We can't easily fake /proc here without monkeypatching
// fs.readFileSync, so we cover the integration by reading the host's REAL
// /proc/net/tcp on Linux and asserting structure-only invariants (no port
// filter side-effects). On non-Linux the probe returns null by design.
describe("probeLinuxLoopbackBind bind probe (#6014)", () => {
  it.skipIf(process.platform !== "linux")(
    "returns an ok result for a port with no listeners (e.g. very high unused port)",
    () => {
      // Port 64321 is high enough that no daemon is realistically listening.
      const result = probeLinuxLoopbackBind(64321);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(true);
      expect(result.listeners).toEqual([]);
    },
  );

  it.skipIf(process.platform === "linux")(
    "returns null on non-Linux platforms (caller falls back to lsof)",
    () => {
      expect(probeLinuxLoopbackBind(11434)).toBeNull();
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
