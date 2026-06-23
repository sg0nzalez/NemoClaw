// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

const {
  getChatCompletionsProbeCurlArgs,
  getChatCompletionsProbePayload,
} = require("../../../dist/lib/inference/onboard-probes");

describe("Kimi NVIDIA Endpoints onboarding probes", () => {
  it("uses the Kimi validation budget for Kimi K2.7 Code without K2.6 thinking suppression", () => {
    expect(getChatCompletionsProbePayload("moonshotai/kimi-k2.7-code")).toEqual({
      model: "moonshotai/kimi-k2.7-code",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 8,
    });

    const args = getChatCompletionsProbeCurlArgs({
      authHeader: ["-H", "Authorization: Bearer nvapi-test"],
      model: "moonshotai/kimi-k2.7-code",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      isWsl: false,
    });

    expect(args).toContain("--max-time");
    expect(args[args.indexOf("--max-time") + 1]).toBe("60");
    expect(args).toContain(
      JSON.stringify(getChatCompletionsProbePayload("moonshotai/kimi-k2.7-code")),
    );
  });
});
