// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { providerModelConfigChanged } from "./sandbox-drift";

describe("providerModelConfigChanged", () => {
  it("does not force recreation when no sandbox registry entry exists", () => {
    expect(providerModelConfigChanged(null, "nvidia", "nemotron")).toBe(false);
  });

  it("recreates when provider or model differs from recorded sandbox metadata", () => {
    expect(
      providerModelConfigChanged(
        { name: "alpha", provider: "nvidia", model: "old-model" } as any,
        "nvidia",
        "new-model",
      ),
    ).toBe(true);
  });

  it("fails closed when existing sandbox metadata is missing provider/model fields", () => {
    expect(providerModelConfigChanged({ name: "alpha" } as any, "nvidia", "nemotron")).toBe(true);
  });

  it("fails closed when existing sandbox metadata has malformed provider/model fields", () => {
    expect(
      providerModelConfigChanged(
        { name: "alpha", provider: "", model: ["nemotron"] } as any,
        "nvidia",
        "nemotron",
      ),
    ).toBe(true);
  });
});
