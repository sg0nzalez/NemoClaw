// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Focused managed-inference registry coverage split out of
// generate-openclaw-config.test.ts to keep that legacy file under its
// test-file-size budget.

import { describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";

const BASE_ENV: Record<string, string> = {
  NEMOCLAW_PROVIDER_KEY: "inference",
  NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
  NEMOCLAW_INFERENCE_API: "openai-completions",
  NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("null").toString("base64"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
  NEMOCLAW_CONTEXT_WINDOW: "131072",
  NEMOCLAW_MAX_TOKENS: "4096",
  NEMOCLAW_REASONING: "false",
  NEMOCLAW_AGENT_TIMEOUT: "600",
  HOME: "/tmp",
};

function buildInferenceConfig(model: string): any {
  return buildConfig({
    ...BASE_ENV,
    NEMOCLAW_MODEL: model,
    NEMOCLAW_PRIMARY_MODEL_REF: `inference/${model}`,
  } as any);
}

describe("generate-openclaw-config.mts: managed inference registry", () => {
  it("adds Kimi K2.6 compat through the existing managed inference setup", () => {
    const config = buildInferenceConfig("moonshotai/kimi-k2.6");

    expect(config.models.providers.inference.models[0].compat).toEqual({
      supportsStore: false,
      requiresStringContent: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
    });
    expect(config.plugins.entries["nemoclaw-kimi-inference-compat"]).toEqual({ enabled: true });
  });

  it("does not apply the K2.6 compat shim to Kimi K2.7 Code without source evidence", () => {
    const config = buildInferenceConfig("moonshotai/kimi-k2.7-code");

    expect(config.models.providers.inference.models[0].compat).toBeUndefined();
    expect(config.plugins.entries).not.toHaveProperty("nemoclaw-kimi-inference-compat");
  });
});
