// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createVirtualClock } from "./__test-helpers__/virtual-clock";
import {
  buildNemoclawOpenShellGatewayUserService,
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellGatewayUserServiceBinaryPaths,
  getOpenShellGatewayUserServicePaths,
  getOpenShellUserConfigHome,
  hasNemoclawOpenShellGatewayUserService,
  hasOpenShellGatewayUserService,
  installAndReportNemoclawOpenShellGatewayUserService,
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

function homeEnv(home: string, xdgConfigHome = ""): NodeJS.ProcessEnv {
  return { HOME: home, XDG_CONFIG_HOME: xdgConfigHome } as NodeJS.ProcessEnv;
}

describe("docker-driver-gateway-service", () => {
  it("detects the platform OpenShell gateway service", () => {
    const existsSync = (candidate: string) =>
      candidate === "/usr/lib/systemd/user/openshell-gateway.service";
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) =>
      args.join(" ") === "list --formula openshell" ? spawnResult() : spawnResult(1, "unexpected"),
    );

    expect(hasOpenShellGatewayUserService({ existsSync, platform: "linux" })).toBe(true);
    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => false,
        existsSync,
        platform: "darwin",
      }),
    ).toBe(false);
    expect(
      hasOpenShellGatewayUserService({
        commandExists: (command) => command === "brew",
        platform: "darwin",
        spawnSyncImpl,
      }),
    ).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "brew",
      ["list", "--formula", "openshell"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
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

  it("resolves the service unit under the effective XDG config home", () => {
    expect(
      getNemoclawOpenShellGatewayUserServicePath("/home/nvidia", {
        XDG_CONFIG_HOME: "/tmp/nemoclaw-config",
      }),
    ).toBe("/tmp/nemoclaw-config/systemd/user/openshell-gateway.service");
    expect(
      getNemoclawOpenShellGatewayUserServicePath("/home/nvidia", {
        XDG_CONFIG_HOME: "relative-config",
      }),
    ).toBe("/home/nvidia/.config/systemd/user/openshell-gateway.service");
    expect(getOpenShellUserConfigHome("/home/nvidia", { XDG_CONFIG_HOME: "/tmp/config" })).toBe(
      "/tmp/config",
    );
  });

  it("ignores stale per-user service units so standalone fallback remains available", () => {
    const home = "/home/nvidia";
    const env = homeEnv(home);
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
    const existsSync = vi.fn((candidate: string) => candidate === servicePath);

    expect(
      hasOpenShellGatewayUserService({
        existsSync,
        env,
        home,
        platform: "linux",
        readFileSync: () => `# not ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
      }),
    ).toBe(false);
  });

  it("detects and installs a NemoClaw-managed user service on Linux only", () => {
    const home = "/home/nvidia";
    const env = homeEnv(home);
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
    const gatewayBin = "/home/nvidia/.local/bin/openshell-gateway";
    const chmodSync = vi.fn();
    const mkdirSync = vi.fn();
    const writeFileSync = vi.fn();

    expect(
      installNemoclawOpenShellGatewayUserService({
        chmodSync,
        env,
        existsSync: () => false,
        gatewayBin,
        home,
        mkdirSync: mkdirSync as never,
        platform: "linux",
        writeFileSync: writeFileSync as never,
      }),
    ).toEqual({ installed: true, path: servicePath });
    expect(mkdirSync).toHaveBeenCalledWith(path.dirname(servicePath), {
      recursive: true,
      mode: 0o700,
    });
    expect(chmodSync).toHaveBeenCalledWith(path.dirname(servicePath), 0o700);
    expect(chmodSync).toHaveBeenCalledWith(servicePath, 0o600);
    expect(String(writeFileSync.mock.calls[0]?.[1])).toContain(`ExecStart=${gatewayBin}`);
    expect(String(writeFileSync.mock.calls[0]?.[1])).toContain("After=default.target");
    expect(String(writeFileSync.mock.calls[0]?.[1])).toContain(
      "Environment=OPENSHELL_LOCAL_TLS_DIR=%h/.local/state/openshell/tls",
    );
    expect(String(writeFileSync.mock.calls[0]?.[1])).toContain(
      `ExecStartPre=${gatewayBin} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal --server-san localhost --server-san 127.0.0.1`,
    );
    expect(
      hasNemoclawOpenShellGatewayUserService({
        existsSync: (candidate) => candidate === servicePath,
        env,
        home,
        platform: "linux",
        readFileSync: () => buildNemoclawOpenShellGatewayUserService(gatewayBin),
      }),
    ).toBe(true);
    expect(
      installNemoclawOpenShellGatewayUserService({
        gatewayBin: "/opt/homebrew/bin/openshell-gateway",
        platform: "darwin",
        writeFileSync: vi.fn() as never,
      }),
    ).toEqual({ installed: false, reason: "not a Linux host" });
  });

  it("warns when Linux service installation cannot find a gateway binary", () => {
    const warn = vi.fn();

    expect(
      installAndReportNemoclawOpenShellGatewayUserService({
        existsSync: () => false,
        gatewayBin: null,
        platform: "linux",
        warn,
      }),
    ).toEqual({ installed: false, reason: "OpenShell gateway binary not found" });
    expect(warn).toHaveBeenCalledWith(
      "  OpenShell gateway user service not installed: OpenShell gateway binary not found.",
    );
  });

  it("removes a NemoClaw user override when an upstream service exists", () => {
    const home = "/home/nvidia";
    const env = homeEnv(home);
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
    const rmSync = vi.fn();

    expect(
      installNemoclawOpenShellGatewayUserService({
        existsSync: (candidate) =>
          candidate === "/usr/lib/systemd/user/openshell-gateway.service" ||
          candidate === servicePath,
        env,
        gatewayBin: null,
        home,
        platform: "linux",
        readFileSync: () =>
          buildNemoclawOpenShellGatewayUserService("/home/nvidia/.local/bin/openshell-gateway"),
        rmSync: rmSync as never,
      }),
    ).toMatchObject({ installed: false, removed: true });
    expect(rmSync).toHaveBeenCalledWith(servicePath, { force: true });
  });

  it("rejects unsafe NemoClaw service ExecStart paths", () => {
    expect(
      installNemoclawOpenShellGatewayUserService({
        existsSync: () => false,
        gatewayBin: "./openshell-gateway",
        platform: "linux",
      }).reason,
    ).toMatch(/absolute path/);
    expect(
      installNemoclawOpenShellGatewayUserService({
        existsSync: () => false,
        gatewayBin: "/home/nvidia/bad path/openshell-gateway",
        platform: "linux",
      }).reason,
    ).toMatch(/cannot contain whitespace/);
    expect(
      installNemoclawOpenShellGatewayUserService({
        existsSync: () => false,
        gatewayBin: "/opt/openshell/bin/openshell-gateway",
        home: "/home/nvidia",
        platform: "linux",
      }).reason,
    ).toMatch(/not in a trusted install path/);
  });

  it("restarts the NemoClaw-managed user service after validating its identity", () => {
    const home = "/home/nvidia";
    const env = homeEnv(home);
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
    const gatewayBin = "/home/nvidia/.local/bin/openshell-gateway";
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) =>
      args.includes("show")
        ? spawnResult(0, "", trustedShowOutput(servicePath, gatewayBin))
        : spawnResult(),
    );

    expect(
      startOpenShellGatewayUserService({
        commandExists: (command) => command === "systemctl",
        env,
        existsSync: (candidate) => candidate === servicePath,
        home,
        platform: "linux",
        readFileSync: () => buildNemoclawOpenShellGatewayUserService(gatewayBin),
        spawnSyncImpl,
      }),
    ).toMatchObject({ attempted: true, fallbackAllowed: false, started: true });
  });

  it("restarts the upstream user service with systemctl --user after validating identity", () => {
    const events: string[] = [];
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      events.push(args[0] === "is-active" ? "is-active" : (args[1] ?? args[0] ?? ""));
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

    expect(result).toMatchObject({ attempted: true, fallbackAllowed: false, started: true });
    expect(events).toEqual([
      "daemon-reload",
      "show",
      "prepare-env",
      "enable",
      "restart",
      "is-active",
    ]);
    expect(spawnSyncImpl.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      [
        "systemctl",
        ["--user", "show", "openshell-gateway", "--property=FragmentPath", "--property=ExecStart"],
      ],
      ["systemctl", ["--user", "enable", "openshell-gateway"]],
      ["systemctl", ["--user", "restart", "openshell-gateway"]],
      ["systemctl", ["--user", "is-active", "--quiet", "openshell-gateway"]],
    ]);
  });

  it("restarts the macOS Homebrew gateway service", () => {
    const events: string[] = [];
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      events.push(args.join(" "));
      if (args.join(" ") === "services info --json openshell") {
        return spawnResult(
          0,
          "",
          JSON.stringify([
            {
              exit_code: 0,
              loaded: true,
              name: "openshell",
              running: true,
              status: "started",
            },
          ]),
        );
      }
      return spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      env: {},
      platform: "darwin",
      prepareServiceEnv: () => events.push("prepare-env"),
      spawnSyncImpl,
    });

    expect(result).toEqual({
      attempted: true,
      fallbackAllowed: false,
      manager: "homebrew",
      serviceName: "openshell",
      started: true,
      statusCommand: "brew services info openshell",
    });
    expect(events).toEqual([
      "list --formula openshell",
      "prepare-env",
      "services restart openshell",
      "services info --json openshell",
    ]);
  });

  it("waits briefly for a restarted macOS Homebrew service to begin running", () => {
    let statusChecks = 0;
    const sleepSeconds = vi.fn();
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.join(" ") !== "services info --json openshell") return spawnResult();
      statusChecks += 1;
      return spawnResult(
        0,
        "",
        JSON.stringify([
          {
            exit_code: statusChecks === 1 ? null : 0,
            loaded: true,
            name: "openshell",
            running: statusChecks > 1,
            status: "started",
          },
        ]),
      );
    });

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      env: {},
      platform: "darwin",
      sleepSeconds,
      spawnSyncImpl,
    });

    expect(result).toMatchObject({ manager: "homebrew", started: true });
    expect(statusChecks).toBe(2);
    expect(sleepSeconds).toHaveBeenCalledOnce();
    expect(sleepSeconds).toHaveBeenCalledWith(0.25);
  });

  it("rejects a macOS Homebrew service that exits after a successful restart", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.join(" ") === "services info --json openshell") {
        return spawnResult(
          0,
          "",
          JSON.stringify([
            {
              exit_code: 1,
              loaded: true,
              name: "openshell",
              running: false,
              status: "error",
            },
          ]),
        );
      }
      return spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      env: {},
      platform: "darwin",
      sleepSeconds: vi.fn(),
      spawnSyncImpl,
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      manager: "homebrew",
      serviceName: "openshell",
      started: false,
    });
    expect(result.reason).toMatch(/not running.*status=error.*exit_code=1/);
  });

  it("rechecks Homebrew service liveness before the sandbox bridge probe", async () => {
    const verifySandboxBridgeGatewayReachableOrExit = vi.fn();

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        getHomebrewServiceRunningState: () => ({
          ok: false,
          reason: "brew services info --json openshell reports exit_code=1",
        }),
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        healthPollInterval: 0,
        isDockerDriverGatewayReady: async () => true,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          manager: "homebrew",
          started: true,
          statusCommand: "brew services info openshell",
        }),
        verifySandboxBridgeGatewayReachableOrExit,
      }),
    ).rejects.toThrow(/service stopped after startup.*exit_code=1/);

    expect(verifySandboxBridgeGatewayReachableOrExit).not.toHaveBeenCalled();
  });

  it.each([
    "not json",
    "[]",
  ])("fails closed when Homebrew service status is unusable: %s", (stdout) => {
    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      env: {},
      platform: "darwin",
      sleepSeconds: vi.fn(),
      spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
        args.join(" ") === "services info --json openshell"
          ? spawnResult(0, "", stdout)
          : spawnResult(),
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      manager: "homebrew",
      serviceName: "openshell",
      started: false,
    });
    expect(result.reason).toContain("brew services info --json openshell");
  });

  it("does not fall back when the macOS Homebrew service restart fails", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      env: {},
      platform: "darwin",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
        args.join(" ") === "services restart openshell"
          ? spawnResult(1, "launchctl failed")
          : spawnResult(),
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      manager: "homebrew",
      serviceName: "openshell",
      started: false,
      statusCommand: "brew services info openshell",
    });
    expect(result.reason).toContain("launchctl failed");
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

  it("does not report service startup success when the restarted service is inactive", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
        args.includes("show")
          ? spawnResult(0, "", trustedShowOutput())
          : args.includes("is-active")
            ? spawnResult(3, "inactive")
            : spawnResult(),
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      started: false,
    });
    expect(result.reason).toContain("is-active --quiet openshell-gateway failed");
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

  it("accepts package-managed service health when CLI metadata is healthy and direct gRPC probe is unavailable", async () => {
    const clearDockerDriverGatewayRuntimeFiles = vi.fn();

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles,
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        healthPollInterval: 0,
        isDockerDriverGatewayReady: async () => false,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          started: true,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(clearDockerDriverGatewayRuntimeFiles).toHaveBeenCalledOnce();
  });

  it("accepts package-managed service health when direct gRPC probe is healthy and CLI status is unavailable", async () => {
    const clearDockerDriverGatewayRuntimeFiles = vi.fn();

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles,
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        healthPollInterval: 0,
        isDockerDriverGatewayReady: async () => true,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: (args) => (args[0] === "gateway" ? GATEWAY_INFO : ""),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          started: true,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(clearDockerDriverGatewayRuntimeFiles).toHaveBeenCalledOnce();
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
        runCaptureOpenshell: (args) => (args[0] === "status" ? "Error: Connection refused" : ""),
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
