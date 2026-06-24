// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const zaloClawbotManifest = {
  schemaVersion: 1,
  id: "zalo-clawbot",
  displayName: "Zalo ClawBot",
  description: "Zalo ClawBot (personal owner-bound assistant bot, QR login)",
  enrollmentHelp:
    "Pair by scanning the QR shown here during onboarding with the Zalo app, then approve the ClawBot mini-app. The bot is owner-bound — it only talks to the operator who scanned and Zalo drops everyone else at the platform level, so no allowlist is needed. The login is captured on the host and seeded into the sandbox; there is no in-sandbox login step.",
  enrollmentNotes: [
    "After the sandbox starts, run `nemoclaw <sandbox> channels status --channel zalo-clawbot` to confirm the bot is delivering inbound messages.",
  ],
  // OpenClaw-only: the upstream plugin is an OpenClaw channel plugin; there is
  // no Hermes Zalo ClawBot platform to target.
  supportedAgents: ["openclaw"],
  // host-qr: NemoClaw renders the QR and captures the bot token on the host
  // during onboarding (OpenClaw's in-sandbox `channels login` only supports
  // WhatsApp). The captured session is seeded into the upstream plugin's
  // on-disk account store at build time, so it starts already logged in.
  auth: {
    mode: "host-qr",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "ZALOCLAWBOT_BOT_TOKEN",
      prompt: {
        label: "Zalo ClawBot token",
        help: "Captured automatically via a host-side QR scan during onboard — scan the QR with the Zalo app and approve the ClawBot mini-app. Owner-bound, DM-only.",
      },
    },
    {
      id: "accountId",
      kind: "config",
      required: true,
      envKey: "ZALOCLAWBOT_ACCOUNT_ID",
      statePath: "zaloClawbotConfig.accountId",
    },
    {
      id: "botId",
      kind: "config",
      required: true,
      envKey: "ZALOCLAWBOT_BOT_ID",
      statePath: "zaloClawbotConfig.botId",
    },
    {
      id: "ownerId",
      kind: "config",
      required: false,
      envKey: "ZALOCLAWBOT_OWNER_ID",
      statePath: "zaloClawbotConfig.ownerId",
    },
    {
      id: "oaId",
      kind: "config",
      required: false,
      envKey: "ZALOCLAWBOT_OA_ID",
      statePath: "zaloClawbotConfig.oaId",
    },
  ],
  credentials: [
    {
      id: "zaloClawbotBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-zaloclawbot-bridge",
      providerEnvKey: "ZALOCLAWBOT_BOT_TOKEN",
      placeholder: "openshell:resolve:env:ZALOCLAWBOT_BOT_TOKEN",
    },
  ],
  policyPresets: ["zalo-clawbot"],
  render: [
    {
      id: "zalo-clawbot-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.openclaw-zaloclawbot",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "openclaw-zaloclawbot",
      visibility: {
        configKeys: ["openclaw-zaloclawbot"],
        logPatterns: ["zaloclawbot", "openclaw-zaloclawbot"],
      },
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      // Third-party plugin published by Zalo, pinned to an exact early-stage
      // (0.x) version for reproducible builds. Not coupled to
      // {{openclaw.version}}; bump manually after verifying a new release.
      spec: "npm:@zalo-platforms/openclaw-zaloclawbot@0.1.4",
      pin: true,
      required: true,
    },
  ],
  state: {
    persist: {
      zaloClawbotConfig: ["accountId", "botId", "ownerId", "oaId"],
    },
    rebuildHydration: [
      { statePath: "zaloClawbotConfig.accountId", env: "ZALOCLAWBOT_ACCOUNT_ID" },
      { statePath: "zaloClawbotConfig.botId", env: "ZALOCLAWBOT_BOT_ID" },
      { statePath: "zaloClawbotConfig.ownerId", env: "ZALOCLAWBOT_OWNER_ID" },
      { statePath: "zaloClawbotConfig.oaId", env: "ZALOCLAWBOT_OA_ID" },
    ],
  },
  hooks: [
    {
      id: "zalo-clawbot-host-qr",
      phase: "enroll",
      handler: "zalo-clawbot.qrLogin",
      outputs: [
        { id: "botToken", kind: "secret", required: true },
        { id: "accountId", kind: "config", required: true },
        { id: "botId", kind: "config", required: true },
        { id: "ownerId", kind: "config" },
        { id: "oaId", kind: "config" },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "zalo-clawbot-seed-openclaw-account",
      phase: "post-agent-install",
      handler: "zalo-clawbot.seedOpenClawAccount",
      agents: ["openclaw"],
      inputs: [
        "zaloClawbotConfig.accountId",
        "zaloClawbotConfig.botId",
        "zaloClawbotConfig.ownerId",
        "zaloClawbotConfig.oaId",
        "credential.zaloClawbotBotToken.placeholder",
      ],
      outputs: [
        { id: "openclawZaloclawbotAccountsIndex", kind: "build-file", required: true },
        { id: "openclawZaloclawbotAccountFile", kind: "build-file", required: true },
        { id: "openclawConfigPatch", kind: "build-file", required: true },
      ],
      onFailure: "abort",
    },
  ],
} as const satisfies ChannelManifest;
