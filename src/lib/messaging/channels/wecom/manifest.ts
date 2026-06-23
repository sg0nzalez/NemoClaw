// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

const WECOM_OPENCLAW_PLUGIN_VERSION = "2026.5.25";

export const wecomManifest = {
  schemaVersion: 1,
  id: "wecom",
  displayName: "WeCom",
  description: "WeCom (Enterprise WeChat) AI Bot messaging",
  enrollmentNotes: [
    "Experimental. NemoClaw configures the WeCom AI Bot WebSocket mode, not the separate callback/webhook integration.",
  ],
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botId",
      kind: "secret",
      required: true,
      envKey: "WECOM_BOT_ID",
      prompt: {
        label: "WeCom Bot ID",
        help: "Create a WeCom AI Bot in the WeCom Admin Console, then copy its Bot ID.",
      },
    },
    {
      id: "secret",
      kind: "secret",
      required: true,
      envKey: "WECOM_SECRET",
      prompt: {
        label: "WeCom Bot Secret",
        help: "Copy the Secret from the WeCom AI Bot credentials page.",
      },
    },
    {
      id: "allowedUsers",
      kind: "config",
      required: false,
      envKey: "WECOM_ALLOWED_USERS",
      statePath: "allowedIds.wecom",
      prompt: {
        label: "WeCom User IDs (DM allowlist)",
        help: "Optional: restrict who can DM the bot. Enter one or more comma-separated WeCom user IDs.",
        emptyValueMessage: "DM access stays controlled by DM policy",
      },
    },
    {
      id: "dmPolicy",
      kind: "config",
      required: false,
      envKey: "WECOM_DM_POLICY",
      statePath: "wecomConfig.dmPolicy",
      validValues: ["open", "allowlist", "disabled", "pairing"],
      defaultValue: "open",
      prompt: {
        label: "WeCom DM policy",
        help: "Controls direct-message access: open, allowlist, disabled, or pairing.",
      },
    },
  ],
  credentials: [
    {
      id: "wecomBotId",
      sourceInput: "botId",
      providerName: "{sandboxName}-wecom-bot-id",
      providerEnvKey: "WECOM_BOT_ID",
      placeholder: "openshell:resolve:env:WECOM_BOT_ID",
      primary: true,
    },
    {
      id: "wecomSecret",
      sourceInput: "secret",
      providerName: "{sandboxName}-wecom-secret",
      providerEnvKey: "WECOM_SECRET",
      placeholder: "openshell:resolve:env:WECOM_SECRET",
    },
  ],
  policyPresets: [{ name: "wecom", policyKeys: ["wecom_aibot"] }],
  render: [
    {
      id: "wecom-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.wecom",
        value: {
          enabled: true,
          connectionMode: "websocket",
          botId: "{{credential.wecomBotId.placeholder}}",
          secret: "{{credential.wecomSecret.placeholder}}",
          dmPolicy: "{{wecomConfig.dmPolicy}}",
          allowFrom: "{{allowedIds.wecom.values}}",
        },
      },
    },
    {
      id: "wecom-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.wecom",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "wecom-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "WECOM_BOT_ID={{credential.wecomBotId.placeholder}}",
        "WECOM_SECRET={{credential.wecomSecret.placeholder}}",
        "WECOM_ALLOWED_USERS={{allowedIds.wecom.csv}}",
        "WECOM_DM_POLICY={{wecomConfig.dmPolicy}}",
      ],
    },
    {
      id: "wecom-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.wecom",
        value: {
          enabled: true,
          extra: {
            dm_policy: "{{wecomConfig.dmPolicy}}",
            allow_from: "{{allowedIds.wecom.values}}",
          },
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "wecom",
      visibility: {
        configKeys: ["wecom"],
        logPatterns: ["wecom", "WeCom"],
      },
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: `npm:@wecom/wecom-openclaw-plugin@${WECOM_OPENCLAW_PLUGIN_VERSION}`,
      pin: true,
      required: true,
    },
  ],
  state: {
    persist: {
      allowedIds: ["wecom"],
      wecomConfig: ["dmPolicy"],
    },
    rebuildHydration: [
      {
        statePath: "allowedIds.wecom",
        env: "WECOM_ALLOWED_USERS",
      },
      {
        statePath: "wecomConfig.dmPolicy",
        env: "WECOM_DM_POLICY",
      },
    ],
  },
  hooks: [
    {
      id: "wecom-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "botId",
          kind: "secret",
          required: true,
        },
        {
          id: "secret",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "wecom-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "allowedUsers",
          kind: "config",
        },
        {
          id: "dmPolicy",
          kind: "config",
        },
      ],
    },
  ],
} as const satisfies ChannelManifest;
