// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildConfig,
  modelNameForOpenAiProvider,
  type Settings,
} from "../agents/langchain-deepagents-code/generate-config.ts";

const BASE_SETTINGS: Settings = {
  model: "nvidia/nemotron-3-super-120b-a12b",
  baseUrl: "https://inference.local/v1",
  providerKey: "inference",
  upstreamProvider: "nvidia-prod",
  inferenceApi: "openai-completions",
};

describe("modelNameForOpenAiProvider (#6325)", () => {
  it("preserves an Ollama tag containing a colon (`qwen2.5:7b`) verbatim", () => {
    // Regression for #6325: the old implementation split on the first `:`
    // and returned only the suffix, dropping `qwen2.5` and producing `7b`.
    expect(modelNameForOpenAiProvider("qwen2.5:7b")).toBe("qwen2.5:7b");
  });

  it("preserves an Ollama tag with an additional dash-qualified variant (`llama3.1:8b-instruct-q4_0`)", () => {
    expect(modelNameForOpenAiProvider("llama3.1:8b-instruct-q4_0")).toBe(
      "llama3.1:8b-instruct-q4_0",
    );
  });

  it("passes non-colonized model ids through unchanged", () => {
    expect(modelNameForOpenAiProvider("nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
    expect(modelNameForOpenAiProvider("gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  it("trims surrounding whitespace but does not otherwise mutate the value", () => {
    expect(modelNameForOpenAiProvider("  qwen2.5:7b  ")).toBe("qwen2.5:7b");
  });
});

describe("buildConfig for deepagents (#6325)", () => {
  it("emits the full Ollama colon-tagged model in both the default and the openai models array", () => {
    // Reporter's exact scenario: an Ollama model `qwen2.5:7b`. The generated
    // config.toml must keep the full tag on both the `default = "openai:…"`
    // line and inside `[models.providers.openai].models = […]`.
    const toml = buildConfig({ ...BASE_SETTINGS, model: "qwen2.5:7b" });
    expect(toml).toContain(`default = "openai:qwen2.5:7b"`);
    expect(toml).toContain(`models = ["qwen2.5:7b"]`);
    expect(toml).not.toContain(`default = "openai:7b"`);
    expect(toml).not.toContain(`models = ["7b"]`);
  });

  it("emits an unambiguous default + models entry when the model has no colon", () => {
    const toml = buildConfig({
      ...BASE_SETTINGS,
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
    expect(toml).toContain(`default = "openai:nvidia/nemotron-3-super-120b-a12b"`);
    expect(toml).toContain(`models = ["nvidia/nemotron-3-super-120b-a12b"]`);
  });

  it("keeps the openai: provider prefix as the only leading `openai:` token", () => {
    // Sanity: the fix must not accidentally double-prefix (e.g. produce
    // `openai:openai:qwen2.5:7b`).
    const toml = buildConfig({ ...BASE_SETTINGS, model: "qwen2.5:7b" });
    const openaiPrefixes = toml.match(/"openai:/g) ?? [];
    // One occurrence in the `[models] default` line, one in the `[models.providers.openai]`
    // header is a bare `openai` (no `"openai:` prefix), so the default-line hit is unique.
    expect(openaiPrefixes).toHaveLength(1);
  });
});
