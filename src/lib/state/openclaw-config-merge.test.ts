// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { mergeOpenClawRestoredConfig } from "../../../dist/lib/state/openclaw-config-merge";

describe("mergeOpenClawRestoredConfig", () => {
  it("keeps rebuilt runtime-owned config while restoring durable backup-only settings", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        gateway: undefined,
        models: {
          providers: {
            nvidia: { models: [{ id: "stale-model" }] },
            custom: { models: [{ id: "custom-model" }] },
          },
        },
        channels: {
          discord: { accounts: { default: { token: "openshell:resolve:env:v111_TOKEN" } } },
          slack: { accounts: { default: { botToken: "[STRIPPED_BY_MIGRATION]" } } },
          matrix: { accounts: { default: { room: "#ops" } } },
        },
        plugins: { entries: { discord: { enabled: false }, customPlugin: { enabled: true } } },
        mcpServers: { filesystem: { command: "npx" } },
        customAgents: { researcher: { prompt: "be thorough" } },
      },
      {
        gateway: { auth: { token: "fresh-token" } },
        diagnostics: { otel: true },
        models: { providers: { nvidia: { models: [{ id: "fresh-model" }] } } },
        channels: {
          discord: { accounts: { default: { token: "openshell:resolve:env:v222_TOKEN" } } },
          whatsapp: { accounts: { default: { enabled: true } } },
        },
        plugins: { entries: { discord: { enabled: true } } },
      },
    );

    expect(merged).toMatchObject({
      gateway: { auth: { token: "fresh-token" } },
      diagnostics: { otel: true },
      models: {
        providers: {
          nvidia: { models: [{ id: "fresh-model" }] },
          custom: { models: [{ id: "custom-model" }] },
        },
      },
      channels: {
        discord: { accounts: { default: { token: "openshell:resolve:env:v222_TOKEN" } } },
        whatsapp: { accounts: { default: { enabled: true } } },
        matrix: { accounts: { default: { room: "#ops" } } },
      },
      plugins: { entries: { discord: { enabled: true }, customPlugin: { enabled: true } } },
      mcpServers: { filesystem: { command: "npx" } },
      customAgents: { researcher: { prompt: "be thorough" } },
    });
    expect((merged as { channels: Record<string, unknown> }).channels.slack).toBeUndefined();
  });

  it("does not resurrect managed channels when the rebuilt config omits channels", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        channels: {
          telegram: { accounts: { default: { token: "openshell:resolve:env:v111_TOKEN" } } },
          matrix: { accounts: { default: { room: "#ops" } } },
        },
      },
      { gateway: { auth: { token: "fresh-token" } } },
    );

    expect(merged).toMatchObject({
      gateway: { auth: { token: "fresh-token" } },
      channels: { matrix: { accounts: { default: { room: "#ops" } } } },
    });
    expect((merged as { channels: Record<string, unknown> }).channels.telegram).toBeUndefined();
  });

  it("preserves backup provider and plugin entries when current entry maps are absent", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        models: { providers: { custom: { models: [{ id: "custom-model" }] } } },
        plugins: { entries: { customPlugin: { enabled: true } } },
      },
      { models: { mode: "route-through-gateway" }, plugins: { load: { paths: ["/plugins"] } } },
    );

    expect(merged).toMatchObject({
      models: {
        mode: "route-through-gateway",
        providers: { custom: { models: [{ id: "custom-model" }] } },
      },
      plugins: {
        load: { paths: ["/plugins"] },
        entries: { customPlugin: { enabled: true } },
      },
    });
  });

  it("preserves user-tuned model fields when the rebuilt model id is unchanged (#5202)", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        models: {
          providers: {
            inference: {
              baseUrl: "https://inference.local/v1",
              apiKey: "unused",
              api: "openai-completions",
              models: [
                {
                  id: "nvidia/Qwen3.6-35B-A3B-NVFP4",
                  name: "inference/nvidia/Qwen3.6-35B-A3B-NVFP4",
                  reasoning: true,
                  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
                  contextWindow: 262000,
                  maxTokens: 32768,
                  compat: { thinkingFormat: "qwen-chat-template", supportsPromptCacheKey: true },
                },
              ],
            },
          },
        },
      },
      {
        models: {
          providers: {
            inference: {
              baseUrl: "https://inference.local/v1",
              apiKey: "unused",
              api: "openai-completions",
              models: [
                {
                  id: "nvidia/Qwen3.6-35B-A3B-NVFP4",
                  name: "inference/nvidia/Qwen3.6-35B-A3B-NVFP4",
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 262000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    );

    const model = (
      merged as {
        models: { providers: { inference: { models: Record<string, unknown>[] } } };
      }
    ).models.providers.inference.models[0];
    expect(model).toMatchObject({
      id: "nvidia/Qwen3.6-35B-A3B-NVFP4",
      reasoning: true,
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      maxTokens: 32768,
      compat: { thinkingFormat: "qwen-chat-template", supportsPromptCacheKey: true },
    });
  });

  it("does not resurrect tuning from a model the user switched away from", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        models: {
          providers: {
            inference: {
              models: [{ id: "old/model", reasoning: true, maxTokens: 32768 }],
            },
          },
        },
      },
      {
        models: {
          providers: {
            inference: {
              models: [{ id: "new/model", reasoning: false, maxTokens: 4096 }],
            },
          },
        },
      },
    );

    expect(merged).toMatchObject({
      models: {
        providers: {
          inference: { models: [{ id: "new/model", reasoning: false, maxTokens: 4096 }] },
        },
      },
    });
  });

  it("keeps current provider and plugin entries for matching keys", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        models: {
          providers: {
            nvidia: { models: [{ id: "stale" }], apiKey: "unused" },
            custom: { models: [{ id: "stale-custom" }] },
            backupOnly: { models: [{ id: "backup-only" }] },
          },
        },
        plugins: {
          entries: {
            discord: { enabled: false },
            customPlugin: { enabled: true },
            backupOnlyPlugin: { enabled: true },
          },
        },
      },
      {
        models: {
          providers: {
            nvidia: { models: [{ id: "fresh" }], apiKey: "unused" },
            custom: { models: [{ id: "fresh-custom" }] },
          },
        },
        plugins: { entries: { discord: { enabled: true }, customPlugin: { enabled: false } } },
      },
    );

    expect(merged).toMatchObject({
      models: {
        providers: {
          nvidia: { models: [{ id: "fresh" }], apiKey: "unused" },
          custom: { models: [{ id: "fresh-custom" }] },
          backupOnly: { models: [{ id: "backup-only" }] },
        },
      },
      plugins: {
        entries: {
          discord: { enabled: true },
          customPlugin: { enabled: false },
          backupOnlyPlugin: { enabled: true },
        },
      },
    });
  });
});
