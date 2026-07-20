// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  bedrockRuntimeForbiddenLeakPatterns,
  findForbiddenLeaks,
} from "../fixtures/bedrock-runtime-leak-scan.ts";

describe("Bedrock Runtime leak scan", () => {
  const patterns = bedrockRuntimeForbiddenLeakPatterns({
    adapterToken: "adapter-secret-value",
    bedrockHostname: "bedrock.example.test",
    compatibleKey: "user-secret-value",
  });

  it("allows the managed provider credential name without allowing its token value", () => {
    expect(
      findForbiddenLeaks(
        "@@NEMOCLAW_E2E_FILE@@ /proc/42/environ\nNEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN=[managed]",
        "sandbox snapshot",
        patterns,
      ),
    ).toEqual([]);

    expect(
      findForbiddenLeaks(
        "@@NEMOCLAW_E2E_FILE@@ /proc/42/environ\nadapter-secret-value",
        "sandbox snapshot",
        patterns,
      ),
    ).toEqual(["adapter token: /proc/42/environ"]);
  });

  it("reports other Bedrock credentials and routing details at their source", () => {
    expect(
      findForbiddenLeaks(
        [
          "@@NEMOCLAW_E2E_FILE@@ config.json",
          "user-secret-value",
          "AWS_BEARER_TOKEN_BEDROCK",
          "@@NEMOCLAW_E2E_FILE@@ runtime.log",
          "bedrock.example.test",
        ].join("\n"),
        "sandbox snapshot",
        patterns,
      ),
    ).toEqual([
      "AWS bearer env name: config.json",
      "fake user key: config.json",
      "raw Bedrock hostname: runtime.log",
    ]);
  });
});
