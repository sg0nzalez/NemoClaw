// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side Zalo ClawBot QR login orchestration.
//
// Drives the handshake end-to-end: request a session, render the QR, poll for
// confirmation, refresh on expiry, and return the captured credentials. Pure
// orchestration — the HTTP layer lives in ./qr.ts and the terminal renderer is
// injected so tests stay offline.

import {
  type FetchLike,
  pollZaloClawbotLoginStatus,
  requestZaloClawbotLogin,
  type ZaloClawbotLoginSession,
  ZaloClawbotQrError,
} from "./qr";

/** Total deadline for one login attempt — long enough for a slow human, short
 *  enough that a forgotten terminal eventually gives up. */
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000;

/** Pause between status polls (the upstream plugin polls at this cadence). */
const DEFAULT_POLL_INTERVAL_MS = 1_500;

/** Maximum QR refreshes per login before giving up. */
const MAX_QR_REFRESH_COUNT = 3;

export interface ZaloClawbotLoginCredentials {
  /** Bot token. Persist into OpenShell as the ZALOCLAWBOT_BOT_TOKEN provider
   *  credential; never write to disk in the clear. */
  token: string;
  /** Stable per-account id derived from botId; matches the on-disk account
   *  filename the upstream plugin reads. Non-secret. */
  accountId: string;
  /** Zalo bot id. Non-secret. */
  botId: string;
  /** Owner (the Zalo user who scanned). Non-secret but PII-adjacent. */
  ownerId?: string;
  /** Official-account id backing the bot. Non-secret. */
  oaId?: string;
}

export type ZaloClawbotLoginResult =
  | { kind: "ok"; credentials: ZaloClawbotLoginCredentials }
  | { kind: "timeout" }
  | { kind: "expired"; reason: "max_refresh_exceeded" }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

export interface ZaloClawbotLoginOptions {
  fetch?: FetchLike;
  /** Render a QR in the terminal. Defaults to qrcode-terminal. */
  renderQr?: (loginUrl: string) => void;
  /** Sink for progress messages. Defaults to stderr. */
  log?: (message: string) => void;
  signal?: AbortSignal;
  sessionServiceUrl?: string;
  totalTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ResolvedOptions {
  fetch?: FetchLike;
  renderQr: (loginUrl: string) => void;
  log: (message: string) => void;
  signal?: AbortSignal;
  sessionServiceUrl?: string;
  totalTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Mirrors `normalizeAccountId` from `openclaw/plugin-sdk/account-id`, which the
 *  upstream plugin uses to derive on-disk filenames: replace `@` and `.` with
 *  `-`. We normalize at capture time so the seed step writes the account file
 *  under the same name the plugin looks for at runtime. */
export function normalizeClawbotAccountId(rawId: string): string {
  return rawId.replace(/[@.]/g, "-");
}

/** Zalo bot tokens are `<numeric-id>:<secret>`; the numeric prefix is the bot's
 *  public id. Used as the account-id source when the confirmation payload omits
 *  `botId` (matches the upstream plugin's token fallback). */
export function parseBotTokenPublicId(token: string): string | undefined {
  return /^(\d+):/.exec(token.trim())?.[1];
}

function defaultRenderer(loginUrl: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const qrterm = require("qrcode-terminal") as {
    generate(text: string, opts: { small?: boolean }): void;
  };
  qrterm.generate(loginUrl, { small: true });
}

function resolveOptions(opts: ZaloClawbotLoginOptions = {}): ResolvedOptions {
  return {
    fetch: opts.fetch,
    renderQr: opts.renderQr ?? defaultRenderer,
    log: opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`)),
    signal: opts.signal,
    sessionServiceUrl: opts.sessionServiceUrl,
    totalTimeoutMs: opts.totalTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
}

function emitQr(session: ZaloClawbotLoginSession, opts: ResolvedOptions): void {
  opts.log("");
  opts.log("  Scan the QR below with the Zalo app to connect your bot.");
  opts.log("  If the QR does not render, open this URL in Zalo on your phone instead:");
  opts.log(`    ${session.loginUrl}`);
  opts.log("");
  try {
    opts.renderQr(session.loginUrl);
  } catch (err) {
    opts.log(
      `  (could not render terminal QR: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Run the host-side QR login end-to-end. Returns a discriminated result so
 *  callers branch on success/expiry/timeout/abort without try/catch. */
export async function runZaloClawbotHostQrLogin(
  options: ZaloClawbotLoginOptions = {},
): Promise<ZaloClawbotLoginResult> {
  const opts = resolveOptions(options);
  if (opts.signal?.aborted) return { kind: "aborted" };

  let session: ZaloClawbotLoginSession;
  try {
    session = await requestZaloClawbotLogin({
      fetch: opts.fetch,
      sessionServiceUrl: opts.sessionServiceUrl,
    });
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
  emitQr(session, opts);

  let qrRefreshCount = 0;
  const deadline = opts.now() + opts.totalTimeoutMs;
  opts.log("  [zalo-clawbot] waiting for Zalo login confirmation…");

  while (opts.now() < deadline) {
    if (opts.signal?.aborted) return { kind: "aborted" };

    let status: Awaited<ReturnType<typeof pollZaloClawbotLoginStatus>>;
    try {
      status = await pollZaloClawbotLoginStatus({
        zbsk: session.zbsk,
        fetch: opts.fetch,
        sessionServiceUrl: opts.sessionServiceUrl,
        signal: opts.signal,
      });
    } catch (err) {
      return { kind: "error", message: errorMessage(err) };
    }

    if (status.connected && status.botToken) {
      // botId is optional in the confirmation payload; fall back to the token's
      // public id (`<id>:<secret>`), mirroring the upstream plugin so the
      // account id stays stable and we never hang waiting for a field the
      // server may omit.
      const botId = status.botId?.trim() || parseBotTokenPublicId(status.botToken);
      if (!botId) {
        return {
          kind: "error",
          message:
            "Zalo login confirmed but the server returned no bot id and the token has no id prefix.",
        };
      }
      opts.log("  ✓ Zalo login confirmed.");
      return {
        kind: "ok",
        credentials: {
          token: status.botToken,
          accountId: normalizeClawbotAccountId(`clawbot-${botId}`),
          botId,
          ...(status.ownerId ? { ownerId: status.ownerId } : {}),
          ...(status.oaId ? { oaId: status.oaId } : {}),
        },
      };
    }

    if (status.expired) {
      qrRefreshCount += 1;
      if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
        return { kind: "expired", reason: "max_refresh_exceeded" };
      }
      opts.log(`  ⏳ QR expired — refreshing (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})…`);
      try {
        session = await requestZaloClawbotLogin({
          fetch: opts.fetch,
          sessionServiceUrl: opts.sessionServiceUrl,
        });
      } catch (err) {
        return { kind: "error", message: errorMessage(err) };
      }
      emitQr(session, opts);
    }

    await opts.sleep(opts.pollIntervalMs);
  }

  return { kind: "timeout" };
}

function errorMessage(err: unknown): string {
  if (err instanceof ZaloClawbotQrError) return `${err.kind}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
