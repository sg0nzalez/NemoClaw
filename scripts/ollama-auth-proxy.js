#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticated reverse proxy for Ollama.
 *
 * Ollama has no built-in authentication. This proxy sits in front of it,
 * validating a Bearer token before forwarding requests. Ollama binds to
 * 127.0.0.1 (localhost only) while the proxy listens on 0.0.0.0 so the
 * OpenShell gateway (running in a container) can reach it.
 *
 * Env:
 *   OLLAMA_PROXY_TOKEN  — required, the Bearer token to validate
 *   OLLAMA_PROXY_PORT   — listen port (default: 11435)
 *   OLLAMA_BACKEND_PORT — Ollama port on localhost (default: 11434)
 */

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");

/**
 * Best-effort write of a structured exit reason for the host CLI to read
 * when proxy startup fails. The host (src/lib/inference/ollama/proxy.ts)
 * renders specific remediation messages based on `reason`.
 */
function writeExitStatus(reason, details) {
  const statusFile = process.env.NEMOCLAW_OLLAMA_PROXY_STATUS_FILE;
  if (!statusFile) return;
  try {
    const payload = JSON.stringify({
      reason,
      details: details || undefined,
      exitedAt: Math.floor(Date.now() / 1000),
    });
    fs.writeFileSync(statusFile, payload);
  } catch {
    // Status file is best-effort; the proxy still exits with the right code
    // so the host's port-conflict fall-back path can render a generic
    // remediation. Don't crash the proxy because we couldn't write a hint.
  }
}

function clearExitStatus() {
  const statusFile = process.env.NEMOCLAW_OLLAMA_PROXY_STATUS_FILE;
  if (!statusFile) return;
  try {
    fs.unlinkSync(statusFile);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      // Same as writeExitStatus: don't crash, this is hint metadata.
    }
  }
}

// Exit code 2 is reserved for "backend listening on a non-loopback interface"
// so the host-side startOllamaAuthProxy() can render an Ollama-specific
// remediation pointing the operator at OLLAMA_HOST=127.0.0.1.
const EXIT_BACKEND_NOT_LOOPBACK = 2;

// Reference encoding for the exact `127.0.0.1` IPv4 address in
// /proc/net/tcp: bytes 7F 00 00 01, little-endian per column ->
// hex "0100007F". IPv4 loopback is the full 127.0.0.0/8 block though, so
// the classifier below matches on the leading (post-reverse) byte being
// 7F instead of an exact string match. This constant is kept as an
// unambiguous fixture for tests and callers that want to compare against a
// specific example rather than a range.
const IPV4_LOOPBACK_PROC = "0100007F";
// IPv6 loopback (::1) in /proc/net/tcp6 encoding. The 16-byte address is
// split into four 32-bit groups; each group's four bytes are emitted in
// little-endian order. ::1 bytes = 00..00 00..01 -> groups reversed become
// 00000000:00000000:00000000:01000000, concatenated.
const IPV6_LOOPBACK_PROC = "00000000000000000000000001000000";
// IPv4-mapped IPv6 loopback (::ffff:127.0.0.1). Bytes:
//   00 00 00 00 00 00 00 00 00 00 FF FF 7F 00 00 01
// Grouped and byte-reversed per column ->
//   00000000 : 00000000 : FFFF0000 : 0100007F
// (Earlier encoding "0000000000000000FFFF00007F000001" was wrong; it
// interpreted the last two groups without the per-column reverse, which
// would never appear in real /proc/net/tcp6 output.)
const IPV6_MAPPED_IPV4_LOOPBACK_PROC = "00000000000000000000FFFF0100007F";

/**
 * Parse a /proc/net/tcp{,6} table and return every LISTEN socket whose local
 * port matches `port`. Each returned entry is `{address, port}` where
 * address is the proc-encoded local address column (uppercased, no `:port`).
 *
 * /proc/net/tcp{,6} state column 0x0A = LISTEN.
 */
function parseProcNetTcpListeners(text, port) {
  const listeners = [];
  const lines = text.split("\n");
  // Skip header line.
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    // cols[1] = local_address:port, cols[3] = state.
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[3];
    if (state !== "0A") continue;
    const sep = local.lastIndexOf(":");
    if (sep <= 0) continue;
    const addr = local.slice(0, sep).toUpperCase();
    const sockPort = parseInt(local.slice(sep + 1), 16);
    if (sockPort === port) listeners.push({ address: addr, port: sockPort });
  }
  return listeners;
}

