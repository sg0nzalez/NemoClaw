// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

// Google Chat is an inbound-webhook channel. Unlike Microsoft Teams (which runs
// its own bot web server on a separate port and needs a host forward), the
// Google Chat webhook is served by the OpenClaw gateway on the shared dashboard
// port (18789) at `/googlechat` — the same port `nemoclaw tunnel start` already
// exposes. So there is no `hostForward`; the tunnel/audience enroll hook derives
// the public webhook URL from the existing cloudflared tunnel instead.
export const googlechatManifest = {
  schemaVersion: 1,
  id: "googlechat",
  displayName: "Google Chat",
  description: "Google Chat (Chat API) bot messaging",
  enrollmentNotes: [
    "Google Workspace accounts need no appPrincipal.",
    "Personal/standalone Google accounts are served as Workspace add-ons and also need channels.googlechat.appPrincipal — the add-on's numeric OAuth client ID (~21 digits, not an email). Paste it at the appPrincipal prompt if you know it.",
    "To capture appPrincipal: once the bot is live, send ONE direct message to it, then read the gateway log for `unexpected add-on principal: <N>` (set a placeholder appPrincipal first, or the log reports `missing add-on principal binding` with no number). Set GOOGLECHAT_APP_PRINCIPAL=<N> (or paste it) and rebuild to persist.",
    "The cloudflared tunnel exposes the whole dashboard port publicly; open the Control UI from http://127.0.0.1:18789 (localhost), not the public URL.",
  ],
  supportedAgents: ["openclaw"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "serviceAccount",
      kind: "secret",
      required: true,
      envKey: "GOOGLECHAT_SERVICE_ACCOUNT",
      prompt: {
        label: "Google Chat service account JSON",
        help: "Paste the downloaded service account JSON key as a single line (minified). Google Cloud Console → IAM → Service Accounts → Keys → Add key → JSON.",
      },
    },
    {
      id: "audienceType",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_AUDIENCE_TYPE",
      statePath: "googlechatConfig.audienceType",
      validValues: ["app-url", "project-number"],
      defaultValue: "app-url",
    },
    {
      id: "audience",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_AUDIENCE",
      statePath: "googlechatConfig.audience",
      prompt: {
        label: "Google Chat webhook audience",
        help: "Usually filled automatically from the public tunnel URL. For audienceType 'project-number', enter your GCP project number instead.",
        emptyValueMessage: "inbound webhook verification will be unconfigured",
      },
    },
    {
      id: "appPrincipal",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_APP_PRINCIPAL",
      statePath: "googlechatConfig.appPrincipal",
      formatPattern: "^[0-9]{6,32}$",
      formatHint:
        "appPrincipal is the add-on's numeric OAuth client ID (uniqueId, ~21 digits), not an email.",
      prompt: {
        label: "Google Chat appPrincipal (personal/standalone accounts only)",
        help: "Leave blank for Google Workspace accounts. For personal/standalone Google accounts, paste the add-on's 21-digit numeric ID if you already have it; otherwise leave blank and capture it after the bot is live.",
        emptyValueMessage: "Workspace accounts do not need it; personal accounts must set it later",
      },
    },
    {
      id: "webhookPath",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_WEBHOOK_PATH",
      statePath: "googlechatConfig.webhookPath",
      defaultValue: "/googlechat",
    },
    {
      id: "allowFrom",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_ALLOWED_USERS",
      statePath: "allowedIds.googlechat",
      prompt: {
        label: "Google Chat DM allowlist (comma-separated user IDs)",
        help: "Optional: restrict who can DM the bot. Enter Google Chat user IDs (users/NNN) — NOT emails: the bot matches IDs only by default, so an email entry is ignored. Leave blank to require pairing (recommended).",
        emptyValueMessage: "bot will require manual pairing",
      },
    },
  ],
  // Outbound auth is gateway-minted: the OpenShell `google-service-account-jwt`
  // refresh provider mints the Google Chat bot token from the pasted service
  // account, and the L7 proxy injects it as `Authorization: Bearer` on
  // chat.googleapis.com. The service-account private key stays gateway-side and
  // never enters the sandbox. The bridge provider + refresh are wired in
  // src/lib/onboard/googlechat-bridge-provider.ts; the googlechat-outbound-auth
  // runtime preload makes the plugin send the injected bearer instead of signing
  // in-process. No credentials/secretFiles here — the pasted serviceAccount is
  // consumed only as gateway-side refresh material, never delivered into the sandbox.
  // (The `serviceAccountFile` in `render` below is a start-gate marker only, not a
  // delivered file — see the comment there.)
  credentials: [],
  policyPresets: [{ name: "googlechat", policyKeys: ["googlechat"] }],
  render: [
    {
      id: "googlechat-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.googlechat",
        value: {
          enabled: true,
          // Configured-marker ONLY — the file is never delivered (no secretFiles)
          // and never read. OpenClaw's channel-start gate requires a serviceAccount*
          // (isConfigured: credentialSource !== "none") to start the webhook, but the
          // actual token is gateway-minted and proxy-injected, and the
          // googlechat-outbound-auth preload short-circuits the token producer before
          // this path is read — so the SA key never enters the sandbox. (Clean fix is
          // upstream: a non-SA "configured"/accessToken credential source in @openclaw/googlechat.)
          serviceAccountFile: "/sandbox/.openclaw/secrets/googlechat-service-account.json",
          audienceType: "{{googlechatConfig.audienceType}}",
          audience: "{{googlechatConfig.audience}}",
          appPrincipal: "{{googlechatConfig.appPrincipal}}",
          webhookPath: "{{googlechatConfig.webhookPath}}",
          healthMonitor: {
            enabled: false,
          },
          dm: {
            policy: "{{allowedIds.googlechat.dmPolicy}}",
            allowFrom: "{{allowedIds.googlechat.values}}",
          },
        },
      },
    },
    {
      id: "googlechat-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.googlechat",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "googlechat",
      visibility: {
        configKeys: ["googlechat"],
        logPatterns: ["googlechat"],
      },
      // Interim sandbox-DNS workaround: the sandbox netns is DNS-less (all
      // resolution goes through the L7 proxy), but OpenClaw's Google Chat fetches
      // default to STRICT SSRF mode, which does a LOCAL getaddrinfo first and
      // fails with EAI_AGAIN. This boot preload rewrites the plugin's googleapis
      // fetches (inbound cert verify + all outbound sends) to the guard's
      // first-class `trusted_env_proxy` mode, so they skip the local resolve and
      // route by hostname through the L7 proxy (which resolves + enforces policy).
      // No sentinel IP. It replaces the older googlechat-dns-resolve.ts sentinel
      // shim, and is exactly the upstream OpenClaw fix (trusted-env-proxy fetch,
      // like web_fetch openclaw#50650) applied in the plugin bundle; remove once
      // that lands upstream. See runtime/googlechat-trusted-proxy-fetch.ts.
      //
      // Second boot preload: move OUTBOUND auth off the in-sandbox SA key. By
      // default @openclaw/googlechat signs an auth JWT with the SA private key
      // in-process, which forces the key to live in the sandbox. This preload
      // rewrites the plugin's single token producer to return the OpenShell
      // gateway-minted credential placeholder (GOOGLE_CHAT_ACCESS_TOKEN) so the
      // L7 proxy injects the real bearer outbound and the key never enters the
      // sandbox. See runtime/googlechat-outbound-auth.ts.
      nodePreloads: [
        {
          module: "googlechat-trusted-proxy-fetch",
          injectInto: ["boot"],
          optional: false,
          installMessage:
            "[channels] Installing Google Chat trusted-proxy-fetch patch (route googleapis via trusted env proxy)",
          installedMessage:
            "[channels] Google Chat trusted-proxy-fetch patch installed (NODE_OPTIONS updated)",
        },
        {
          module: "googlechat-outbound-auth",
          injectInto: ["boot"],
          optional: false,
          installMessage:
            "[channels] Installing Google Chat outbound-auth patch (gateway-minted bearer)",
          installedMessage:
            "[channels] Google Chat outbound-auth patch installed (NODE_OPTIONS updated)",
        },
      ],
      secretScans: [
        {
          path: "/sandbox/.openclaw/openclaw.json",
          pattern: "-----BEGIN (?:RSA )?PRIVATE KEY-----",
          message:
            "[SECURITY] Google Chat service account private key leaked into {path} - refusing to serve",
          exitCode: 78,
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/googlechat@{{openclaw.version}}",
      pin: true,
      required: true,
    },
  ],
  hooks: [
    {
      id: "googlechat-tunnel-audience-gate",
      phase: "enroll",
      handler: "googlechat.tunnelAudienceGate",
      inputs: ["audienceType", "audience", "webhookPath"],
      outputs: [
        {
          id: "audience",
          kind: "config",
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "googlechat-service-account",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "serviceAccount",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "googlechat-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "audience",
          kind: "config",
        },
        {
          id: "appPrincipal",
          kind: "config",
        },
        {
          id: "allowFrom",
          kind: "config",
        },
      ],
    },
  ],
} as const satisfies ChannelManifest;
