// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Verify sandbox names stay validated and out of raw shell command strings.
import path from "path";
import { describe, expect, it } from "vitest";

describe("sandboxName command hardening in onboard.js", () => {
  it("re-validates sandboxName at the createSandbox boundary", async () => {
    const onboardModule = await import("../src/lib/onboard.js");
    const { createSandbox } = onboardModule as unknown as {
      createSandbox: (
        gpu: null,
        model: string,
        provider: string,
        preferredInferenceApi: null,
        sandboxNameOverride: string,
      ) => Promise<string>;
    };

    await expect(
      createSandbox(null, "test-model", "nvidia-prod", null, "bad; touch /tmp/pwned"),
    ).rejects.toThrow(/Invalid sandbox name/);
  });

  it("builds openshell argv with an explicit openshellBinary override", async () => {
    const onboardModule = await import("../src/lib/onboard.js");
    const onboard = onboardModule as unknown as {
      openshellArgv: (args: string[], opts?: { openshellBinary?: string }) => string[];
    };

    expect(
      onboard.openshellArgv(["--version"], { openshellBinary: "/tmp/custom-openshell" }),
    ).toEqual(["/tmp/custom-openshell", "--version"]);
  });
});
