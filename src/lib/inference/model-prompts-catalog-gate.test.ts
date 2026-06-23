// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { BACK_TO_SELECTION, promptCloudModel } from "../../../dist/lib/inference/model-prompts";

function promptSequence(responses: string[]) {
  const queue = [...responses];
  return vi.fn(async () => queue.shift() ?? "");
}

describe("catalog-gated cloud model prompts", () => {
  it("accepts Kimi K2.7 Code from the default cloud model menu only after catalog validation", async () => {
    const promptFn = promptSequence(["6"]);
    const validateNvidiaEndpointModelFn = vi.fn(() => ({ ok: true }));
    const result = await promptCloudModel({
      promptFn,
      writeLine: vi.fn(),
      getCredentialFn: () => "nvapi-test",
      validateNvidiaEndpointModelFn,
    });

    expect(result).toBe("moonshotai/kimi-k2.7-code");
    expect(validateNvidiaEndpointModelFn).toHaveBeenCalledWith(
      "moonshotai/kimi-k2.7-code",
      "nvapi-test",
    );
  });

  it("rejects catalog-gated curated cloud models when NVIDIA /models omits them", async () => {
    const promptFn = promptSequence(["2", "1"]);
    const errorLine = vi.fn();
    const result = await promptCloudModel({
      promptFn,
      errorLine,
      writeLine: vi.fn(),
      getCredentialFn: () => "nvapi-test",
      cloudModelOptions: [
        { id: "nemotron", label: "Nemotron" },
        {
          id: "moonshotai/kimi-k2.7-code",
          label: "Kimi K2.7 Code",
          requiresCatalogValidation: true,
        },
      ],
      validateNvidiaEndpointModelFn: (model) => ({
        ok: model !== "moonshotai/kimi-k2.7-code",
        message: `Model '${model}' is not available from NVIDIA Endpoints. Checked https://integrate.api.nvidia.com/v1/models.`,
      }),
    });

    expect(result).toBe("nemotron");
    expect(errorLine).toHaveBeenCalledWith(
      "  Model 'moonshotai/kimi-k2.7-code' is not available from NVIDIA Endpoints. Checked https://integrate.api.nvidia.com/v1/models.",
    );
  });

  it("requires a local NVIDIA key before accepting catalog-gated curated models", async () => {
    const errorLine = vi.fn();
    const result = await promptCloudModel({
      promptFn: promptSequence(["1"]),
      errorLine,
      writeLine: vi.fn(),
      getCredentialFn: () => null,
      cloudModelOptions: [
        {
          id: "moonshotai/kimi-k2.7-code",
          label: "Kimi K2.7 Code",
          requiresCatalogValidation: true,
        },
      ],
    });

    expect(result).toBe(BACK_TO_SELECTION);
    expect(errorLine).toHaveBeenCalledWith(
      "  NVIDIA_INFERENCE_API_KEY is required before selecting Kimi K2.7 Code; NemoClaw must first confirm it appears in the NVIDIA Endpoints catalog.",
    );
  });

  it("does not keep defaulting to a rejected catalog-gated cloud model", async () => {
    const promptFn = promptSequence(["", ""]);
    const result = await promptCloudModel({
      promptFn,
      errorLine: vi.fn(),
      writeLine: vi.fn(),
      defaultModelId: "moonshotai/kimi-k2.7-code",
      getCredentialFn: () => "nvapi-test",
      cloudModelOptions: [
        { id: "nemotron", label: "Nemotron" },
        {
          id: "moonshotai/kimi-k2.7-code",
          label: "Kimi K2.7 Code",
          requiresCatalogValidation: true,
        },
      ],
      validateNvidiaEndpointModelFn: () => ({
        ok: false,
        message: "Model 'moonshotai/kimi-k2.7-code' is not available from NVIDIA Endpoints.",
      }),
    });

    expect(result).toBe("nemotron");
    expect(promptFn).toHaveBeenNthCalledWith(1, "  Choose model [2]: ");
    expect(promptFn).toHaveBeenNthCalledWith(2, "  Choose model [1]: ");
  });
});
