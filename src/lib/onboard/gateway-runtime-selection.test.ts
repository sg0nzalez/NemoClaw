// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGatewayRuntimeChoices,
  isPodmanGatewayRuntimeEnabled,
  resolveNemoClawGatewayRuntime,
  selectNemoClawGatewayRuntime,
} from "./gateway-runtime-selection";

describe("gateway runtime selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps Docker as the default gateway runtime", () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "");

    expect(resolveNemoClawGatewayRuntime()).toBe("docker");
    expect(isPodmanGatewayRuntimeEnabled()).toBe(false);
  });

  it("enables Podman only through the explicit opt-in", () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");

    expect(resolveNemoClawGatewayRuntime()).toBe("podman");
    expect(isPodmanGatewayRuntimeEnabled()).toBe(true);
  });

  it("fails closed for unknown explicit gateway runtime values", () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "containerd");

    expect(() => resolveNemoClawGatewayRuntime()).toThrow("NEMOCLAW_GATEWAY_RUNTIME");
  });

  it("prompts for the gateway runtime on interactive Linux when no env override is set", async () => {
    const prompt = vi.fn(async () => "2");
    const log = vi.fn();

    await expect(
      selectNemoClawGatewayRuntime({
        env: {} as NodeJS.ProcessEnv,
        platform: "linux",
        canPrompt: true,
        isNonInteractive: () => false,
        log,
        prompt,
        selectFromNumberedMenu: (rawChoice, _defaultIdx, options) => options[Number(rawChoice) - 1],
      }),
    ).resolves.toBe("podman");

    expect(prompt).toHaveBeenCalledWith("  Choose [1]: ");
    expect(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain("Podman");
  });

  it("skips the prompt when the gateway runtime env var is explicit", async () => {
    const prompt = vi.fn(async () => "1");
    const note = vi.fn();

    await expect(
      selectNemoClawGatewayRuntime({
        env: { NEMOCLAW_GATEWAY_RUNTIME: "podman" } as NodeJS.ProcessEnv,
        platform: "linux",
        canPrompt: true,
        isNonInteractive: () => false,
        note,
        prompt,
        selectFromNumberedMenu: (_rawChoice, _defaultIdx, options) => options[0],
      }),
    ).resolves.toBe("podman");

    expect(prompt).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith("  Gateway runtime: Podman (NEMOCLAW_GATEWAY_RUNTIME)");
  });

  it("defaults to Docker without prompting in non-interactive mode", async () => {
    const prompt = vi.fn(async () => "2");
    const note = vi.fn();

    await expect(
      selectNemoClawGatewayRuntime({
        env: {} as NodeJS.ProcessEnv,
        platform: "linux",
        canPrompt: true,
        isNonInteractive: () => true,
        note,
        prompt,
        selectFromNumberedMenu: (_rawChoice, _defaultIdx, options) => options[1],
      }),
    ).resolves.toBe("docker");

    expect(prompt).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith("  [non-interactive] Gateway runtime: Docker");
  });

  it("offers only Docker on non-Linux platforms", () => {
    expect(getGatewayRuntimeChoices("darwin").map((choice) => choice.runtime)).toEqual(["docker"]);
  });
});
