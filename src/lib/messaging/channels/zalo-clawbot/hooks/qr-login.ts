// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";

export interface ZaloClawbotLoginCredentials {
  readonly token: string;
  readonly accountId: string;
  readonly botId: string;
  readonly ownerId?: string;
  readonly oaId?: string;
}

export type ZaloClawbotLoginResult =
  | {
      readonly kind: "ok";
      readonly credentials: ZaloClawbotLoginCredentials;
      readonly summary?: string;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "expired"; readonly reason?: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "error"; readonly message?: string };

export const ZALOCLAWBOT_QR_LOGIN_HOOK_ID = "zalo-clawbot.qrLogin";

export interface ZaloClawbotQrLoginHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runLogin?: () => Promise<ZaloClawbotLoginResult>;
  readonly saveCredential?: (key: string, value: string) => void;
  readonly log?: (message: string) => void;
}

export function createZaloClawbotQrLoginHook(
  options: ZaloClawbotQrLoginHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    if (context.isInteractive === false) {
      (options.log ?? console.log)(
        `  Skipped ${context.channelId} (host QR login requires interactive mode)`,
      );
      throw new Error("Zalo ClawBot host QR login requires interactive mode.");
    }

    const runLogin = options.runLogin;
    if (!runLogin) {
      throw new Error(
        "Zalo ClawBot host QR login hook requires an injected runLogin implementation.",
      );
    }
    const result = await runLogin();
    if (result.kind !== "ok") {
      const reason = failureReason(result);
      (options.log ?? console.log)(`  Skipped ${context.channelId} (${reason})`);
      throw new Error(`Zalo ClawBot host QR login failed: ${reason}.`);
    }

    const saveCredential = options.saveCredential;
    if (!saveCredential) {
      throw new Error(
        "Zalo ClawBot host QR login hook requires an injected saveCredential implementation.",
      );
    }
    const env = options.env ?? process.env;
    const { token, accountId, botId, ownerId, oaId } = result.credentials;

    saveCredential("ZALOCLAWBOT_BOT_TOKEN", token);
    env.ZALOCLAWBOT_BOT_TOKEN = token;
    env.ZALOCLAWBOT_ACCOUNT_ID = accountId;
    env.ZALOCLAWBOT_BOT_ID = botId;
    if (ownerId) env.ZALOCLAWBOT_OWNER_ID = ownerId;
    if (oaId) env.ZALOCLAWBOT_OA_ID = oaId;
    const suffix = result.summary ? ` (${result.summary})` : ` (account ${accountId})`;
    (options.log ?? console.log)(`  ✓ ${context.channelId} login captured${suffix}`);

    const outputs: Record<string, MessagingHookOutputMap[string]> = {
      botToken: { kind: "secret", value: token },
      accountId: { kind: "config", value: accountId },
      botId: { kind: "config", value: botId },
    };
    if (ownerId) outputs.ownerId = { kind: "config", value: ownerId };
    if (oaId) outputs.oaId = { kind: "config", value: oaId };
    return { outputs };
  };
}

export function createZaloClawbotQrLoginHookRegistration(
  options: ZaloClawbotQrLoginHookOptions = {},
): MessagingHookRegistration {
  return {
    id: ZALOCLAWBOT_QR_LOGIN_HOOK_ID,
    handler: createZaloClawbotQrLoginHook(options),
  };
}

function failureReason(result: Exclude<ZaloClawbotLoginResult, { kind: "ok" }>): string {
  if (result.kind === "timeout") return "QR login timed out";
  if (result.kind === "expired") return "QR expired too many times";
  if (result.kind === "aborted") return "login aborted";
  return result.message || "unknown error";
}
