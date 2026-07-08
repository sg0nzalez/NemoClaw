// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { type GatewayRecoveryDeps, startGatewayForRecovery } from "./gateway-recovery";

function createDeps(overrides: Partial<GatewayRecoveryDeps> = {}): GatewayRecoveryDeps {
  return {
    getGatewayClusterContainerState: () => "missing",
    getGatewayStartEnv: () => ({ OPENSHELL_DRIVERS: "docker" }),
    runCaptureOpenshell: vi.fn(() => "Disconnected"),
    runOpenshell: vi.fn(() => ({ status: 0 })),
    sleepSeconds: vi.fn(),
    startGatewayWithOptions: vi.fn(
      async () => undefined,
    ) as GatewayRecoveryDeps["startGatewayWithOptions"],
    // Tests assert the plain-CLI fallback path by default; the Linux
    // Docker-driver branch is opted into explicitly per case.
    isLinuxDockerDriverGatewayEnabled: () => false,
    ...overrides,
  };
}

describe("gateway recovery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.OPENSHELL_GATEWAY;
  });

  it("uses the default gateway starter when no explicit target is supplied", async () => {
    const deps = createDeps();

    await startGatewayForRecovery({}, deps);

    expect(deps.startGatewayWithOptions).toHaveBeenCalledWith(undefined, {
      exitOnFailure: false,
    });
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("starts and selects the named gateway using the port encoded in its name", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "1");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-8090" }, deps)).rejects.toThrow(
      "Gateway 'nemoclaw-8090' did not become ready",
    );

    expect(deps.startGatewayWithOptions).not.toHaveBeenCalled();
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["gateway", "start", "--name", "nemoclaw-8090", "--port", "8090"],
      {
        ignoreError: true,
        env: {
          OPENSHELL_DRIVERS: "docker",
          OPENSHELL_SERVER_PORT: "8090",
          OPENSHELL_SSH_GATEWAY_PORT: "8090",
        },
        suppressOutput: true,
      },
    );
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(2, ["gateway", "select", "nemoclaw-8090"], {
      ignoreError: true,
    });
  });

  it("derives the canonical gateway name when only a non-default port is supplied", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "1");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      "Gateway 'nemoclaw-8091' did not become ready",
    );

    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["gateway", "start", "--name", "nemoclaw-8091", "--port", "8091"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENSHELL_SERVER_PORT: "8091",
          OPENSHELL_SSH_GATEWAY_PORT: "8091",
        }),
      }),
    );
  });

  it("uses the configured recovery deadline budget without sleeping after the final probe", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "3");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "2");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      "3 recovery attempt(s) at 2s interval (max wait 6s)",
    );

    expect(deps.runCaptureOpenshell).toHaveBeenCalledTimes(9);
    expect(deps.sleepSeconds).toHaveBeenCalledTimes(2);
    expect(deps.sleepSeconds).toHaveBeenNthCalledWith(1, 2);
    expect(deps.sleepSeconds).toHaveBeenNthCalledWith(2, 2);
  });

  it("succeeds on the first healthy probe without sleeping and sets OPENSHELL_GATEWAY", async () => {
    // Advisor: pin the happy path so a future refactor cannot silently
    // break the side effects the caller relies on after readiness.
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "3");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "2");
    const deps = createDeps({
      runCaptureOpenshell: vi.fn(() => "Connected"),
      isGatewayHealthy: () => true,
      isGatewayHttpReady: async () => true,
    });

    await startGatewayForRecovery({ gatewayPort: 8091 }, deps);

    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8091");
    expect(deps.sleepSeconds).not.toHaveBeenCalled();
    // First iteration only: 3 subprocess calls (status + gateway info -g +
    // gateway info); loop returns before the next iteration would start.
    expect(deps.runCaptureOpenshell).toHaveBeenCalledTimes(3);
  });

  it("succeeds after retrying past unhealthy probes and still sets OPENSHELL_GATEWAY", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "3");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "2");
    // Probe #1 fails the health predicate, probe #2 passes. Each probe
    // reads status + gateway info -g + gateway info (3 calls).
    let healthCalls = 0;
    const deps = createDeps({
      runCaptureOpenshell: vi.fn(() => "Connected"),
      isGatewayHealthy: () => {
        healthCalls++;
        return healthCalls > 1;
      },
      isGatewayHttpReady: async () => true,
    });

    await startGatewayForRecovery({ gatewayPort: 8091 }, deps);

    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8091");
    // Exactly one inter-attempt sleep between the unhealthy first probe
    // and the healthy second probe.
    expect(deps.sleepSeconds).toHaveBeenCalledTimes(1);
    expect(deps.sleepSeconds).toHaveBeenNthCalledWith(1, 2);
    expect(deps.runCaptureOpenshell).toHaveBeenCalledTimes(6);
  });

  it("with NEMOCLAW_HEALTH_POLL_COUNT=0 fails fast without invoking the probe", async () => {
    // Advisor edge-case: a zero attempt count must not silently pretend
    // the gateway is healthy and must not run any subprocess probes.
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "0");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "2");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      "0 recovery attempt(s) at 2s interval",
    );

    // First iteration's attempt-cap check terminates before the probe
    // callback runs, so no status/gateway-info calls are made.
    expect(deps.runCaptureOpenshell).not.toHaveBeenCalled();
    expect(deps.sleepSeconds).not.toHaveBeenCalled();
  });

  it("rejects non-canonical gateway recovery names before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "other-gateway" }, deps)).rejects.toThrow(
      "Invalid NemoClaw gateway name 'other-gateway'",
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects a gateway name and port mismatch before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(
      startGatewayForRecovery({ gatewayName: "nemoclaw-8090", gatewayPort: 8091 }, deps),
    ).rejects.toThrow("Gateway 'nemoclaw-8090' does not match port 8091");

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects privileged recovery ports before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-80" }, deps)).rejects.toThrow(
      "Invalid gateway recovery port 80",
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed on cross-port recovery when the Linux Docker-driver gateway is enabled", async () => {
    const deps = createDeps({ isLinuxDockerDriverGatewayEnabled: () => true });

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-8090" }, deps)).rejects.toThrow(
      /Cross-port recovery for Linux Docker-driver gateway 'nemoclaw-8090' is not safe/,
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(deps.startGatewayWithOptions).not.toHaveBeenCalled();
  });
});