function isLoopbackProcAddress(addr) {
  // IPv4 in /proc/net/tcp is a single 32-bit column emitted in little-endian
  // hex: the last two chars are the address's FIRST byte. 127.0.0.0/8
  // = anything whose first byte is 0x7F. Matching by suffix accepts every
  // valid loopback (127.0.0.1, 127.0.0.2, 127.42.13.99, etc.) instead of only
  // the single canonical 127.0.0.1. See CR feedback on #6054.
  if (addr.length === 8 && addr.endsWith("7F")) return true;
  // IPv6 has two loopback shapes:
  //   ::1                — exactly the 32-char IPV6_LOOPBACK_PROC encoding
  //   ::ffff:127.0.0.0/8 — IPv4-mapped IPv6, so the last 32-bit group's
  //                        little-endian first-byte must be 0x7F, and the
  //                        preceding three groups must be
  //                        00000000:00000000:FFFF0000
  if (addr === IPV6_LOOPBACK_PROC) return true;
  if (addr.length === 32 && addr.startsWith("00000000000000000000FFFF")) {
    const lastGroup = addr.slice(24);
    return lastGroup.endsWith("7F");
  }
  return false;
}

/**
 * Linux backend-bind probe via /proc/net/tcp + /proc/net/tcp6. Returns
 * { ok: true } when every listener on BACKEND_PORT is loopback,
 * { ok: false, listeners } when at least one is not, and null when /proc
 * is unavailable so the caller can fall back to the cross-platform probe.
 */
function probeLinuxLoopbackBind(port) {
  let v4Text = "";
  let v6Text = "";
  try {
    v4Text = fs.readFileSync("/proc/net/tcp", "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    v6Text = fs.readFileSync("/proc/net/tcp6", "utf8");
  } catch (err) {
    // tcp6 may be absent on IPv6-disabled kernels; treat as empty.
    if (err && err.code !== "ENOENT") throw err;
  }
  const listeners = [
    ...parseProcNetTcpListeners(v4Text, port),
    ...parseProcNetTcpListeners(v6Text, port),
  ];
  if (listeners.length === 0) return { ok: true, listeners };
  const nonLoopback = listeners.filter((l) => !isLoopbackProcAddress(l.address));
  return { ok: nonLoopback.length === 0, listeners, nonLoopback };
}

/**
 * Cross-platform fallback using `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
 * Returns { ok, listeners } in the same shape as the Linux probe, or null
 * when lsof is unavailable so the caller can render a degraded warning.
 */
function probeLsofLoopbackBind(port) {
  let stdout;
  try {
    stdout = execFileSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-F", "n"], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.status === 1)) return null;
    return null;
  }
  const listeners = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.startsWith("n")) continue;
    // lsof -F n field looks like `n*:11434` or `n127.0.0.1:11434` or
    // `n[::1]:11434`. Extract the address up to the final ':<port>'.
    const body = raw.slice(1);
    const sep = body.lastIndexOf(":");
    if (sep <= 0) continue;
    const addr = body.slice(0, sep);
    listeners.push({ address: addr, port });
  }
  const isLoopback = (a) => a === "127.0.0.1" || a === "[::1]" || a === "::1" || a === "localhost";
  if (listeners.length === 0) return { ok: true, listeners };
  const nonLoopback = listeners.filter((l) => !isLoopback(l.address));
  return { ok: nonLoopback.length === 0, listeners, nonLoopback };
}

function assertBackendBoundToLoopback(port) {
  if (process.env.NEMOCLAW_OLLAMA_PROXY_SKIP_BIND_PROBE === "1") return;
  let result = process.platform === "linux" ? probeLinuxLoopbackBind(port) : null;
  if (result === null) {
    result = probeLsofLoopbackBind(port);
  }
  if (result === null) {
    // Probe is unavailable on this host (no /proc, no lsof). Don't fail
    // closed — the proxy is still useful — but log so an operator scanning
    // logs can see the boundary check did not run. The systemd drop-in
    // (Linux only) remains the primary enforcement on Linux; non-Linux
    // topologies still rely on the operator-supplied bind today (#6014).
    console.warn(
      `Ollama auth proxy: backend-bind probe unavailable, ` +
        `unable to verify Ollama is bound to loopback on port ${port}`,
    );
    return;
  }
  if (result.ok) return;
  const labels = (result.nonLoopback || result.listeners || [])
    .map((l) => `${l.address}:${l.port}`)
    .join(", ");
  console.error(
    `Ollama auth proxy: backend on port ${port} is NOT bound to loopback ` +
      `(found ${labels || "non-loopback listener"}). ` +
      `Refusing to start: an Ollama daemon reachable on a non-loopback ` +
      `interface bypasses the proxy's token check entirely. ` +
      `Set OLLAMA_HOST=127.0.0.1:${port} on the Ollama systemd unit or ` +
      `set NEMOCLAW_OLLAMA_PROXY_SKIP_BIND_PROBE=1 to override (not recommended).`,
  );
  writeExitStatus("backend-not-loopback", labels || "non-loopback listener");
  process.exit(EXIT_BACKEND_NOT_LOOPBACK);
}

