// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { compactText } from "../core/url-utils";

// Profile id registered with OpenShell (nemoclaw-blueprint/provider-profiles/
// google-chat-bridge.yaml) and passed as `provider create --type`.
export const GOOGLECHAT_BRIDGE_PROFILE_ID = "google-chat-bridge";

// Injectable credential key the gateway mints + the L7 proxy injects as
// `Authorization: Bearer` on chat.googleapis.com. MUST match the env var the
// googlechat-outbound-auth runtime preload reads.
export const GOOGLECHAT_BRIDGE_CREDENTIAL_KEY = "GOOGLE_CHAT_ACCESS_TOKEN";

// Where the pasted service-account JSON is stored (the tokenPaste enroll hook
// saves it under this env key). Used only as gateway-side refresh MATERIAL —
// it is never delivered into the sandbox.
export const GOOGLECHAT_SERVICE_ACCOUNT_ENV = "GOOGLECHAT_SERVICE_ACCOUNT";

// Scope the bot token is minted for (Google Chat bot scope).
export const GOOGLECHAT_BRIDGE_SCOPE = "https://www.googleapis.com/auth/chat.bot";

// Sentinel credential value used at `provider create`. The real value is minted
// by `provider refresh configure`; this only has to be non-empty so the provider
// is created (the gateway overwrites it on the first mint).
export const GOOGLECHAT_BRIDGE_PENDING_VALUE = "openshell-managed-pending-mint";

const GOOGLECHAT_CHANNEL = "googlechat";

type RunOpenshell = (
  args: string[],
  // The runner accepts a wider options shape; we only set ignoreError + stdio
  // here, so erase the type at the boundary to keep this module free of the
  // runner.ts internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: any,
) => { status: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null };

type TokenDefShape = { name: string; providerType?: string; token: string | null };

export type GooglechatBridgeProfileDeps = {
  root: string;
  runOpenshell: RunOpenshell;
  redact: (input: string) => string;
  log?: (message?: string) => void;
  exit?: (code?: number) => never;
};

export type GooglechatBridgeRefreshDeps = {
  runOpenshell: RunOpenshell;
  redact: (input: string) => string;
  getCredential: (envKey: string) => string | null;
  log?: (message?: string) => void;
};

function bufferOrStringToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function")
    return (value as Buffer).toString();
  return "";
}

export function googlechatBridgeProfilePath(root: string): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", "google-chat-bridge.yaml");
}

/**
 * Build the messaging token definition for the Google Chat outbound-auth bridge
 * provider, or null when it does not apply.
 *
 * Unlike a normal channel credential the value is NOT pasted — it is minted
 * gateway-side — so the token is a non-empty sentinel (overwritten by the first
 * refresh) and the real service-account material is supplied separately via
 * {@link configureGooglechatBridgeRefresh}. Emitted only when the Google Chat
 * service account was captured and the channel is enabled (mirrors how the Brave
 * provider is pushed in messaging-prep).
 */
export function maybeGooglechatBridgeTokenDef(input: {
  sandboxName: string;
  getCredential: (envKey: string) => string | null;
  enabledChannels: readonly string[] | null;
  disabledChannelNames: ReadonlySet<string>;
}): { name: string; envKey: string; token: string; providerType: string } | null {
  if (input.disabledChannelNames.has(GOOGLECHAT_CHANNEL)) return null;
  if (input.enabledChannels != null && !input.enabledChannels.includes(GOOGLECHAT_CHANNEL)) {
    return null;
  }
  const serviceAccount = input.getCredential(GOOGLECHAT_SERVICE_ACCOUNT_ENV);
  if (!serviceAccount) return null;
  return {
    name: `${input.sandboxName}-googlechat-bridge`,
    envKey: GOOGLECHAT_BRIDGE_CREDENTIAL_KEY,
    token: GOOGLECHAT_BRIDGE_PENDING_VALUE,
    providerType: GOOGLECHAT_BRIDGE_PROFILE_ID,
  };
}

/**
 * Register the Google Chat bridge provider profile with OpenShell so providers
 * created with `--type google-chat-bridge` drive the L7 proxy's outbound bearer
 * injection. Skipped unless a bridge-typed token definition is present.
 * Idempotent: tolerates OpenShell reporting the custom profile already exists.
 */
