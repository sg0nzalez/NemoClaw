// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const zaloManifest = {
  schemaVersion: 1,
  id: "zalo",
  displayName: "Zalo",
  description: "Zalo bot messaging (Bot API)",
  enrollmentNotes: [
    "Create a bot at the Zalo Bot Platform (https://bot.zaloplatforms.com) and copy its token (format id:secret).",
    "Unknown senders are paired first; approve from the sandbox with 'openclaw pairing approve zalo <code>'.",
  ],
  supportedAgents: ["openclaw"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "ZALO_BOT_TOKEN",
      formatPattern: "^\\d+:.+$",
      formatHint: "Zalo bot tokens are <numeric-id>:<secret> from the Zalo Bot Platform.",
      prompt: {
        label: "Zalo Bot Token",
        help: "Create a bot at the Zalo Bot Platform (https://bot.zaloplatforms.com), then copy the token (format id:secret).",
      },
    },
    {
      id: "allowedIds",
      kind: "config",
      required: false,
      envKey: "ZALO_ALLOWED_IDS",
      statePath: "allowedIds.zalo",
      formatPattern: "^\\d+(,\\d+)*$",
      formatHint: "Comma-separated numeric Zalo user IDs (e.g. 123,456).",
      prompt: {
        label: "Zalo User ID (for DM access)",
        help: "Numeric Zalo user IDs allowed to DM the bot. Zalo has no username lookup, so use numeric IDs.",
        emptyValueMessage: "bot will require manual pairing",
      },
    },
    {
      id: "groupPolicy",
      kind: "config",
      required: false,
      envKey: "ZALO_GROUP_POLICY",
      statePath: "zaloConfig.groupPolicy",
      validValues: ["open", "allowlist", "disabled"],
      defaultValue: "allowlist",
      prompt: {
        label: "Zalo group policy",
        help: "Controls OpenClaw Zalo group access: open to all, allowlist only, or disabled.",
      },
    },
  ],
  credentials: [
    {
      id: "zaloBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-zalo-bridge",
      providerEnvKey: "ZALO_BOT_TOKEN",
      placeholder: "openshell:resolve:env:ZALO_BOT_TOKEN",
    },
  ],
  policyPresets: [
    {
      name: "zalo",
      validationWarningLines: [
        "For Zalo preset validation, do not use curl as the success signal:",
        "curl is not in the preset binary allowlist, so curl probes can fail even",
        "when the policy is working. Use Node HTTPS against",
        "https://bot-api.zaloplatforms.com to validate the configured messaging bridge path.",
      ],
    },
  ],
  render: [
    {
      id: "zalo-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        // The @openclaw/zalo plugin validates channels.zalo as a flat
        // single-account object; it rejects the Telegram-style
        // accounts.default nesting ("must not have additional properties").
        path: "channels.zalo",
        value: {
          enabled: true,
          botToken: "{{credential.zaloBotToken.placeholder}}",
          proxy: "{{zaloProxyUrl}}",
          groupPolicy: "{{zalo.groupPolicy}}",
          dmPolicy: "{{zalo.allowedUsers.dmPolicy}}",
          allowFrom: "{{zalo.allowedUsers.values}}",
        },
      },
    },
    {
      id: "zalo-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.zalo",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "zalo",
      visibility: {
        configKeys: ["zalo"],
        logPatterns: ["zalo"],
      },
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/zalo@{{openclaw.version}}",
      pin: true,
      required: true,
    },
  ],
  state: {
    persist: {
      allowedIds: ["allowedIds"],
      zaloConfig: ["groupPolicy"],
    },
    rebuildHydration: [
      {
        statePath: "allowedIds.zalo",
        env: "ZALO_ALLOWED_IDS",
      },
      {
        statePath: "zaloConfig.groupPolicy",
        env: "ZALO_GROUP_POLICY",
      },
    ],
  },
  hooks: [
    {
      id: "zalo-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "zalo-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "allowedIds",
          kind: "config",
        },
        {
          id: "groupPolicy",
          kind: "config",
        },
      ],
    },
    {
      id: "zalo-openclaw-bridge-health",
      phase: "health-check",
      handler: "zalo.openclawBridgeHealth",
      agents: ["openclaw"],
      onFailure: "abort",
    },
  ],
} as const satisfies ChannelManifest;