function buildProxyServer(token, backendPort) {
  const expectedBuf = Buffer.from(`Bearer ${token}`);
  return http.createServer((clientReq, clientRes) => {
    // Every request must present a valid Bearer token. The proxy binds 0.0.0.0
    // so the OpenShell sandbox container can reach it via the docker bridge —
    // which also means anything else with network reach to the host could,
    // so unauthenticated requests are uniformly rejected (no health-check
    // bypass for /api/tags). DevTest T5987914: "calls without
    // Authorization: Bearer TOKEN should NOT return 200." See #3338.
    // Compare buffers, not JS strings: a non-ASCII Authorization header
    // can have the same .length as the expected string but a different byte
    // length, which would make crypto.timingSafeEqual throw and crash the
    // proxy (it binds 0.0.0.0). Build buffers first, gate timingSafeEqual on
    // matching byte length.
    const auth = clientReq.headers.authorization;
    const authBuf = typeof auth === "string" ? Buffer.from(auth) : null;
    const tokenMatch =
      authBuf !== null &&
      authBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(authBuf, expectedBuf);
    if (!tokenMatch) {
      clientRes.writeHead(401, { "Content-Type": "text/plain" });
      clientRes.end("Unauthorized");
      return;
    }

    // Strip the auth header before forwarding to Ollama
    const headers = { ...clientReq.headers };
    delete headers.authorization;
    delete headers.host;

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: backendPort,
        path: clientReq.url,
        method: clientReq.method,
        headers,
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      },
    );

    proxyReq.on("error", (err) => {
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
      clientRes.end(`Ollama backend error: ${err.message}`);
    });

    clientReq.pipe(proxyReq);
  });
}

function main() {
  const TOKEN = process.env.OLLAMA_PROXY_TOKEN;
  if (!TOKEN) {
    console.error("OLLAMA_PROXY_TOKEN required");
    process.exit(1);
  }

  const LISTEN_PORT = parseInt(process.env.OLLAMA_PROXY_PORT || "11435", 10);
  const BACKEND_PORT = parseInt(process.env.OLLAMA_BACKEND_PORT || "11434", 10);

  assertBackendBoundToLoopback(BACKEND_PORT);

  const server = buildProxyServer(TOKEN, BACKEND_PORT);

  // The proxy binds 0.0.0.0, so an unhandled listen error (most commonly
  // EADDRINUSE when the port is already taken) would crash with an uncaught
  // exception. Exit cleanly with a non-zero code instead; the host-side
  // startOllamaAuthProxy() detects the missing process and reports the port
  // owner with remediation. See #4820.
  server.on("error", (/** @type {NodeJS.ErrnoException} */ err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`Ollama auth proxy: port ${LISTEN_PORT} is already in use`);
      writeExitStatus("listen-port-conflict", `port ${LISTEN_PORT} in use`);
    } else {
      const msg = err && err.message ? err.message : String(err);
      console.error(`Ollama auth proxy failed to start: ${msg}`);
      writeExitStatus("listen-error", msg);
    }
    process.exit(1);
  });

  server.listen(LISTEN_PORT, "0.0.0.0", () => {
    // The proxy is healthy; clear any stale exit status so a later failed
    // restart's status file is not misread as the current proxy's failure.
    clearExitStatus();
    console.log(
      `Ollama auth proxy listening on 0.0.0.0:${LISTEN_PORT} -> 127.0.0.1:${BACKEND_PORT}`,
    );
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseProcNetTcpListeners,
  isLoopbackProcAddress,
  probeLinuxLoopbackBind,
  probeLsofLoopbackBind,
  IPV4_LOOPBACK_PROC,
  IPV6_LOOPBACK_PROC,
  IPV6_MAPPED_IPV4_LOOPBACK_PROC,
  EXIT_BACKEND_NOT_LOOPBACK,
};
