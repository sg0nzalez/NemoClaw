// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookInputMap,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";

export const ZALOCLAWBOT_SEED_OPENCLAW_ACCOUNT_HOOK_ID = "zalo-clawbot.seedOpenClawAccount";
export const ZALOCLAWBOT_TOKEN_PLACEHOLDER = "openshell:resolve:env:ZALOCLAWBOT_BOT_TOKEN";
export const ZALOCLAWBOT_PLUGIN_ID = "openclaw-zaloclawbot";

export interface ZaloClawbotSeedOpenClawAccountHookOptions {
  readonly now?: () => Date | string;
}

export function createZaloClawbotSeedOpenClawAccountHook(
  options: ZaloClawbotSeedOpenClawAccountHookOptions = {},
): MessagingHookHandler {
  return (context) => ({
    outputs: buildZaloClawbotSeedOpenClawAccountOutputs(context.inputs, options),
  });
}

export function createZaloClawbotSeedOpenClawAccountHookRegistration(
  options: ZaloClawbotSeedOpenClawAccountHookOptions = {},
): MessagingHookRegistration {
  return {
    id: ZALOCLAWBOT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
    handler: createZaloClawbotSeedOpenClawAccountHook(options),
  };
}

export function buildZaloClawbotSeedOpenClawAccountOutputs(
  inputs: MessagingHookInputMap | undefined,
  options: ZaloClawbotSeedOpenClawAccountHookOptions = {},
): MessagingHookOutputMap {
  const accountId = requiredInputString(inputs, "zaloClawbotConfig.accountId");
  assertSafeAccountId(accountId);
  const botId = requiredInputString(inputs, "zaloClawbotConfig.botId");
  const ownerId = optionalInputString(inputs, "zaloClawbotConfig.ownerId");
  const oaId = optionalInputString(inputs, "zaloClawbotConfig.oaId");
  const botToken =
    optionalInputString(inputs, "credential.zaloClawbotBotToken.placeholder") ||
    ZALOCLAWBOT_TOKEN_PLACEHOLDER;
  const savedAt = isoTimestamp(options.now);

  return {
    openclawZaloclawbotAccountsIndex: {
      kind: "build-file",
      value: {
        path: `${ZALOCLAWBOT_PLUGIN_ID}/accounts.json`,
        mode: "0600",
        content: [accountId],
      },
    },
    openclawZaloclawbotAccountFile: {
      kind: "build-file",
      value: {
        path: `${ZALOCLAWBOT_PLUGIN_ID}/accounts/${accountId}.json`,
        mode: "0600",
        content: {
          botId,
          botToken,
          ...(ownerId ? { ownerId } : {}),
          ...(oaId ? { oaId } : {}),
          savedAt,
        },
      },
    },
    openclawConfigPatch: {
      kind: "build-file",
      value: {
        path: "openclaw.json",
        // `openclaw plugins install` (the agentPackages step) owns the plugin
        // install + its provenance record, so we do NOT write plugins.installs
        // here — a hand-written record with a guessed installPath mismatches the
        // real load path and trips the "untracked local code" provenance warning.
        // We only enable the plugin entry and the channel (with its account).
        merge: {
          plugins: {
            entries: {
              [ZALOCLAWBOT_PLUGIN_ID]: {
                enabled: true,
              },
            },
          },
          channels: {
            [ZALOCLAWBOT_PLUGIN_ID]: {
              enabled: true,
              channelConfigUpdatedAt: savedAt,
            },
          },
        },
      },
    },
  };
}

function assertSafeAccountId(accountId: string): void {
  if (
    accountId === "." ||
    accountId === ".." ||
    /[\\/\0-\x1F\x7F]/.test(accountId) ||
    accountId.includes("..")
  ) {
    throw new Error("Zalo ClawBot account id contains unsafe filename characters.");
  }
}

function requiredInputString(inputs: MessagingHookInputMap | undefined, key: string): string {
  const value = optionalInputString(inputs, key);
  if (!value) {
    throw new Error(`Zalo ClawBot account seeding requires ${key}.`);
  }
  return value;
}

function optionalInputString(inputs: MessagingHookInputMap | undefined, key: string): string {
  const value = inputs?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function isoTimestamp(now: ZaloClawbotSeedOpenClawAccountHookOptions["now"]): string {
  const value = now?.() ?? new Date();
  return typeof value === "string" ? value : value.toISOString();
}
