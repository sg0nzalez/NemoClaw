// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import { createDefaultZaloClawbotHostQrLoginOptions } from "./host-qr-login-runtime";
import {
  createZaloClawbotQrLoginHookRegistration,
  type ZaloClawbotQrLoginHookOptions,
} from "./qr-login";
import {
  createZaloClawbotSeedOpenClawAccountHookRegistration,
  type ZaloClawbotSeedOpenClawAccountHookOptions,
} from "./seed-openclaw-account";

export * from "./qr-login";
export * from "./seed-openclaw-account";

export interface ZaloClawbotHookOptions {
  readonly qrLogin?: ZaloClawbotQrLoginHookOptions;
  readonly seedOpenClawAccount?: ZaloClawbotSeedOpenClawAccountHookOptions;
}

export function createZaloClawbotHookRegistrations(
  options: ZaloClawbotHookOptions = {},
): readonly MessagingHookRegistration[] {
  const qrLoginOptions = {
    ...createDefaultZaloClawbotHostQrLoginOptions(),
    ...withoutUndefinedValues(options.qrLogin),
  };
  return [
    createZaloClawbotQrLoginHookRegistration(qrLoginOptions),
    createZaloClawbotSeedOpenClawAccountHookRegistration(options.seedOpenClawAccount),
  ] as const;
}

function withoutUndefinedValues(
  options: ZaloClawbotQrLoginHookOptions | undefined,
): ZaloClawbotQrLoginHookOptions {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as ZaloClawbotQrLoginHookOptions;
}
