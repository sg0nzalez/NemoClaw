// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_GATEWAY_BIND_ADDRESS,
  getGatewayHttpsEndpoint,
  WILDCARD_GATEWAY_BIND_ADDRESS,
} from "../core/gateway-address";
import { GATEWAY_PORT } from "../core/ports";
import { DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS } from "./docker-driver-gateway-config";
import { buildDockerDriverGatewayLocalTlsEnv } from "./docker-driver-gateway-local-tls";
import { preparePodmanDriverGatewayConfigEnv } from "./podman-driver-gateway-config";
import { resolvePodmanSocketPath } from "./podman-runtime-preflight";

export { getGatewayHttpsEndpoint };

export const PODMAN_DRIVER_GATEWAY_RUNTIME_ENV_KEYS = [
  "OPENSHELL_DRIVERS",
  "OPENSHELL_BIND_ADDRESS",
  "OPENSHELL_SERVER_PORT",
  "OPENSHELL_LOCAL_TLS_DIR",
  "OPENSHELL_DB_URL",
  "OPENSHELL_SSH_GATEWAY_HOST",
  "OPENSHELL_SSH_GATEWAY_PORT",
  "OPENSHELL_PODMAN_SOCKET",
  "OPENSHELL_PODMAN_NETWORK_NAME",
  "OPENSHELL_PODMAN_SUPERVISOR_IMAGE",
  "OPENSHELL_GATEWAY_CONFIG",
  "NEMOCLAW_PODMAN_GATEWAY_CONFIG_SHA256",
] as const;

export interface BuildPodmanDriverGatewayEnvOptions {
  platform?: NodeJS.Platform;
  gatewayPort?: number;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  podmanNetworkName?: string;
  getPodmanSupervisorImage: () => string;
}

type TomlScalar = boolean | number | string;

export function getPodmanDriverGatewayEndpoint(gatewayPort: number = GATEWAY_PORT): string {
  return getGatewayHttpsEndpoint(gatewayPort);
}

export function buildPodmanDriverGatewayEnv({
  platform = process.platform,
  gatewayPort = GATEWAY_PORT,
  stateDir,
  env = process.env,
  podmanNetworkName = "openshell-podman",
  getPodmanSupervisorImage,
}: BuildPodmanDriverGatewayEnvOptions): Record<string, string> {
  const gatewayEnv: Record<string, string> = {
    OPENSHELL_DRIVERS: "podman",
    OPENSHELL_BIND_ADDRESS: WILDCARD_GATEWAY_BIND_ADDRESS,
    OPENSHELL_SERVER_PORT: String(gatewayPort),
    OPENSHELL_SSH_GATEWAY_HOST: DEFAULT_GATEWAY_BIND_ADDRESS,
    OPENSHELL_SSH_GATEWAY_PORT: String(gatewayPort),
    ...buildDockerDriverGatewayLocalTlsEnv(stateDir),
    OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
    OPENSHELL_PODMAN_SOCKET: resolvePodmanSocketPath({ env, platform }),
    OPENSHELL_PODMAN_NETWORK_NAME: podmanNetworkName,
    OPENSHELL_PODMAN_SUPERVISOR_IMAGE: getPodmanSupervisorImage(),
  };
  preparePodmanDriverGatewayConfigEnv(gatewayEnv, stateDir);
  gatewayEnv.NEMOCLAW_PODMAN_GATEWAY_CONFIG_SHA256 = createHash("sha256")
    .update(fs.readFileSync(gatewayEnv.OPENSHELL_GATEWAY_CONFIG))
    .digest("hex");
  return gatewayEnv;
}

