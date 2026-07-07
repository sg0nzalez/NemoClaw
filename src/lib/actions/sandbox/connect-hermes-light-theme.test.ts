// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("Hermes sandbox connect light terminal environment", () => {
  let exitSpy: MockInstance;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("marks Hermes connect sessions as light-mode when launched from light macOS Terminal.app (#6380)", async () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("COLORFGBG", "0;15");
    vi.stubEnv("HERMES_TUI_LIGHT", "");
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    const connectCall = harness.spawnSyncSpy.mock.calls.find(
      ([command, args]) =>
        command === "openshell" &&
        Array.isArray(args) &&
        args.join(" ") === "sandbox connect alpha",
    );
    expect(connectCall?.[2]).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          COLORFGBG: "0;15",
          HERMES_TUI_LIGHT: "1",
          TERM_PROGRAM: "Apple_Terminal",
        }),
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
