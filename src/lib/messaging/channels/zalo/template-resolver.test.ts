// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingInputReference } from "../../manifest";
import { resolveZaloTemplateReference } from "./template-resolver";

describe("Zalo template resolver", () => {
  it.each([
    ["open", "open"],
    ["allowlist", "allowlist"],
    ["disabled", "disabled"],
    ["garbage", "allowlist"],
    ["", "allowlist"],
  ] as const)("resolves group policy %s -> %s", (value, expected) => {
    const inputs: SandboxMessagingInputReference[] = [
      {
        channelId: "zalo",
        inputId: "groupPolicy",
        kind: "config",
        required: false,
        statePath: "zaloConfig.groupPolicy",
        value,
      },
    ];

    expect(resolveZaloTemplateReference("zalo.groupPolicy", { inputs })?.value).toBe(expected);
  });
});
