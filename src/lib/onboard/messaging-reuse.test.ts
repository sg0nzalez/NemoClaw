// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { getManifestProviderNamesForChannel } from "../messaging/provider-bindings";
import { getNonInteractiveStoredMessagingChannels } from "./messaging-reuse";

const messagingChannels = [
  { name: "discord", envKey: "DISCORD_BOT_TOKEN" },
  { name: "slack", envKey: "SLACK_BOT_TOKEN" },
  { name: "wechat", envKey: "WECHAT_BOT_TOKEN" },
];

describe("onboard messaging reuse", () => {
  it("derives reusable provider names from messaging manifests", () => {
    expect(getManifestProviderNamesForChannel("assistant", "discord")).toEqual([
      "assistant-discord-bridge",
    ]);
    expect(getManifestProviderNamesForChannel("assistant", "telegram")).toEqual([
      "assistant-telegram-bridge",
    ]);
    expect(getManifestProviderNamesForChannel("assistant", "wechat")).toEqual([
      "assistant-wechat-bridge",
    ]);
    expect(getManifestProviderNamesForChannel("assistant", "slack")).toEqual([
      "assistant-slack-bridge",
      "assistant-slack-app",
    ]);
  });

  it("requires both Slack providers before reusing a stored Slack channel", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      false,
      null,
      "assistant",
      messagingChannels,
      () => false,
      () => ({ messagingChannels: ["slack"] }),
      () => [],
      (provider) => provider === "assistant-slack-bridge",
      true,
    );

    expect(reusedChannels).toBeNull();
  });

  it("prefers stored manifest-plan credential bindings over compatibility fallback", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      false,
      null,
      "assistant",
      messagingChannels,
      () => false,
      () => ({
        messagingChannels: ["slack"],
        messaging: {
          plan: {
            credentialBindings: [
              { channelId: "slack", providerName: "assistant-slack-bot-from-plan" },
              { channelId: "slack", providerName: "assistant-slack-app-from-plan" },
            ],
          } as unknown as SandboxMessagingPlan,
        },
      }),
      () => [],
      (provider) =>
        provider === "assistant-slack-bot-from-plan" ||
        provider === "assistant-slack-app-from-plan",
      true,
    );

    expect(reusedChannels).toEqual(["slack"]);
  });

  it("reuses stored Slack channels when both Slack providers exist", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      false,
      null,
      "assistant",
      messagingChannels,
      () => false,
      () => ({ messagingChannels: ["slack"] }),
      () => [],
      (provider) =>
        provider === "assistant-slack-bridge" || provider === "assistant-slack-app",
      true,
    );

    expect(reusedChannels).toEqual(["slack"]);
  });

  it("reuses a stored WeChat channel when its bridge provider exists", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      false,
      null,
      "assistant",
      messagingChannels,
      () => false,
      () => ({ messagingChannels: ["wechat"] }),
      () => [],
      (provider) => provider === "assistant-wechat-bridge",
      true,
    );

    expect(reusedChannels).toEqual(["wechat"]);
  });

  it("honors an explicit empty resume messaging channel set", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      true,
      ["unknown"],
      "assistant",
      messagingChannels,
      () => false,
      () => ({ messagingChannels: ["discord"] }),
      () => [],
      () => true,
      true,
    );

    expect(reusedChannels).toEqual([]);
  });

  it("does not rediscover token-backed channels when resume recorded none", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      true,
      [],
      "assistant",
      messagingChannels,
      () => true,
      () => ({ messagingChannels: ["discord"] }),
      () => [],
      () => true,
      true,
    );

    expect(reusedChannels).toEqual([]);
  });

  it("keeps provider-binding production paths free of channel-specific suffix branches", () => {
    const sourcePaths = [
      path.join(import.meta.dirname, "messaging-reuse.ts"),
      path.join(import.meta.dirname, "..", "messaging", "provider-bindings.ts"),
    ];
    for (const sourcePath of sourcePaths) {
      const source = fs.readFileSync(sourcePath, "utf-8");
      expect(source).not.toMatch(
        /\b(?:channel|channelId)\s*={2,3}\s*["'](?:discord|telegram|wechat|slack)["']/,
      );
      expect(source).not.toMatch(
        /["'`][^"'`]*(?:-discord-bridge|-telegram-bridge|-wechat-bridge|-slack-bridge|-slack-app)/,
      );
    }
  });
});
