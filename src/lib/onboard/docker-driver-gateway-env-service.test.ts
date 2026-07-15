// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { startPackageManagedDockerDriverGatewayWithEnvOverride } from "./docker-driver-gateway-env";
import { writeSafeGatewayAuthConfig } from "../../../test/support/docker-driver-gateway-env-test-support";

describe("package-managed Docker-driver gateway env service", () => {
  it("writes the service env only when package-managed startup prepares the service", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const gatewayBin = path.join(tempHome, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      tempHome,
      ".config",
      "systemd",
      "user",
      "openshell-gateway.service",
    );
    const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          exitOnFailure: false,
          gatewayBin,
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: writeSafeGatewayAuthConfig(tempHome),
            OPENSHELL_SERVER_PORT: "18080",
          },
          gatewayName: "nemoclaw",
          hasOpenShellGatewayUserService: () => true,
          isDockerDriverGatewayReady: async () => true,
          registerDockerDriverGatewayEndpoint: () => true,
          runCaptureOpenshell: (args) =>
            args[0] === "status"
              ? "Gateway: nemoclaw\nConnected"
              : "Gateway: nemoclaw\nGateway endpoint: https://127.0.0.1:18080/",
          skipSandboxBridgeReachability: false,
          startOpenShellGatewayUserService: (opts) => {
            opts?.prepareServiceEnv?.();
            return { attempted: true, fallbackAllowed: false, started: true };
          },
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).resolves.toBe(true);

      expect(fs.readFileSync(servicePath, "utf-8")).toContain(`ExecStart=${gatewayBin}`);
      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_BIND_ADDRESS=127.0.0.1\n");
      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_SERVER_PORT=18080\n");
    } finally {
      existsSpy.mockRestore();
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects package-managed wildcard binds before writing the service env", () => {
    expect(() =>
      startPackageManagedDockerDriverGatewayWithEnvOverride({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayEnv: {
          OPENSHELL_BIND_ADDRESS: "0.0.0.0",
          OPENSHELL_GATEWAY_CONFIG: "/tmp/openshell-gateway.toml",
        },
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: () => "",
        skipSandboxBridgeReachability: false,
        verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
      }),
    ).toThrow(/not supported for the OpenShell Docker-driver gateway/);
  });

  it("rejects incomplete gateway JWT config before writing env or starting the service", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
    const startService = vi.fn();
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    try {
      for (const key of [
        "signing_key_path",
        "public_key_path",
        "kid_path",
        "gateway_id",
        "ttl_secs",
      ]) {
        const configPath = writeSafeGatewayAuthConfig(tempHome);
        fs.writeFileSync(
          configPath,
          fs.readFileSync(configPath, "utf-8").replace(new RegExp(`^${key} = .+\\n`, "m"), ""),
        );

        expect(() =>
          startPackageManagedDockerDriverGatewayWithEnvOverride({
            clearDockerDriverGatewayRuntimeFiles: vi.fn(),
            exitOnFailure: false,
            gatewayEnv: {
              OPENSHELL_BIND_ADDRESS: "127.0.0.1",
              OPENSHELL_GATEWAY_CONFIG: configPath,
            },
            gatewayName: "nemoclaw",
            hasOpenShellGatewayUserService: () => true,
            registerDockerDriverGatewayEndpoint: () => true,
            runCaptureOpenshell: () => "",
            skipSandboxBridgeReachability: false,
            startOpenShellGatewayUserService: startService,
            verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
          }),
        ).toThrow(new RegExp(`gateway_jwt\\.${key}`));
      }

      expect(startService).not.toHaveBeenCalled();
      expect(fs.existsSync(envFile)).toBe(false);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
