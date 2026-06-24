// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { saveCredential } from "../../../../credentials/store";
import { runZaloClawbotHostQrLogin } from "../login";
import { zaloClawbotManifest } from "../manifest";
import type { ZaloClawbotLoginResult, ZaloClawbotQrLoginHookOptions } from "./qr-login";

export function createDefaultZaloClawbotHostQrLoginOptions(): ZaloClawbotQrLoginHookOptions {
  return {
    saveCredential,
    runLogin: createZaloClawbotHostQrLoginRunner(),
  };
}

function createZaloClawbotHostQrLoginRunner(): () => Promise<ZaloClawbotLoginResult> {
  return async () => {
    logEnrollmentHelp();
    const result = await runZaloClawbotHostQrLogin();
    if (result.kind !== "ok") return result;
    return {
      kind: "ok",
      summary: `account ${result.credentials.accountId}`,
      credentials: result.credentials,
    };
  };
}

function logEnrollmentHelp(): void {
  const help = zaloClawbotManifest.enrollmentHelp;
  if (!help) return;
  console.log("");
  console.log(`  ${help}`);
}
