// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("Hermes sandbox connect light terminal skin", () => {
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

  it("prepares the NemoClaw Hermes light skin inside the sandbox on light macOS Terminal.app (#6380)", async () => {
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

    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "--",
        "sh",
        "-c",
        'hermes_home="${HERMES_HOME:-/sandbox/.hermes}"; test -f "$hermes_home/config.yaml" && cat "$hermes_home/config.yaml" || true',
      ],
      expect.objectContaining({ ignoreError: true }),
    );
    const skinWriteCall = harness.runOpenshellSpy.mock.calls.find(
      ([args]) =>
        Array.isArray(args) &&
        args.slice(0, 6).join(" ") === "sandbox exec --name alpha -- sh" &&
        String(args[7] ?? "").includes("nemoclaw-light.yaml"),
    );
    expect(skinWriteCall?.[0][7]).toContain("/skins/nemoclaw-light.yaml");
    expect(skinWriteCall?.[0][7]).toContain("config.yaml");

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
          TERM_PROGRAM: "Apple_Terminal",
        }),
      }),
    );
    expect(connectCall?.[2]?.env).not.toEqual(expect.objectContaining({ HERMES_TUI_LIGHT: "1" }));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not prepare the NemoClaw Hermes light skin when the sandbox Hermes config already sets display.skin (#6380)", async () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("COLORFGBG", "0;15");
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });
    harness.captureOpenshellSpy.mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args : [];
      if (
        argv[0] === "sandbox" &&
        argv[1] === "exec" &&
        argv.join(" ").includes("/sandbox/.hermes")
      ) {
        return { status: 0, output: "display:\n  skin: solarized-light\n" };
      }
      if (argv[0] === "sandbox" && argv[1] === "list") {
        return { status: 0, output: "alpha Ready" };
      }
      if (argv[0] === "inference" && argv[1] === "get") {
        return { status: 0, output: "Provider: unknown\nModel: unknown\n" };
      }
      return { status: 0, output: "" };
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    const skinWriteCall = harness.runOpenshellSpy.mock.calls.find(
      ([args]) =>
        Array.isArray(args) &&
        args.slice(0, 6).join(" ") === "sandbox exec --name alpha -- sh" &&
        String(args[7] ?? "").includes("nemoclaw-light.yaml"),
    );
    expect(skinWriteCall).toBeUndefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
