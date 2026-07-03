// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { envForcesSandboxBaseImageRefresh } from "./base-image-resolution-flow";

describe("sandbox base-image refresh environment", () => {
  it.each([
    "1",
    "true",
    "yes",
    "on",
    " TRUE ",
    "\tOn\n",
  ])("treats %j as an explicit refresh request (#4680)", (value) => {
    expect(
      envForcesSandboxBaseImageRefresh({
        NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH: value,
      }),
    ).toBe(true);
  });

  it.each([
    "",
    "0",
    "false",
    "no",
    "off",
    "enabled",
    "2",
  ])("does not treat %j as a refresh request (#4680)", (value) => {
    expect(
      envForcesSandboxBaseImageRefresh({
        NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH: value,
      }),
    ).toBe(false);
  });

  it("does not force refresh when the environment variable is absent (#4680)", () => {
    expect(envForcesSandboxBaseImageRefresh({})).toBe(false);
  });
});
