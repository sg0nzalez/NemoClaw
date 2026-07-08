// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  type DockerDriverGatewayJwtBundle,
  ensureDockerDriverGatewayJwtBundle,
} from "./docker-driver-gateway-config";

export const PODMAN_DRIVER_GATEWAY_CONFIG_NAME = "openshell-gateway.toml";

type TomlValue = boolean | number | string;

function tomlValue(value: TomlValue): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function writeRestrictedFile(filePath: string, value: string, mode = 0o600): void {
  fs.writeFileSync(filePath, value, { encoding: "utf-8", mode });
  fs.chmodSync(filePath, mode);
}

function cleanupStaleAtomicFileTemps(dir: string, basename: string): void {
  const prefix = `.${basename}.tmp-`;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix)) {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    }
  }
}

function writeRestrictedFileAtomic(filePath: string, value: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  cleanupStaleAtomicFileTemps(dir, basename);
  const tmpPath = path.join(
    dir,
    `.${basename}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  let committed = false;
  try {
    writeRestrictedFile(tmpPath, value, mode);
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, mode);
    committed = true;
  } finally {
    if (!committed) fs.rmSync(tmpPath, { force: true });
  }
}

function gatewayIdForStateDir(stateDir: string): string {
  const leaf = path.basename(path.resolve(stateDir)).replace(/[^A-Za-z0-9_.-]/g, "-");
  return leaf ? `nemoclaw-${leaf}` : "nemoclaw";
}

function gatewayLocalTlsDir(gatewayEnv: Record<string, string>): string {
  const localTlsDir = gatewayEnv.OPENSHELL_LOCAL_TLS_DIR?.trim();
  if (!localTlsDir) {
    throw new Error("OpenShell Podman gateway mTLS requires OPENSHELL_LOCAL_TLS_DIR");
  }
  return localTlsDir;
}

function configLines(entries: [string, TomlValue | undefined][]): string[] {
  return entries.flatMap(([key, value]) =>
    value === undefined || (typeof value === "string" && value.trim() === "")
      ? []
      : [`${key} = ${tomlValue(value)}`],
  );
}

export function buildPodmanDriverGatewayConfigToml(
  gatewayEnv: Record<string, string>,
  jwtBundle: DockerDriverGatewayJwtBundle,
  gatewayId = "nemoclaw",
): string {
  const localTlsDir = gatewayLocalTlsDir(gatewayEnv);
  const gatewayPort = Number(gatewayEnv.OPENSHELL_SERVER_PORT || 0);
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) {
    throw new Error("OpenShell Podman gateway config requires a valid OPENSHELL_SERVER_PORT");
  }

  const podmanConfig = configLines([
    ["socket_path", gatewayEnv.OPENSHELL_PODMAN_SOCKET],
    ["network_name", gatewayEnv.OPENSHELL_PODMAN_NETWORK_NAME],
    ["gateway_port", gatewayPort],
    ["image_pull_policy", "never"],
    ["supervisor_image", gatewayEnv.OPENSHELL_PODMAN_SUPERVISOR_IMAGE],
    ["guest_tls_ca", path.join(localTlsDir, "ca.crt")],
    ["guest_tls_cert", path.join(localTlsDir, "client", "tls.crt")],
    ["guest_tls_key", path.join(localTlsDir, "client", "tls.key")],
  ]);

  return [
    "[openshell]",
    "version = 1",
    "",
    "[openshell.gateway]",
    `bind_address = ${tomlValue(`${gatewayEnv.OPENSHELL_BIND_ADDRESS}:${gatewayPort}`)}`,
    'compute_drivers = ["podman"]',
    "disable_tls = false",
    "",
    "[openshell.gateway.tls]",
    `cert_path = ${tomlValue(path.join(localTlsDir, "server", "tls.crt"))}`,
    `key_path = ${tomlValue(path.join(localTlsDir, "server", "tls.key"))}`,
    `client_ca_path = ${tomlValue(path.join(localTlsDir, "ca.crt"))}`,
    "require_client_auth = true",
    "",
    "[openshell.gateway.mtls_auth]",
    "enabled = true",
    "",
    "[openshell.gateway.gateway_jwt]",
    `signing_key_path = ${tomlValue(jwtBundle.signingKeyPath)}`,
    `public_key_path = ${tomlValue(jwtBundle.publicKeyPath)}`,
    `kid_path = ${tomlValue(jwtBundle.kidPath)}`,
    `gateway_id = ${tomlValue(gatewayId)}`,
    `ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`,
    "",
    "[openshell.gateway.auth]",
    "allow_unauthenticated_users = false",
    "",
    "[openshell.drivers.podman]",
    ...podmanConfig,
    "",
  ].join("\n");
}

export function writePodmanDriverGatewayConfig(
  stateDir: string,
  gatewayEnv: Record<string, string>,
): string {
  const configPath = path.join(stateDir, PODMAN_DRIVER_GATEWAY_CONFIG_NAME);
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  writeRestrictedFileAtomic(
    configPath,
    buildPodmanDriverGatewayConfigToml(gatewayEnv, jwtBundle, gatewayIdForStateDir(stateDir)),
    0o600,
  );
  return configPath;
}

export function preparePodmanDriverGatewayConfigEnv(
  gatewayEnv: Record<string, string>,
  stateDir: string,
): Record<string, string> {
  gatewayEnv.OPENSHELL_GATEWAY_CONFIG = writePodmanDriverGatewayConfig(stateDir, gatewayEnv);
  return gatewayEnv;
}
