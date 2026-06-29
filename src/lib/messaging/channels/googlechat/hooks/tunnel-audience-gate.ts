// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";

export const GOOGLECHAT_TUNNEL_AUDIENCE_GATE_HOOK_ID = "googlechat.tunnelAudienceGate";

const DEFAULT_WEBHOOK_PATH = "/googlechat";

/** Coarse cloudflared running-state used to decide whether we must start one. */
export type GooglechatTunnelState = { readonly running: boolean };

// Every side effect is injected so this hook file stays free of fs/process/
// credential imports (mirrors the WeChat ilink-login pattern). The real
// implementations live in ./tunnel-runtime and are wired by ./index.
export interface GooglechatTunnelAudienceGateHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  readonly hasCloudflared?: () => boolean;
  readonly readTunnelState?: () => GooglechatTunnelState;
  readonly startTunnel?: () => Promise<void>;
  readonly stopTunnel?: () => void;
  readonly getTunnelUrl?: () => string;
  readonly prompt?: (question: string) => Promise<string>;
}

function readString(value: MessagingSerializableValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return DEFAULT_WEBHOOK_PATH;
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash || DEFAULT_WEBHOOK_PATH;
}

function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function audienceOutput(audience: string): { readonly outputs: MessagingHookOutputMap } {
  const outputs: Record<string, MessagingHookOutputMap[string]> = {
    audience: { kind: "config", value: audience },
  };
  return { outputs };
}

function printEndpointInstructions(log: (message: string) => void, audience: string): void {
  log("");
  log("  ── Google Chat — action required ───────────────────────────────");
  log("  In Google Cloud Console → Google Chat API → Configuration →");
  log("  Connection settings, set the HTTP endpoint URL to exactly:");
  log(`      ${audience}`);
  log("  (HTTPS, exact match including the path — no trailing slash.)");
  log("");
}

export function createGooglechatTunnelAudienceGateHook(
  options: GooglechatTunnelAudienceGateHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    if (context.channelId !== "googlechat") return {};

    const env = options.env ?? process.env;
    const log = options.log ?? ((message: string) => console.log(message));
    const audienceType = readString(context.inputs?.audienceType) || "app-url";
    const webhookPath = normalizeWebhookPath(
      readString(context.inputs?.webhookPath) || readString(env.GOOGLECHAT_WEBHOOK_PATH),
    );

    // An audience supplied up front (env, prior paste, or a named tunnel) wins;
    // never touch the cloudflared tunnel in that case. Also covers project-number.
    const existingAudience =
      readString(context.inputs?.audience) || readString(env.GOOGLECHAT_AUDIENCE);
    if (existingAudience) return audienceOutput(existingAudience);

    // Only the app-url path derives its audience from a public webhook URL. Any
    // other audienceType (e.g. project-number) is entered via the config prompt.
    if (audienceType !== "app-url") return {};

    // Non-interactive (CI/E2E): never spawn a tunnel; require an explicit audience.
    if (context.isInteractive === false) {
      log("  Skipped googlechat (set GOOGLECHAT_AUDIENCE to use Google Chat non-interactively)");
      throw new Error(
        "Google Chat app-url audience requires GOOGLECHAT_AUDIENCE in non-interactive mode.",
      );
    }

    const readTunnelState = requireOption(options.readTunnelState, "readTunnelState");
    const getTunnelUrl = requireOption(options.getTunnelUrl, "getTunnelUrl");
    const stopTunnel = requireOption(options.stopTunnel, "stopTunnel");

    const preexisting = readTunnelState().running;
    let startedByUs = false;
    if (!preexisting) {
      const hasCloudflared = requireOption(options.hasCloudflared, "hasCloudflared");
      if (!hasCloudflared()) {
        log("  Skipped googlechat (cloudflared not installed — needed for a public webhook URL)");
        throw new Error(
          "cloudflared is not installed; cannot expose a public Google Chat webhook.",
        );
      }
      log("  Google Chat needs a public HTTPS URL. Starting a tunnel (nemoclaw tunnel start)…");
      const startTunnel = requireOption(options.startTunnel, "startTunnel");
      await startTunnel();
      if (!readTunnelState().running) {
        stopTunnel();
        log("  Skipped googlechat (cloudflared tunnel failed to start)");
        throw new Error("cloudflared tunnel failed to start.");
      }
      startedByUs = true;
    }

    const url = getTunnelUrl();
    if (!url) {
      if (startedByUs) stopTunnel();
      log("  Skipped googlechat (no public tunnel URL available)");
      throw new Error("No public tunnel URL is available for the Google Chat webhook.");
    }

    const audience = `${url.replace(/\/+$/, "")}${webhookPath}`;
    printEndpointInstructions(log, audience);

    // Non-interactive app-url already returned/threw above, so this prompt path
    // is only reached interactively. Mirrors promptYesNoOrDefault: default No,
    // y/yes wins.
    const prompt = requireOption(options.prompt, "prompt");
    const answer = await prompt(
      "  Have you set this as the HTTP endpoint URL in Google Cloud Console? [y/N]: ",
    );
    if (!isAffirmative(answer)) {
      if (startedByUs) stopTunnel();
      log("  Skipped googlechat (HTTP endpoint URL not set in Google Cloud Console)");
      throw new Error("Operator did not confirm the Google Chat HTTP endpoint URL.");
    }

    env.GOOGLECHAT_AUDIENCE = audience;
    return audienceOutput(audience);
  };
}

function requireOption<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Google Chat tunnel/audience gate hook requires an injected ${name}.`);
  }
  return value;
}

export function createGooglechatTunnelAudienceGateHookRegistration(
  options: GooglechatTunnelAudienceGateHookOptions = {},
): MessagingHookRegistration {
  return {
    id: GOOGLECHAT_TUNNEL_AUDIENCE_GATE_HOOK_ID,
    handler: createGooglechatTunnelAudienceGateHook(options),
  };
}