function parseTomlScalar(raw: string): TomlScalar | undefined {
  const booleanMatch = raw.match(/^(true|false)(?:\s+#.*)?$/);
  if (booleanMatch?.[1]) return booleanMatch[1] === "true";
  const integerMatch = raw.match(/^(\d+)(?:\s+#.*)?$/);
  if (integerMatch?.[1]) return Number(integerMatch[1]);
  const stringMatch = raw.match(/^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/);
  if (!stringMatch?.[1]) return undefined;
  try {
    const value: unknown = JSON.parse(stringMatch[1]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseTomlScalarValues(toml: string): Map<string, TomlScalar> {
  const values = new Map<string, TomlScalar>();
  let section = "";
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      continue;
    }
    const assignmentMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!assignmentMatch?.[1] || !assignmentMatch[2]) continue;
    const value = parseTomlScalar(assignmentMatch[2]);
    if (value !== undefined) values.set(`${section}.${assignmentMatch[1]}`, value);
  }
  return values;
}

function assertTomlBoolean(values: Map<string, TomlScalar>, key: string, expected: boolean): void {
  const actual = values.get(key);
  if (actual === expected) return;
  throw new Error(
    `OpenShell Podman gateway config must set ${key}=${expected}; found ${
      actual === undefined ? "missing" : actual
    }`,
  );
}

function assertTomlString(values: Map<string, TomlScalar>, key: string): string {
  const actual = values.get(key);
  if (typeof actual === "string" && actual.trim()) return actual;
  throw new Error(`OpenShell Podman gateway config must set non-empty ${key}`);
}

function assertTomlInteger(values: Map<string, TomlScalar>, key: string, expected: number): void {
  const actual = values.get(key);
  if (actual === expected) return;
  throw new Error(
    `OpenShell Podman gateway config must set ${key}=${expected}; found ${
      actual === undefined ? "missing" : String(actual)
    }`,
  );
}

function assertReadableFile(key: string, filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`OpenShell Podman gateway config ${key} must be an absolute path`);
  }
  try {
    if (fs.statSync(filePath).isFile()) {
      fs.accessSync(filePath, fs.constants.R_OK);
      return;
    }
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new Error(
    `OpenShell Podman gateway config ${key} must reference an existing readable file`,
  );
}

export function assertPodmanDriverGatewayAuthConfigSafe(gatewayEnv: Record<string, string>): void {
  if (gatewayEnv.OPENSHELL_BIND_ADDRESS !== WILDCARD_GATEWAY_BIND_ADDRESS) {
    throw new Error(
      "OpenShell Podman gateway must bind 0.0.0.0 so rootless sandboxes can call back.",
    );
  }
  const configPath = gatewayEnv.OPENSHELL_GATEWAY_CONFIG?.trim();
  if (!configPath) {
    throw new Error("OpenShell Podman gateway requires OPENSHELL_GATEWAY_CONFIG");
  }
  const toml = fs.readFileSync(configPath, "utf-8");
  if (!/compute_drivers\s*=\s*\[\s*"podman"\s*\]/.test(toml)) {
    throw new Error('OpenShell Podman gateway config must set compute_drivers = ["podman"]');
  }
  const values = parseTomlScalarValues(toml);
  assertTomlString(values, "openshell.gateway.bind_address");
  assertTomlBoolean(values, "openshell.gateway.disable_tls", false);
  assertTomlBoolean(values, "openshell.gateway.tls.require_client_auth", true);
  assertTomlBoolean(values, "openshell.gateway.mtls_auth.enabled", true);
  assertTomlBoolean(values, "openshell.gateway.auth.allow_unauthenticated_users", false);
  assertTomlInteger(
    values,
    "openshell.gateway.gateway_jwt.ttl_secs",
    DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  );
  for (const key of ["signing_key_path", "public_key_path", "kid_path"] as const) {
    const fullKey = `openshell.gateway.gateway_jwt.${key}`;
    assertReadableFile(fullKey, assertTomlString(values, fullKey));
  }
  for (const key of ["guest_tls_ca", "guest_tls_cert", "guest_tls_key"] as const) {
    const fullKey = `openshell.drivers.podman.${key}`;
    assertReadableFile(fullKey, assertTomlString(values, fullKey));
  }
  assertTomlString(values, "openshell.drivers.podman.socket_path");
  assertTomlString(values, "openshell.drivers.podman.supervisor_image");
}
