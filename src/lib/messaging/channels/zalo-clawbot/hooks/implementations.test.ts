// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MessagingHookRegistry, runMessagingHook } from "../../../hooks";
import { zaloClawbotManifest } from "../manifest";
import { createZaloClawbotQrLoginHook, ZALOCLAWBOT_QR_LOGIN_HOOK_ID } from "./qr-login";
import {
  buildZaloClawbotSeedOpenClawAccountOutputs,
  ZALOCLAWBOT_TOKEN_PLACEHOLDER,
} from "./seed-openclaw-account";

function enrollHook() {
  return zaloClawbotManifest.hooks.find((entry) => entry.id === "zalo-clawbot-host-qr")!;
}

describe("Zalo ClawBot hook implementations", () => {
  it("requires an injected runLogin implementation", async () => {
    const registry = new MessagingHookRegistry([
      { id: ZALOCLAWBOT_QR_LOGIN_HOOK_ID, handler: createZaloClawbotQrLoginHook() },
    ]);
    await expect(
      runMessagingHook(enrollHook(), registry, { channelId: "zalo-clawbot" }),
    ).rejects.toThrow("requires an injected runLogin implementation");
  });

  it("captures the bot token and stages non-secret account metadata", async () => {
    const env: NodeJS.ProcessEnv = {};
    const saved: Array<{ readonly key: string; readonly value: string }> = [];
    const registry = new MessagingHookRegistry([
      {
        id: ZALOCLAWBOT_QR_LOGIN_HOOK_ID,
        handler: createZaloClawbotQrLoginHook({
          env,
          log: () => {},
          saveCredential: (key, value) => saved.push({ key, value }),
          runLogin: async () => ({
            kind: "ok",
            credentials: {
              token: "123:secret",
              accountId: "clawbot-123",
              botId: "123",
              ownerId: "owner-1",
              oaId: "oa-1",
            },
          }),
        }),
      },
    ]);

    await expect(
      runMessagingHook(enrollHook(), registry, { channelId: "zalo-clawbot" }),
    ).resolves.toMatchObject({
      handlerId: ZALOCLAWBOT_QR_LOGIN_HOOK_ID,
      outputs: {
        botToken: { kind: "secret", value: "123:secret" },
        accountId: { kind: "config", value: "clawbot-123" },
        botId: { kind: "config", value: "123" },
        ownerId: { kind: "config", value: "owner-1" },
        oaId: { kind: "config", value: "oa-1" },
      },
    });
    expect(saved).toEqual([{ key: "ZALOCLAWBOT_BOT_TOKEN", value: "123:secret" }]);
    expect(env).toMatchObject({
      ZALOCLAWBOT_BOT_TOKEN: "123:secret",
      ZALOCLAWBOT_ACCOUNT_ID: "clawbot-123",
      ZALOCLAWBOT_BOT_ID: "123",
      ZALOCLAWBOT_OWNER_ID: "owner-1",
      ZALOCLAWBOT_OA_ID: "oa-1",
    });
  });

  it("clears stale owner/oa env when a login omits them", async () => {
    const env: NodeJS.ProcessEnv = {
      ZALOCLAWBOT_OWNER_ID: "stale-owner",
      ZALOCLAWBOT_OA_ID: "stale-oa",
    };
    const registry = new MessagingHookRegistry([
      {
        id: ZALOCLAWBOT_QR_LOGIN_HOOK_ID,
        handler: createZaloClawbotQrLoginHook({
          env,
          log: () => {},
          saveCredential: () => {},
          runLogin: async () => ({
            kind: "ok",
            credentials: { token: "456:secret", accountId: "clawbot-456", botId: "456" },
          }),
        }),
      },
    ]);

    const result = await runMessagingHook(enrollHook(), registry, { channelId: "zalo-clawbot" });

    expect(result.outputs).not.toHaveProperty("ownerId");
    expect(result.outputs).not.toHaveProperty("oaId");
    expect(env).not.toHaveProperty("ZALOCLAWBOT_OWNER_ID");
    expect(env).not.toHaveProperty("ZALOCLAWBOT_OA_ID");
  });

  it("skips the channel when QR login does not complete", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: ZALOCLAWBOT_QR_LOGIN_HOOK_ID,
        handler: createZaloClawbotQrLoginHook({
          log: () => {},
          saveCredential: () => {},
          runLogin: async () => ({ kind: "timeout" }),
        }),
      },
    ]);
    await expect(
      runMessagingHook(enrollHook(), registry, { channelId: "zalo-clawbot" }),
    ).rejects.toThrow("host QR login failed: QR login timed out");
  });

  it("seeds the account index, account file, and config patch with the token placeholder", () => {
    const outputs = buildZaloClawbotSeedOpenClawAccountOutputs(
      {
        "zaloClawbotConfig.accountId": "clawbot-123",
        "zaloClawbotConfig.botId": "123",
        "zaloClawbotConfig.ownerId": "owner-1",
        "zaloClawbotConfig.oaId": "oa-1",
        "credential.zaloClawbotBotToken.placeholder": ZALOCLAWBOT_TOKEN_PLACEHOLDER,
      },
      { now: () => "2026-06-24T00:00:00.000Z" },
    );

    expect(outputs.openclawZaloclawbotAccountsIndex.value).toEqual({
      path: "openclaw-zaloclawbot/accounts.json",
      mode: "0600",
      content: ["clawbot-123"],
    });
    expect(outputs.openclawZaloclawbotAccountFile.value).toEqual({
      path: "openclaw-zaloclawbot/accounts/clawbot-123.json",
      mode: "0600",
      content: {
        botId: "123",
        botToken: ZALOCLAWBOT_TOKEN_PLACEHOLDER,
        ownerId: "owner-1",
        oaId: "oa-1",
        savedAt: "2026-06-24T00:00:00.000Z",
      },
    });
    // The raw token never appears — only the OpenShell-resolved placeholder.
    expect(JSON.stringify(outputs)).not.toContain("123:secret");
    const patch = outputs.openclawConfigPatch.value as {
      merge: { plugins: { entries: Record<string, unknown> }; channels: Record<string, unknown> };
    };
    expect(patch.merge.plugins.entries["openclaw-zaloclawbot"]).toEqual({ enabled: true });
    expect(patch.merge.channels["openclaw-zaloclawbot"]).toMatchObject({ enabled: true });
  });

  it("rejects unsafe account ids before writing seed files", () => {
    expect(() =>
      buildZaloClawbotSeedOpenClawAccountOutputs({
        "zaloClawbotConfig.accountId": "../escape",
        "zaloClawbotConfig.botId": "123",
      }),
    ).toThrow("unsafe filename characters");
  });
});
