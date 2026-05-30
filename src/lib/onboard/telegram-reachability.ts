// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runCurlProbe } from "../adapters/http/probe";

// Curl exit codes that indicate a network-level failure (not a token problem).
// 35 (TLS handshake failure) covers corporate proxies that MITM HTTPS.
export const TELEGRAM_NETWORK_CURL_CODES = new Set([6, 7, 28, 35, 52, 56]);

export interface TelegramReachabilityDeps {
  isNonInteractive(): boolean;
  note(message: string): void;
  promptYesNoOrDefault(
    question: string,
    envVar: string | null,
    defaultIsYes: boolean,
  ): Promise<boolean>;
  exit?(code?: number): never;
}

export async function checkTelegramReachability(
  token: string,
  deps: TelegramReachabilityDeps,
): Promise<void> {
  const exit = deps.exit ?? ((code?: number): never => process.exit(code));

  if (process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY === "1") {
    deps.note("  [non-interactive] Skipping Telegram reachability probe by request.");
    return;
  }

  const result = runCurlProbe([
    "-sS",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
    `https://api.telegram.org/bot${token}/getMe`,
  ]);

  // HTTP 200 with "ok":true — Telegram is reachable and token is valid.
  if (result.ok) return;

  // HTTP 401 or 404 — token was rejected by Telegram (not a network issue).
  if (result.httpStatus === 401 || result.httpStatus === 404) {
    console.log("  ⚠ Bot token was rejected by Telegram — verify the token is correct.");
    return;
  }

  // Network-level failure — Telegram is unreachable from this host.
  if (result.curlStatus && TELEGRAM_NETWORK_CURL_CODES.has(result.curlStatus)) {
    console.log("");
    console.log("  ⚠ api.telegram.org is not reachable from this host.");
    console.log("    Telegram integration requires outbound HTTPS access to api.telegram.org.");
    console.log("    This is commonly blocked by corporate network proxies.");

    if (deps.isNonInteractive()) {
      console.error(
        "  Aborting onboarding in non-interactive mode due to Telegram network reachability failure.",
      );
      exit(1);
    } else if (!(await deps.promptYesNoOrDefault("    Continue anyway?", null, false))) {
      console.log("  Aborting onboarding.");
      exit(1);
    }
    return;
  }

  // Unexpected probe failure — warn but don't block.
  if (!result.ok && result.httpStatus > 0) {
    console.log(
      `  ⚠ Telegram API returned HTTP ${result.httpStatus} — the bot may not work correctly.`,
    );
  } else if (!result.ok) {
    console.log(`  ⚠ Telegram reachability probe failed: ${result.message}`);
  }
}
