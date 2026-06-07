// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../manifest";
import {
  getActiveChannelIdsFromPlan,
  getCredentialHashesFromPlan,
  planToConflictChannelRequests,
} from "./conflict-detection";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlan(
  sandboxName: string,
  overrides: Partial<SandboxMessagingPlan> = {},
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
    ...overrides,
  };
}

function tgChannel(active = true, disabled = false) {
  return {
    channelId: "telegram" as const,
    displayName: "Telegram",
    authMode: "token-paste" as const,
    active,
    selected: true,
    configured: true,
    disabled,
    inputs: [],
    hooks: [],
  };
}

function tgBinding(hash?: string): SandboxMessagingPlan["credentialBindings"][number] {
  return {
    channelId: "telegram",
    credentialId: "telegramBotToken",
    sourceInput: "botToken",
    providerName: "sb-telegram-bridge",
    providerEnvKey: "TELEGRAM_BOT_TOKEN",
    placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    credentialAvailable: true,
    ...(hash !== undefined ? { credentialHash: hash } : {}),
  };
}

function slackChannel() {
  return {
    channelId: "slack" as const,
    displayName: "Slack",
    authMode: "token-paste" as const,
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks: [],
  };
}

function slackBindings(botHash?: string, appHash?: string) {
  return [
    {
      channelId: "slack" as const,
      credentialId: "slackBotToken",
      sourceInput: "botToken",
      providerName: "sb-slack-bridge",
      providerEnvKey: "SLACK_BOT_TOKEN",
      placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
      credentialAvailable: true,
      ...(botHash ? { credentialHash: botHash } : {}),
    },
    {
      channelId: "slack" as const,
      credentialId: "slackAppToken",
      sourceInput: "appToken",
      providerName: "sb-slack-app",
      providerEnvKey: "SLACK_APP_TOKEN",
      placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
      credentialAvailable: true,
      ...(appHash ? { credentialHash: appHash } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------
// getActiveChannelIdsFromPlan
// ---------------------------------------------------------------------------

describe("getActiveChannelIdsFromPlan", () => {
  it("returns active channel ids", () => {
    const plan = makePlan("sb", { channels: [tgChannel(true, false)] });
    expect(getActiveChannelIdsFromPlan(plan)).toEqual(["telegram"]);
  });

  it("excludes channels in disabledChannels", () => {
    const plan = makePlan("sb", {
      disabledChannels: ["telegram"],
      channels: [tgChannel(true, false)],
    });
    expect(getActiveChannelIdsFromPlan(plan)).toEqual([]);
  });

  it("excludes channels where channel.disabled is true", () => {
    const plan = makePlan("sb", { channels: [tgChannel(true, true)] });
    expect(getActiveChannelIdsFromPlan(plan)).toEqual([]);
  });

  it("excludes channels where channel.active is false", () => {
    const plan = makePlan("sb", { channels: [tgChannel(false, false)] });
    expect(getActiveChannelIdsFromPlan(plan)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getCredentialHashesFromPlan
// ---------------------------------------------------------------------------

describe("getCredentialHashesFromPlan", () => {
  it("returns hashes keyed by providerEnvKey", () => {
    const plan = makePlan("sb", { credentialBindings: [tgBinding("hash-x")] });
    expect(getCredentialHashesFromPlan(plan)).toEqual({ TELEGRAM_BOT_TOKEN: "hash-x" });
  });

  it("scopes to a single channel when channelId is provided", () => {
    const plan = makePlan("sb", {
      credentialBindings: [tgBinding("hash-tg"), ...slackBindings("hash-bot", "hash-app")],
    });
    expect(getCredentialHashesFromPlan(plan, "telegram")).toEqual({
      TELEGRAM_BOT_TOKEN: "hash-tg",
    });
    expect(getCredentialHashesFromPlan(plan, "slack")).toEqual({
      SLACK_BOT_TOKEN: "hash-bot",
      SLACK_APP_TOKEN: "hash-app",
    });
  });

  it("omits bindings without a credentialHash", () => {
    const plan = makePlan("sb", { credentialBindings: [tgBinding()] });
    expect(getCredentialHashesFromPlan(plan)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// planToConflictChannelRequests
// ---------------------------------------------------------------------------

describe("planToConflictChannelRequests", () => {
  it("returns one request per active channel that has a credential available", () => {
    const plan = makePlan("sb", {
      channels: [tgChannel()],
      credentialBindings: [tgBinding("hash-tg")],
    });
    expect(planToConflictChannelRequests(plan)).toEqual([
      { channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg" } },
    ]);
  });

  it("includes a channel with credentialAvailable=true but no hash (unknown-token fallback)", () => {
    const plan = makePlan("sb", { channels: [tgChannel()], credentialBindings: [tgBinding()] });
    const requests = planToConflictChannelRequests(plan);
    expect(requests).toHaveLength(1);
    expect(requests[0].channel).toBe("telegram");
    expect(requests[0].credentialHashes).toEqual({});
  });

  it("groups multiple bindings for the same channel (Slack bot + app tokens)", () => {
    const plan = makePlan("sb", {
      channels: [slackChannel()],
      credentialBindings: slackBindings("hash-bot", "hash-app"),
    });
    expect(planToConflictChannelRequests(plan)).toEqual([
      { channel: "slack", credentialHashes: { SLACK_BOT_TOKEN: "hash-bot", SLACK_APP_TOKEN: "hash-app" } },
    ]);
  });

  it("skips bindings where credentialAvailable is false", () => {
    const plan = makePlan("sb", {
      channels: [tgChannel()],
      credentialBindings: [{ ...tgBinding("hash-tg"), credentialAvailable: false }],
    });
    expect(planToConflictChannelRequests(plan)).toEqual([]);
  });

  it("skips channels in disabledChannels", () => {
    const plan = makePlan("sb", {
      disabledChannels: ["telegram"],
      channels: [tgChannel(true, true)],
      credentialBindings: [tgBinding("hash-tg")],
    });
    expect(planToConflictChannelRequests(plan)).toEqual([]);
  });

  it("skips credentialAvailable bindings whose channel is absent from plan.channels", () => {
    const plan = makePlan("sb", { credentialBindings: [tgBinding("hash-tg")] });
    expect(planToConflictChannelRequests(plan)).toEqual([]);
  });

  it("skips credentialAvailable bindings whose channel.active is false", () => {
    const plan = makePlan("sb", {
      channels: [tgChannel(false, false)],
      credentialBindings: [tgBinding("hash-tg")],
    });
    expect(planToConflictChannelRequests(plan)).toEqual([]);
  });

  it("WhatsApp — no-op: empty credentials produce no conflict requests", () => {
    const plan = makePlan("sb", {
      channels: [
        {
          channelId: "whatsapp",
          displayName: "WhatsApp",
          authMode: "in-sandbox-qr",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
      ],
      credentialBindings: [],
    });
    expect(planToConflictChannelRequests(plan)).toEqual([]);
  });
});
