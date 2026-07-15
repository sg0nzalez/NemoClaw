// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createVirtualClock } from "./__test-helpers__/virtual-clock";
import {
  buildNemoclawOpenShellGatewayUserService,
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellGatewayUserServiceBinaryPaths,
  getOpenShellGatewayUserServicePaths,
  hasNemoclawOpenShellGatewayUserService,
  hasOpenShellGatewayUserService,
  installNemoclawOpenShellGatewayUserService,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
  startPackageManagedDockerDriverGateway,
} from "./docker-driver-gateway-service";

const STATUS_CONNECTED = `
Server Status

Gateway: nemoclaw
Server: https://127.0.0.1:8080/
Connected
`;

const GATEWAY_INFO = `
Gateway Info

Gateway: nemoclaw
Gateway endpoint: https://127.0.0.1:8080/
`;

function trustedShowOutput(
  fragmentPath = "/lib/systemd/user/openshell-gateway.service",
  execPath = "/usr/bin/openshell-gateway",
): string {
  return [
    `FragmentPath=${fragmentPath}`,
    `ExecStart={ path=${execPath} ; argv[]=${execPath} ; }`,
  ].join("\n");
}

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return {
    error: undefined,
    status,
    stderr,
    stdout,
  };
}

describe("docker-driver-gateway-service", () => {
  it("detects the upstream OpenShell user service only on Linux", () => {
    const existsSync = (candidate: string) =>
      candidate === "/usr/lib/systemd/user/openshell-gateway.service";

    expect(hasOpenShellGatewayUserService({ existsSync, platform: "linux" })).toBe(true);
    expect(hasOpenShellGatewayUserService({ existsSync, platform: "darwin" })).toBe(false);
    expect(getOpenShellGatewayUserServicePaths()).toEqual([
      "/usr/local/lib/systemd/user/openshell-gateway.service",
      "/usr/lib/systemd/user/openshell-gateway.service",
      "/lib/systemd/user/openshell-gateway.service",
    ]);
    expect(getOpenShellGatewayUserServiceBinaryPaths()).toEqual([
      "/usr/local/bin/openshell-gateway",
      "/usr/bin/openshell-gateway",
    ]);
  });

  it("detects a NemoClaw-managed user service without trusting arbitrary per-user units", () => {
    const home = "/home/nvidia";
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home);
    const existsSync = vi.fn((candidate: string) => candidate === servicePath);
    const readFileSync = vi.fn((candidate: string) =>
      candidate === servicePath
        ? buildNemoclawOpenShellGatewayUserService("/home/nvidia/.local/bin/openshell-gateway")
        : "",
    );

    expect(
      hasNemoclawOpenShellGatewayUserService({
        existsSync,
        home,
        platform: "linux",
        readFileSync,
      }),
    ).toBe(true);
    expect(
      hasOpenShellGatewayUserService({ existsSync, home, platform: "linux", readFileSync }),
    ).toBe(true);
    expect(
      hasNemoclawOpenShellGatewayUserService({
        existsSync,
        home,
        platform: "linux",
        readFileSync: () => "not managed",
      }),
    ).toBe(false);
  });

  it("ignores stale per-user service units so standalone fallback remains available", () => {
    const home = "/home/nvidia";
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home);
    const existsSync = vi.fn((candidate: string) => candidate === servicePath);

    expect(
      hasOpenShellGatewayUserService({
        existsSync,
        home,
        platform: "linux",
        readFileSync: () => "foreign user unit",
      }),
    ).toBe(false);
    expect(existsSync.mock.calls.flat()).toContain(servicePath);
  });

  it("restarts the upstream user service with systemctl --user after validating identity", () => {
    const events: string[] = [];
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      events.push(args[1] ?? args[0] ?? "");
      return args.includes("show") ? spawnResult(0, "", trustedShowOutput()) : spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: {},
      existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
      platform: "linux",
      prepareServiceEnv: () => events.push("prepare-env"),
      spawnSyncImpl,
    });

    expect(result).toEqual({
      attempted: true,
      fallbackAllowed: false,
      serviceName: "openshell-gateway",
      started: true,
    });
    expect(events).toEqual(["daemon-reload", "show", "prepare-env", "enable", "restart"]);
    expect(spawnSyncImpl.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      [
        "systemctl",
        ["--user", "show", "openshell-gateway", "--property=FragmentPath", "--property=ExecStart"],
      ],
      ["systemctl", ["--user", "enable", "openshell-gateway"]],
      ["systemctl", ["--user", "restart", "openshell-gateway"]],
    ]);
  });

  it("restarts the NemoClaw-managed user service after validating its marker and identity", () => {
    const home = "/home/nvidia";
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home);
    const gatewayBin = "/home/nvidia/.local/bin/openshell-gateway";
    const events: string[] = [];
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      events.push(args[1] ?? args[0] ?? "");
      return args.includes("show")
        ? spawnResult(0, "", trustedShowOutput(servicePath, gatewayBin))
        : spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: {},
      existsSync: (candidate) => candidate === servicePath,
      home,
      platform: "linux",
      readFileSync: () => buildNemoclawOpenShellGatewayUserService(gatewayBin),
      spawnSyncImpl,
    });

    expect(result).toEqual({
      attempted: true,
      fallbackAllowed: false,
      serviceName: "openshell-gateway",
      started: true,
    });
    expect(events).toEqual(["daemon-reload", "show", "enable", "restart"]);
    expect(spawnSyncImpl.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      [
        "systemctl",
        ["--user", "show", "openshell-gateway", "--property=FragmentPath", "--property=ExecStart"],
      ],
      ["systemctl", ["--user", "enable", "openshell-gateway"]],
      ["systemctl", ["--user", "restart", "openshell-gateway"]],
    ]);
  });

  it("installs the NemoClaw-managed user service without overwriting foreign units", () => {
    const home = "/home/nvidia";
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home);
    const gatewayBin = "/home/nvidia/.local/bin/openshell-gateway";
    const writes: Array<{ data: string; path: string }> = [];

    const result = installNemoclawOpenShellGatewayUserService({
      chmodSync: vi.fn(),
      existsSync: () => false,
      gatewayBin,
      home,
      mkdirSync: vi.fn() as never,
      platform: "linux",
      writeFileSync: vi.fn((target, data) => {
        writes.push({ data: String(data), path: String(target) });
      }) as never,
    });

    expect(result).toEqual({ installed: true, path: servicePath });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(servicePath);
    expect(writes[0]?.data).toContain("Description=OpenShell Gateway");
    expect(writes[0]?.data).toContain("EnvironmentFile=-%E/openshell/gateway.env");
    expect(writes[0]?.data).toContain(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER);
    expect(writes[0]?.data).toContain(`ExecStart=${gatewayBin}`);
    expect(writes[0]?.data).toContain("RestartSec=5s");
    expect(writes[0]?.data).toContain("PrivateTmp=true");

    expect(
      installNemoclawOpenShellGatewayUserService({
        existsSync: (candidate) => candidate === servicePath,
        gatewayBin,
        home,
        platform: "linux",
        readFileSync: () => "foreign unit",
      }),
    ).toMatchObject({
      installed: false,
      path: servicePath,
      reason: "refusing to overwrite a non-NemoClaw gateway user service",
    });
  });

  it("removes a marked user service override when an upstream package service exists", () => {
    const home = "/home/nvidia";
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home);
    const removed: string[] = [];
    const writes: string[] = [];

    const result = installNemoclawOpenShellGatewayUserService({
      existsSync: (candidate) =>
        candidate === "/usr/lib/systemd/user/openshell-gateway.service" ||
        candidate === servicePath,
      gatewayBin: "/home/nvidia/.local/bin/openshell-gateway",
      home,
      platform: "linux",
      readFileSync: (candidate) =>
        candidate === servicePath
          ? buildNemoclawOpenShellGatewayUserService("/home/nvidia/.local/bin/openshell-gateway")
          : "",
      rmSync: vi.fn((target) => removed.push(String(target))) as never,
      writeFileSync: vi.fn((target) => writes.push(String(target))) as never,
    });

    expect(result).toEqual({
      installed: false,
      path: servicePath,
      reason: "upstream OpenShell gateway service is installed",
      removed: true,
    });
    expect(removed).toEqual([servicePath]);
    expect(writes).toEqual([]);
  });

  it("allows standalone fallback when the user systemd manager is unavailable", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
        args.includes("daemon-reload") ? spawnResult(1, "Failed to connect to bus") : spawnResult(),
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: true,
      started: false,
    });
    expect(result.reason).toContain("Failed to connect to bus");
  });

  it("allows standalone fallback when restart loses the user systemd manager", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) => {
        if (args.includes("show")) return spawnResult(0, "", trustedShowOutput());
        if (args.includes("restart")) return spawnResult(1, "Failed to connect to bus");
        return spawnResult();
      }),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: true,
      started: false,
    });
    expect(result.reason).toContain("Failed to connect to bus");
  });

  it("does not silently fall back when the installed service fails to restart", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) => {
        if (args.includes("show")) return spawnResult(0, "", trustedShowOutput());
        if (args.includes("restart")) return spawnResult(1, "Job failed");
        return spawnResult();
      }),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      started: false,
    });
    expect(result.reason).toContain("Job failed");
  });

  it("does not treat missing service executables as user-manager outages", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) => {
        if (args.includes("show")) return spawnResult(0, "", trustedShowOutput());
        if (args.includes("restart")) return spawnResult(1, "No such file or directory");
        return spawnResult();
      }),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      started: false,
    });
    expect(result.reason).toContain("No such file or directory");
  });

  it("falls back instead of trusting an unverified service identity", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.includes("show")) {
        return spawnResult(
          0,
          "",
          trustedShowOutput("/home/nvidia/.config/systemd/user/openshell-gateway.service"),
        );
      }
      return spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl,
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: true,
      started: false,
    });
    expect(result.reason).toContain("not a trusted OpenShell gateway");
    expect(spawnSyncImpl.mock.calls.map(([, args]) => args.join(" "))).not.toContain(
      "--user restart openshell-gateway",
    );
  });

  it("falls back instead of trusting package units that execute untrusted wrappers", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.includes("show")) {
        return spawnResult(
          0,
          "",
          trustedShowOutput(
            "/lib/systemd/user/openshell-gateway.service",
            "/tmp/openshell-gateway",
          ),
        );
      }
      return spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl,
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: true,
      started: false,
    });
    expect(result.reason).toContain("not a trusted OpenShell gateway");
    expect(spawnSyncImpl.mock.calls.map(([, args]) => args.join(" "))).not.toContain(
      "--user restart openshell-gateway",
    );
  });

  it("uses the package-managed service only after endpoint, metadata, and gRPC health are ready", async () => {
    const events: string[] = [];
    const clock = createVirtualClock();
    let registerCount = 0;
    const registerDockerDriverGatewayEndpoint = vi.fn(() => {
      events.push("register");
      registerCount += 1;
      return registerCount >= 2;
    });

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: () => events.push("clear"),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 3,
        healthPollInterval: 1,
        isDockerDriverGatewayReady: async () => {
          events.push("ready");
          return true;
        },
        now: clock.now,
        registerDockerDriverGatewayEndpoint,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        sleepSeconds: (seconds) => {
          events.push("sleep");
          clock.advance(seconds);
        },
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          started: true,
        }),
        verifySandboxBridgeGatewayReachableOrExit: async () => {
          events.push("verify");
        },
      }),
    ).resolves.toBe(true);

    expect(events).toEqual(["register", "sleep", "register", "ready", "clear", "verify"]);
  });

  it("preserves bounded immediate package-service probes when the interval is zero", async () => {
    const clock = createVirtualClock();
    let registerCount = 0;

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 3,
        healthPollInterval: 0,
        isDockerDriverGatewayReady: async () => true,
        now: clock.now,
        registerDockerDriverGatewayEndpoint: () => {
          registerCount += 1;
          return registerCount >= 3;
        },
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        sleepSeconds: clock.sleeper,
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          started: true,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(registerCount).toBe(3);
    expect(clock.sleeper).toHaveBeenCalledTimes(2);
    expect(clock.sleeper).toHaveBeenNthCalledWith(1, 0);
    expect(clock.sleeper).toHaveBeenNthCalledWith(2, 0);
  });

  it("falls back to standalone when package-managed service startup is unavailable", async () => {
    const registerDockerDriverGatewayEndpoint = vi.fn(() => true);

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        registerDockerDriverGatewayEndpoint,
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: true,
          reason: "user manager unavailable",
          started: false,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(registerDockerDriverGatewayEndpoint).not.toHaveBeenCalled();
  });

  it("keeps standalone runtime breadcrumbs when service health never becomes ready", async () => {
    const clearDockerDriverGatewayRuntimeFiles = vi.fn();
    const clock = createVirtualClock();

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles,
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        healthPollInterval: 1,
        isDockerDriverGatewayReady: async () => false,
        now: clock.now,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        sleepSeconds: clock.advance,
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          started: true,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("configured 1s health deadline");

    expect(clearDockerDriverGatewayRuntimeFiles).not.toHaveBeenCalled();
  });
});
