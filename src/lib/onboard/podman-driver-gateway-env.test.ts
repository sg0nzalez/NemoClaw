// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertPodmanDriverGatewayAuthConfigSafe,
  buildPodmanDriverGatewayEnv,
} from "./podman-driver-gateway-env";

function writeTlsFiles(localTlsDir: string): void {
  for (const relativePath of [
    "ca.crt",
    "server/tls.crt",
    "server/tls.key",
    "client/tls.crt",
    "client/tls.key",
  ]) {
    const filePath = path.join(localTlsDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "test\n", { mode: 0o600 });
  }
}

describe("buildPodmanDriverGatewayEnv", () => {
  it("writes a rootless Podman gateway config with mTLS and Podman compute driver", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-gateway-"));
    try {
      const env = buildPodmanDriverGatewayEnv({
        platform: "linux",
        gatewayPort: 18080,
        stateDir,
        env: { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv,
        getPodmanSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:0.0.72",
      });

      expect(env).toMatchObject({
        OPENSHELL_DRIVERS: "podman",
        OPENSHELL_BIND_ADDRESS: "0.0.0.0",
        OPENSHELL_SERVER_PORT: "18080",
        OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
        OPENSHELL_PODMAN_NETWORK_NAME: "openshell-podman",
        OPENSHELL_PODMAN_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor:0.0.72",
        OPENSHELL_GATEWAY_CONFIG: path.join(stateDir, "openshell-gateway.toml"),
      });
      expect(env.NEMOCLAW_PODMAN_GATEWAY_CONFIG_SHA256).toMatch(/^[a-f0-9]{64}$/);

      const config = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");
      expect(config).toContain('compute_drivers = ["podman"]');
      expect(config).toContain('bind_address = "0.0.0.0:18080"');
      expect(config).toContain("[openshell.drivers.podman]");
      expect(config).toContain('image_pull_policy = "never"');
      expect(config).not.toContain("[openshell.drivers.docker]");

      writeTlsFiles(env.OPENSHELL_LOCAL_TLS_DIR);
      expect(() => assertPodmanDriverGatewayAuthConfigSafe(env)).not.toThrow();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
