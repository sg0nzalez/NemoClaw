// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  countTokensWithVllm,
  parseProcessStartTime,
  parseVllmTokenMetrics,
  tokenDelta,
  validatedTelemetryUrl,
} from "../../scripts/bench/tool-disclosure/telemetry";

describe("vLLM benchmark telemetry", () => {
  it("sums labelled token counters and computes monotonic deltas", () => {
    const snapshot = parseVllmTokenMetrics(`
# HELP vllm:prompt_tokens_total prompt
vllm:prompt_tokens_total{model_name="bench",engine="0"} 100
vllm:prompt_tokens_total{model_name="bench",engine="1"} 20
vllm:generation_tokens_total{model_name="bench",engine="0"} 30
vllm:generation_tokens_total{model_name="bench",engine="1"} 2
`);
    expect(snapshot).toEqual({ prompt_tokens: 120, generation_tokens: 32 });
    expect(parseProcessStartTime("process_start_time_seconds 1712345678\n")).toBe(1712345678);
    expect(
      tokenDelta(
        { prompt_tokens: 100, generation_tokens: 30 },
        { prompt_tokens: 120, generation_tokens: 32 },
      ),
    ).toEqual({ prompt_tokens: 20, generation_tokens: 2, available: true });
    expect(
      tokenDelta(
        { prompt_tokens: 120, generation_tokens: 32 },
        { prompt_tokens: 100, generation_tokens: 30 },
      ).available,
    ).toBe(false);
  });

  it("rejects unsafe telemetry endpoints", () => {
    expect(() => validatedTelemetryUrl("http://example.com:8000", "/metrics")).toThrow(
      "only on loopback",
    );
    expect(() => validatedTelemetryUrl("https://user:secret@example.com", "/metrics")).toThrow(
      "must not contain credentials",
    );
    expect(validatedTelemetryUrl("http://127.0.0.1:8000/v1", "/metrics").toString()).toBe(
      "http://127.0.0.1:8000/metrics",
    );
  });

  it("rejects non-loopback HTTPS telemetry and tokenizer URLs for the local benchmark", () => {
    expect(() => validatedTelemetryUrl("https://inference.example/v1", "/metrics")).toThrow(
      "vLLM telemetry is allowed only on loopback",
    );
    expect(validatedTelemetryUrl("https://localhost:8000/v1", "/metrics").toString()).toBe(
      "https://localhost:8000/metrics",
    );
    expect(validatedTelemetryUrl("https://127.0.0.1:8000/v1", "/tokenize").toString()).toBe(
      "https://127.0.0.1:8000/tokenize",
    );
    expect(validatedTelemetryUrl("https://[::1]:8000/v1", "/metrics").toString()).toBe(
      "https://[::1]:8000/metrics",
    );
  });

  it("reads token count variants without exposing response bodies", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ tokens: [1, 2, 3, 4] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await expect(
      countTokensWithVllm("http://localhost:8000", "bench-model", "[]", fetchImpl),
    ).resolves.toBe(4);
  });
});
