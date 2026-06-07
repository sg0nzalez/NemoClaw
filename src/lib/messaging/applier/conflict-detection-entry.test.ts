// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../manifest";
import type { SandboxMessagingState } from "../../state/registry";
import {
  conflictReasonForPair,
  conflictReasonForRequest,
  detectAllOverlapsInEntries,
  findConflictsInEntries,
  hasStoredChannelInEntry,
  type ConflictRegistryEntry,
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

function planEntry(name: string, plan: SandboxMessagingPlan): ConflictRegistryEntry {
  const state: SandboxMessagingState = { schemaVersion: 1, plan };
  return { name, messaging: state };
}

// ---------------------------------------------------------------------------
// hasStoredChannelInEntry
// ---------------------------------------------------------------------------

describe("hasStoredChannelInEntry", () => {
  it("returns true for an active channel in a plan-backed entry", () => {
    const entry = planEntry("sb", makePlan("sb", { channels: [tgChannel()] }));
    expect(hasStoredChannelInEntry(entry, "telegram")).toBe(true);
  });

  it("returns false when channel is in plan.disabledChannels", () => {
    const entry = planEntry(
      "sb",
      makePlan("sb", { disabledChannels: ["telegram"], channels: [tgChannel(true, true)] }),
    );
    expect(hasStoredChannelInEntry(entry, "telegram")).toBe(false);
  });

  it("returns false when channel.active is false", () => {
    const entry = planEntry("sb", makePlan("sb", { channels: [tgChannel(false, false)] }));
    expect(hasStoredChannelInEntry(entry, "telegram")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// conflictReasonForRequest
// ---------------------------------------------------------------------------

describe("conflictReasonForRequest", () => {
  it("detects matching-token when same channel hash matches", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      }),
    ).toBe("matching-token");
  });

  it("returns null when same channel hash differs", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-b" },
      }),
    ).toBeNull();
  });

  it("does not produce false positives from unrelated-channel hashes", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-a"), ...slackBindings("hash-slack")],
      }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg-b" },
      }),
    ).toBeNull();
  });

  it("returns unknown-token when plan has no hashes for the channel", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding()] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      }),
    ).toBe("unknown-token");
  });
});

// ---------------------------------------------------------------------------
// conflictReasonForPair
// ---------------------------------------------------------------------------

describe("conflictReasonForPair", () => {
  it("detects matching-token between two plan-backed entries", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBe("matching-token");
  });

  it("returns null when same-channel hashes differ", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-b")] }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBeNull();
  });

  it("scopes comparison to the requested channel, ignoring other channels", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-a"), ...slackBindings("hash-slack")],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-b"), ...slackBindings("hash-slack")],
      }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBeNull();
    expect(conflictReasonForPair("slack", alice, bob)).toBe("matching-token");
  });
});

// ---------------------------------------------------------------------------
// findConflictsInEntries
// ---------------------------------------------------------------------------

describe("findConflictsInEntries", () => {
  it("detects matching-token against a plan-only entry", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      findConflictsInEntries(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        [alice],
      ),
    ).toEqual([{ channel: "telegram", sandbox: "alice", reason: "matching-token" }]);
  });

  it("ignores a disabled channel in a plan-backed entry", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        disabledChannels: ["telegram"],
        channels: [tgChannel(true, true)],
        credentialBindings: [tgBinding("hash-a")],
      }),
    );
    expect(
      findConflictsInEntries(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        [alice],
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectAllOverlapsInEntries
// ---------------------------------------------------------------------------

describe("detectAllOverlapsInEntries", () => {
  it("reports matching-token overlap between two plan-backed entries", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(detectAllOverlapsInEntries([alice, bob])).toEqual([
      { channel: "telegram", sandboxes: ["alice", "bob"], reason: "matching-token" },
    ]);
  });

  it("does not report overlap when shared channel is disabled in one plan", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        disabledChannels: ["telegram"],
        channels: [tgChannel(true, true)],
        credentialBindings: [tgBinding("hash-a")],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(detectAllOverlapsInEntries([alice, bob])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Legacy-entry cross-channel hash scoping
// ---------------------------------------------------------------------------

describe("legacy entry cross-channel hash scoping", () => {
  it("conflictReasonForRequest — does not produce unknown-token from unrelated Slack keys on a Telegram request", () => {
    // A legacy entry with both Telegram and Slack hashes stored in the flat
    // providerCredentialHashes map must not make Slack keys visible when the
    // request is for Telegram only.
    const legacy: ConflictRegistryEntry = {
      name: "alice",
      messagingChannels: ["telegram", "slack"],
      providerCredentialHashes: {
        TELEGRAM_BOT_TOKEN: "hash-tg-a",
        SLACK_BOT_TOKEN: "hash-slack",
        SLACK_APP_TOKEN: "hash-slack-app",
      },
    };
    expect(
      conflictReasonForRequest(legacy, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg-b" },
      }),
    ).toBeNull(); // distinct Telegram tokens — Slack keys must not inflate this to unknown-token
  });

  it("conflictReasonForRequest — still detects matching-token for the correct channel", () => {
    const legacy: ConflictRegistryEntry = {
      name: "alice",
      messagingChannels: ["telegram", "slack"],
      providerCredentialHashes: {
        TELEGRAM_BOT_TOKEN: "hash-tg-shared",
        SLACK_BOT_TOKEN: "hash-slack",
      },
    };
    expect(
      conflictReasonForRequest(legacy, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg-shared" },
      }),
    ).toBe("matching-token");
  });

  it("conflictReasonForPair — does not report matching-token Telegram overlap from matching Slack hashes", () => {
    const alice: ConflictRegistryEntry = {
      name: "alice",
      messagingChannels: ["telegram", "slack"],
      providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg-a", SLACK_BOT_TOKEN: "shared-slack" },
    };
    const bob: ConflictRegistryEntry = {
      name: "bob",
      messagingChannels: ["telegram", "slack"],
      providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg-b", SLACK_BOT_TOKEN: "shared-slack" },
    };
    // Telegram tokens differ — Slack match must not bleed into Telegram comparison
    expect(conflictReasonForPair("telegram", alice, bob)).toBeNull();
    // Slack comparison should still correctly flag the shared Slack hash
    expect(conflictReasonForPair("slack", alice, bob)).toBe("matching-token");
  });
});
