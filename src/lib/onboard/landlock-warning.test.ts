// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { warnIfLandlockUnsupported } from "./landlock-warning";

describe("post-create Landlock warning", () => {
  it("warns when a best-effort sandbox uses an old Linux kernel", () => {
    const warn = vi.fn();

    warnIfLandlockUnsupported({
      compatibility: "best_effort",
      platform: "linux",
      dockerInfoFormat: vi.fn(() => ""),
      runCapture: vi.fn(() => "5.4.0-216-generic"),
      warn,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not support Landlock"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("best_effort mode"));
  });

  it("does not contradict a successful hard-required DCode startup (#5795)", () => {
    const dockerInfoFormat = vi.fn(() => "5.4.0");
    const runCapture = vi.fn(() => "5.4.0");
    const warn = vi.fn();

    warnIfLandlockUnsupported({
      compatibility: "hard_requirement",
      platform: "linux",
      dockerInfoFormat,
      runCapture,
      warn,
    });

    expect(dockerInfoFormat).not.toHaveBeenCalled();
    expect(runCapture).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not probe a macOS Docker VM after hard-required startup succeeds (#5795)", () => {
    const dockerInfoFormat = vi.fn(() => "5.4.0");
    const runCapture = vi.fn(() => "5.4.0");
    const warn = vi.fn();

    warnIfLandlockUnsupported({
      compatibility: "hard_requirement",
      platform: "darwin",
      dockerInfoFormat,
      runCapture,
      warn,
    });

    expect(dockerInfoFormat).not.toHaveBeenCalled();
    expect(runCapture).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
