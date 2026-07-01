// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ollama auth proxy status-file IPC (#6014).
//
// The auth proxy runs as a detached Node child with `stdio: "ignore"`, so
// stderr is not observable from the parent. The proxy writes a structured
// exit reason to a JSON status file before any non-zero exit and removes it
// on a successful listen. The host reads the file when the readiness loop
// finds the proxy gone and renders a specific actionable remediation
// message.
//
// Extracted from proxy.ts per #6014 monolith-growth guardrail: the IPC
// protocol and the remediation rendering are self-contained and belong
// with the proxy script's own contract, not co-mingled with the token /
// PID / process lifecycle logic that proxy.ts otherwise owns.

const fs = require("fs");
const { OLLAMA_PORT } = require("../../core/ports");

export type ProxyExitStatus = {
  reason: string;
  details?: string;
  exitedAt?: number;
};

/**
 * Read the structured exit status the proxy script writes to `statusPath`
 * before a non-zero exit. Returns null when the file is absent or
 * unparseable so the caller can fall back to the generic
 * "exited during startup" remediation the host already prints for
 * pre-existing failure modes.
 */
export function readProxyExitStatus(statusPath: string): ProxyExitStatus | null {
  let raw: string;
  try {
    raw = fs.readFileSync(statusPath, "utf8");
  } catch (err) {
    // ENOENT is the expected "proxy started cleanly and did not write" case.
    // Any other read failure (EACCES on a container with tight file
    // permissions, EPERM under a strict sandbox) is treated the same:
    // there is no structured reason to surface, so fall back.
    void err;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.reason === "string") {
      return {
        reason: parsed.reason,
        details: typeof parsed.details === "string" ? parsed.details : undefined,
        exitedAt: typeof parsed.exitedAt === "number" ? parsed.exitedAt : undefined,
      };
    }
  } catch {
    // Unparseable — fall through to null so the caller renders the
    // generic remediation instead.
  }
  return null;
}

/**
 * Best-effort removal of a stale status file. Called before spawning a new
 * proxy so a later read after this spawn sees the new proxy's exit reason
 * (or finds no file when the new proxy starts cleanly), never a leftover
 * reason from a previous run.
 */
export function clearStaleProxyStatus(statusPath: string): void {
  try {
    fs.unlinkSync(statusPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Same as writeExitStatus in the proxy script itself: this is hint
      // metadata, not load-bearing. Log through the parent's own console
      // only when the failure is not the expected absent-file case.
      console.warn(
        `  Warning: could not clear stale proxy status file at ${statusPath}: ` +
          `${(err as NodeJS.ErrnoException).message}`,
      );
    }
  }
}

/**
 * Render proxy startup-failure remediation. When the proxy script wrote a
 * structured reason (e.g. backend-not-loopback per #6014), surface a
 * specific actionable message. Otherwise return false so the caller falls
 * back to its existing owner-or-port remediation.
 */
export function printProxyStartupReason(status: ProxyExitStatus | null): boolean {
  if (status === null) return false;
  if (status.reason === "backend-not-loopback") {
    console.error("  Error: Ollama auth proxy refused to start.");
    console.error(
      `  Ollama is reachable on a non-loopback interface on the host (${
        status.details || "see proxy log"
      }), which would bypass the proxy's token check entirely.`,
    );
    console.error(
      `  Remediation: bind Ollama to loopback only. On Linux, set OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} ` +
        "in the Ollama systemd unit's [Service] section. On other platforms, set OLLAMA_HOST=127.0.0.1 " +
        "in the launcher's environment before starting Ollama.",
    );
    return true;
  }
  console.error(`  Error: Ollama auth proxy exited during startup: ${status.reason}`);
  if (status.details) console.error(`  Details: ${status.details}`);
  return true;
}