export function ensureGooglechatBridgeProfile(
  tokenDefs: readonly TokenDefShape[],
  deps: GooglechatBridgeProfileDeps,
): void {
  const needs = tokenDefs.some(
    ({ providerType, token }) => providerType === GOOGLECHAT_BRIDGE_PROFILE_ID && Boolean(token),
  );
  if (!needs) return;

  const errorLog = deps.log ?? console.error;
  const exit = deps.exit ?? ((code?: number) => process.exit(code));

  const result = deps.runOpenshell(
    ["provider", "profile", "import", "--file", googlechatBridgeProfilePath(deps.root)],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status === 0) return;

  const rawDiagnostic = `${bufferOrStringToText(result.stderr)} ${bufferOrStringToText(result.stdout)}`;
  if (/already exists/i.test(rawDiagnostic)) return;

  const diagnostic = compactText(deps.redact(rawDiagnostic));
  errorLog("\n  ✗ Failed to register the Google Chat bridge provider profile with OpenShell.");
  if (diagnostic) errorLog(`    ${diagnostic.slice(0, 500)}`);
  errorLog("    Update OpenShell with scripts/install-openshell.sh and re-run onboarding.");
  exit(result.status || 1);
}

/**
 * Configure gateway-side credential refresh for the Google Chat bridge provider:
 * the gateway mints (and rotates) the bot access token from the service-account
 * key via the google_service_account_jwt strategy. Must run AFTER the provider
 * is created. The service-account private key is passed as refresh material and
 * stays gateway-side — it is never written into the sandbox.
 *
 * Best-effort: a failure here means outbound replies will not authenticate
 * until fixed, but it must not abort onboarding of other channels. Inbound
 * webhook verification is unaffected. The private key is never logged.
 */
export function configureGooglechatBridgeRefresh(
  tokenDefs: readonly TokenDefShape[],
  deps: GooglechatBridgeRefreshDeps,
): void {
  const bridge = tokenDefs.find(
    ({ providerType, token }) => providerType === GOOGLECHAT_BRIDGE_PROFILE_ID && Boolean(token),
  );
  if (!bridge) return;

  const warn = deps.log ?? console.error;
  const serviceAccount = deps.getCredential(GOOGLECHAT_SERVICE_ACCOUNT_ENV);
  if (!serviceAccount) {
    warn(
      "\n  ✗ Google Chat bridge: service account JSON unavailable; cannot configure gateway token minting.",
    );
    return;
  }

  let clientEmail: unknown;
  let privateKey: unknown;
  try {
    const parsed = JSON.parse(serviceAccount) as Record<string, unknown>;
    clientEmail = parsed.client_email;
    privateKey = parsed.private_key;
  } catch {
    warn(
      "\n  ✗ Google Chat bridge: service account JSON could not be parsed; cannot configure gateway token minting.",
    );
    return;
  }
  if (
    typeof clientEmail !== "string" ||
    !clientEmail ||
    typeof privateKey !== "string" ||
    !privateKey
  ) {
    warn(
      "\n  ✗ Google Chat bridge: service account JSON missing client_email/private_key; cannot configure gateway token minting.",
    );
    return;
  }

  const result = deps.runOpenshell(
    [
      "provider",
      "refresh",
      "configure",
      "--credential-key",
      GOOGLECHAT_BRIDGE_CREDENTIAL_KEY,
      "--strategy",
      "google-service-account-jwt",
      "--material",
      `client_email=${clientEmail}`,
      "--material",
      `private_key=${privateKey}`,
      "--material",
      `scope=${GOOGLECHAT_BRIDGE_SCOPE}`,
      "--secret-material-key",
      "private_key",
      bridge.name,
    ],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status === 0) return;

  // Redact before logging — never echo the private key material.
  const diagnostic = compactText(
    deps.redact(`${bufferOrStringToText(result.stderr)} ${bufferOrStringToText(result.stdout)}`),
  );
  warn(`\n  ✗ Google Chat bridge: failed to configure gateway token minting for '${bridge.name}'.`);
  if (diagnostic) warn(`    ${diagnostic.slice(0, 500)}`);
  warn("    Outbound Google Chat replies will not authenticate until this is resolved.");
}
