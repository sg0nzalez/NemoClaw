// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { warnIfLandlockUnsupported } from "./landlock-warning";

describe("warnIfLandlockUnsupported", () => {
  it("aborts onboarding on Linux kernels older than Landlock's 5.13 requirement", () => {
    const warn = vi.fn();

    expect(() =>
      warnIfLandlockUnsupported({
        platform: "linux",
        dockerInfoFormat: () => "",
        runCapture: () => "5.12.19-custom\n",
        warn,
      }),
    ).toThrow(/does not support Landlock/);

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("silently degrade"));
  });

  it("allows Linux kernels that satisfy Landlock's 5.13 requirement", () => {
    const warn = vi.fn();

    expect(() =>
      warnIfLandlockUnsupported({
        platform: "linux",
        dockerInfoFormat: () => "",
        runCapture: () => "5.13.0-1029\n",
        warn,
      }),
    ).not.toThrow();

    expect(warn).not.toHaveBeenCalled();
  });
});
