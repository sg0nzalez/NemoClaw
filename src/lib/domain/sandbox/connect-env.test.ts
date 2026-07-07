// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildSandboxConnectEnv } from "./connect-env";

describe("sandbox connect environment helpers", () => {
  it("marks Hermes connect sessions as light when COLORFGBG reports a light background (#6380)", () => {
    expect(
      buildSandboxConnectEnv(
        { name: "hermes" },
        { COLORFGBG: "0;15", TERM_PROGRAM: "Apple_Terminal" },
      ),
    ).toEqual(
      expect.objectContaining({
        COLORFGBG: "0;15",
        HERMES_TUI_LIGHT: "1",
        TERM_PROGRAM: "Apple_Terminal",
      }),
    );
  });

  it("does not force Hermes light mode when COLORFGBG reports a dark background (#6380)", () => {
    expect(
      buildSandboxConnectEnv(
        { name: "hermes" },
        { COLORFGBG: "0;0", TERM_PROGRAM: "Apple_Terminal" },
      ),
    ).not.toHaveProperty("HERMES_TUI_LIGHT");
  });

  it("preserves explicit Hermes light-mode overrides (#6380)", () => {
    for (const value of ["0", "false", "no", "off"]) {
      expect(
        buildSandboxConnectEnv({ name: "hermes" }, { COLORFGBG: "0;15", HERMES_TUI_LIGHT: value })
          .HERMES_TUI_LIGHT,
      ).toBe(value);
    }
  });

  it("preserves explicit Hermes theme overrides (#6380)", () => {
    expect(
      buildSandboxConnectEnv({ name: "hermes" }, { COLORFGBG: "0;15", HERMES_TUI_THEME: "dark" }),
    ).not.toHaveProperty("HERMES_TUI_LIGHT");
  });

  it("does not set Hermes light mode for non-Hermes agents (#6380)", () => {
    expect(buildSandboxConnectEnv({ name: "openclaw" }, { COLORFGBG: "0;15" })).not.toHaveProperty(
      "HERMES_TUI_LIGHT",
    );
  });

  it("does not infer light mode from Apple Terminal without usable COLORFGBG (#6380)", () => {
    expect(
      buildSandboxConnectEnv({ name: "hermes" }, { TERM_PROGRAM: "Apple_Terminal" }),
    ).not.toHaveProperty("HERMES_TUI_LIGHT");
    expect(
      buildSandboxConnectEnv(
        { name: "hermes" },
        { COLORFGBG: "not-a-color", TERM_PROGRAM: "Apple_Terminal" },
      ),
    ).not.toHaveProperty("HERMES_TUI_LIGHT");
  });
});
