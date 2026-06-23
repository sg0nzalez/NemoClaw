// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import { probeRemoteProviderHealth } from "../../../dist/lib/inference/health";
import { BUILD_ENDPOINT_URL } from "../../../dist/lib/inference/provider-models";

describe("Kimi NVIDIA Endpoints health probes", () => {
  it("uses Kimi K2.7 Code chat completions without K2.6 thinking suppression", () => {
    let capturedArgv: string[] = [];
    const result = probeRemoteProviderHealth("nvidia-prod", {
      model: "moonshotai/kimi-k2.7-code",
      getCredentialImpl: (envName) =>
        envName === "NVIDIA_INFERENCE_API_KEY" ? "nvapi-test" : null,
      runCurlProbeImpl: (argv) => {
        capturedArgv = argv;
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: '{"choices":[{"message":{"content":"OK"}}]}',
          stderr: "",
          message: "HTTP 200",
        };
      },
    });

    expect(result?.ok).toBe(true);
    expect(result?.probed).toBe(true);
    expect(result?.detail).toContain("Kimi K2.7 Code chat-completions route");
    expect(capturedArgv.at(-1)).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);
    const payload = JSON.parse(capturedArgv[capturedArgv.indexOf("-d") + 1]);
    expect(payload).toEqual({
      model: "moonshotai/kimi-k2.7-code",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 8,
    });
  });
});
