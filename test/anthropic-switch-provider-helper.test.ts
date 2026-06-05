// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helperPath = path.resolve("test/e2e/lib/anthropic-switch-provider.sh");

function runHelperScenario(script: string) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HELPER_PATH: helperPath,
    },
  });
}

describe("anthropic switch provider helper", () => {
  it("requires an explicit compatible Anthropic key for non-mock endpoint switches", () => {
    const result = runHelperScenario(`
      set -u
      pass() { printf 'PASS:%s\\n' "$*" >&2; }
      fail() { printf 'FAIL:%s\\n' "$*" >&2; }
      openshell() { printf 'openshell should not run\\n' >&2; return 99; }
      # shellcheck source=test/e2e/lib/anthropic-switch-provider.sh
      . "$HELPER_PATH"
      SWITCH_PROVIDER=compatible-anthropic-endpoint
      SWITCH_INFERENCE_API=anthropic-messages
      SWITCH_MOCK_ANTHROPIC=0
      SWITCH_ENDPOINT_URL=http://example.invalid
      NVIDIA_API_KEY=nvapi-real-key
      unset COMPATIBLE_ANTHROPIC_API_KEY
      ensure_compatible_anthropic_switch_provider
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COMPATIBLE_ANTHROPIC_API_KEY is required");
    expect(result.stderr).not.toContain("openshell should not run");
  });
});
