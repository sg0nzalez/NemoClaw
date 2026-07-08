// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOpenshell } from "../adapters/openshell/resolve";
import { isErrnoException } from "../core/errno";
import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { ensureDockerDriverGatewayLocalTlsBundle } from "./docker-driver-gateway-local-tls";
import * as gatewayBinding from "./gateway-binding";
import {
  gatewayProcessCmdlineMatches,
  OPENSHELL_GATEWAY_PROCESS_NAMES,
} from "./gateway-process-identity";
import {
  assertPodmanDriverGatewayAuthConfigSafe,
  buildPodmanDriverGatewayEnv,
  getPodmanDriverGatewayEndpoint,
  PODMAN_DRIVER_GATEWAY_RUNTIME_ENV_KEYS,
} from "./podman-driver-gateway-env";

const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = {
  "0.0.72": "sha256:80ed9cda5bf672fefdb9dcd4604b40a8b09c0891b6eb9d03e10227c7e3dfb49d",
};

export type PodmanDriverGatewayLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: "host";
  processGatewayBin: string | null;
};

export type PodmanDriverGatewayRuntimeDrift = { reason: string };

type RunCapture = (args: string[], opts?: { ignoreError?: boolean }) => string;

export interface PodmanDriverGatewayRuntimeDeps {
  gatewayPort: number | (() => number);
  getCachedOpenshellBinary(): string | null;
  getBlueprintMaxOpenshellVersion(): string | null;
  getInstalledOpenshellVersion(versionOutput?: string | null): string | null;
  isOpenshellDevVersion(versionOutput: string | null | undefined): boolean;
  runCapture: RunCapture;
  shouldUseOpenshellDevChannel(): boolean;
  supportedOpenshellFallbackVersion: string;
}

function resolvePodmanGatewayStateDirName(port: number): string {
  return port === DEFAULT_GATEWAY_PORT
    ? "openshell-podman-gateway"
    : `openshell-podman-gateway-${port}`;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readProcessEnv(pid: number): Record<string, string> | null {
  const procEnvPath = `/proc/${pid}/environ`;
  const env: Record<string, string> = {};
  try {
    if (!fs.existsSync(procEnvPath)) return null;
    for (const entry of fs.readFileSync(procEnvPath, "utf-8").split("\0")) {
      if (!entry) continue;
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
  } catch {
    return null;
  }
  return env;
}

function readProcessExe(pid: number): string | null {
  try {
    const procExePath = `/proc/${pid}/exe`;
    if (!fs.existsSync(procExePath)) return null;
    return fs.readlinkSync(procExePath);
  } catch {
    return null;
  }
}

function normalizeGatewayExecutablePath(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const withoutDeletedSuffix = normalized.replace(/ \(deleted\)$/, "");
  try {
    return fs.realpathSync.native(withoutDeletedSuffix);
  } catch {
    return path.resolve(withoutDeletedSuffix);
  }
}

function processIdentityMatchesGatewayBinary(
  identity: string,
  gatewayBin?: string | null,
): boolean {
  return gatewayProcessCmdlineMatches(identity, gatewayBin, {
    processNames: OPENSHELL_GATEWAY_PROCESS_NAMES,
    resolveExecutablePath: normalizeGatewayExecutablePath,
  });
}

export function buildPodmanDriverGatewayLaunch(options: {
  gatewayBin: string;
  gatewayEnv: Record<string, string>;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  ensureLocalTlsBundle?: boolean;
}): PodmanDriverGatewayLaunch {
  const gatewayEnv = { ...options.gatewayEnv };
  if (options.ensureLocalTlsBundle) {
    ensureDockerDriverGatewayLocalTlsBundle({
      gatewayBin: options.gatewayBin,
      stateDir: options.stateDir,
    });
  }
  assertPodmanDriverGatewayAuthConfigSafe(gatewayEnv);
  return {
    command: options.gatewayBin,
    args: [],
    env: { ...(options.env ?? process.env), ...gatewayEnv },
    mode: "host",
    processGatewayBin: options.gatewayBin,
  };
}

export function spawnPodmanDriverGateway(
  spawnImpl: (
    command: string,
    args: string[],
    options: { detached: true; stdio: ["ignore", number, number]; env: NodeJS.ProcessEnv },
  ) => ChildProcess,
  launch: PodmanDriverGatewayLaunch,
  logFd: number,
): ChildProcess {
  try {
    return spawnImpl(launch.command, launch.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: launch.env,
    });
  } finally {
    fs.closeSync(logFd);
  }
}

export function createPodmanDriverGatewayRuntimeHelpers(deps: PodmanDriverGatewayRuntimeDeps): {
  clearPodmanDriverGatewayRuntimeFiles(): void;
  getPodmanDriverGatewayEnv(
    versionOutput?: string | null,
    platform?: NodeJS.Platform,
  ): Record<string, string>;
  getPodmanDriverGatewayPid(): number | null;
  getPodmanDriverGatewayPidFile(): string;
  getPodmanDriverGatewayRuntimeDrift(
    pid: number,
    desiredEnv: Record<string, string>,
    gatewayBin?: string | null,
  ): PodmanDriverGatewayRuntimeDrift | null;
  getPodmanDriverGatewayStateDir(): string;
  isPidAlive(pid: number): boolean;
  isPodmanDriverGatewayProcess(pid: number, gatewayBin?: string | null): boolean;
  isPodmanDriverGatewayProcessAlive(): boolean;
  rememberPodmanDriverGatewayPid(pid: number): void;
} {
  const currentGatewayPort = () =>
    typeof deps.gatewayPort === "function" ? deps.gatewayPort() : deps.gatewayPort;

  function getPodmanDriverGatewayStateDir(): string {
    const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
    if (configured?.trim()) return path.resolve(configured.trim());
    return path.join(
      os.homedir(),
      ".local",
      "state",
      "nemoclaw",
      resolvePodmanGatewayStateDirName(currentGatewayPort()),
    );
  }

  function getPodmanDriverGatewayPidFile(): string {
    return path.join(getPodmanDriverGatewayStateDir(), "openshell-gateway.pid");
  }

  function resolveSiblingBinary(binaryName: string): string | null {
    const openshellBin = deps.getCachedOpenshellBinary() || resolveOpenshell();
    if (typeof openshellBin !== "string" || openshellBin.length === 0) return null;
    const sibling = path.join(path.dirname(openshellBin), binaryName);
    return fs.existsSync(sibling) ? sibling : null;
  }

  function getOpenShellPodmanSupervisorImage(versionOutput: string | null = null): string {
    if (process.env.OPENSHELL_PODMAN_SUPERVISOR_IMAGE) {
      return process.env.OPENSHELL_PODMAN_SUPERVISOR_IMAGE;
    }
    if (process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE) {
      return process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE;
    }
    const installedVersion = deps.getInstalledOpenshellVersion(versionOutput);
    if (deps.shouldUseOpenshellDevChannel() || deps.isOpenshellDevVersion(versionOutput)) {
      return "ghcr.io/nvidia/openshell/supervisor:dev";
    }
    const supportedVersion =
      installedVersion ??
      deps.getBlueprintMaxOpenshellVersion() ??
      deps.supportedOpenshellFallbackVersion;
    const manifestDigest = OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS[supportedVersion];
    return manifestDigest
      ? `ghcr.io/nvidia/openshell/supervisor@${manifestDigest}`
      : `ghcr.io/nvidia/openshell/supervisor:${supportedVersion}`;
  }

  function getPodmanDriverGatewayEnv(
    versionOutput: string | null = null,
    platform: NodeJS.Platform = process.platform,
  ): Record<string, string> {
    const gatewayEnv = buildPodmanDriverGatewayEnv({
      platform,
      gatewayPort: currentGatewayPort(),
      stateDir: getPodmanDriverGatewayStateDir(),
      podmanNetworkName: process.env.OPENSHELL_PODMAN_NETWORK_NAME || "openshell-podman",
      getPodmanSupervisorImage: () => getOpenShellPodmanSupervisorImage(versionOutput),
    });
    if (gatewayEnv.OPENSHELL_LOCAL_TLS_DIR) {
      process.env.OPENSHELL_LOCAL_TLS_DIR = gatewayEnv.OPENSHELL_LOCAL_TLS_DIR;
    }
    if (gatewayEnv.OPENSHELL_PODMAN_SOCKET) {
      process.env.OPENSHELL_PODMAN_SOCKET = gatewayEnv.OPENSHELL_PODMAN_SOCKET;
    }
    return gatewayEnv;
  }

  function getPodmanDriverGatewayPid(): number | null {
    try {
      const raw = fs.readFileSync(getPodmanDriverGatewayPidFile(), "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isErrnoException(error) && error.code === "EPERM";
    }
  }

  function captureProcessArgs(pid: number): string {
    return deps
      .runCapture(["ps", "-p", String(pid), "-o", "args="], {
        ignoreError: true,
      })
      .trim();
  }

  function isPodmanDriverGatewayProcess(pid: number, gatewayBin?: string | null): boolean {
    const procCmdlinePath = `/proc/${pid}/cmdline`;
    let identity = "";
    try {
      if (fs.existsSync(procCmdlinePath)) {
        identity = fs.readFileSync(procCmdlinePath, "utf-8").replace(/\0/g, " ").trim();
      }
    } catch {
      identity = "";
    }
    if (!identity) identity = captureProcessArgs(pid);
    if (!identity) return false;
    return processIdentityMatchesGatewayBinary(identity, gatewayBin);
  }

  function getPodmanDriverGatewayRuntimeDrift(
    pid: number,
    desiredEnv: Record<string, string>,
    gatewayBin?: string | null,
  ): PodmanDriverGatewayRuntimeDrift | null {
    const processEnv = readProcessEnv(pid);
    if (!processEnv) return { reason: "could not verify process environment" };
    for (const key of PODMAN_DRIVER_GATEWAY_RUNTIME_ENV_KEYS) {
      const desired = desiredEnv[key];
      if (typeof desired !== "string") continue;
      const actual = processEnv[key];
      if (actual !== desired) {
        return { reason: `${key}=${actual || "<unset>"} (expected ${desired})` };
      }
    }
    const processExe = readProcessExe(pid);
    if (processExe === null) return { reason: "could not verify process executable" };
    if (processExe.endsWith(" (deleted)")) {
      return { reason: "gateway executable was replaced on disk" };
    }
    const expectedExe = normalizeGatewayExecutablePath(gatewayBin);
    const actualExe = normalizeGatewayExecutablePath(processExe);
    if (expectedExe && actualExe && actualExe !== expectedExe) {
      return { reason: `executable=${actualExe} (expected ${expectedExe})` };
    }
    return null;
  }

  function clearPodmanDriverGatewayRuntimeFiles(): void {
    fs.rmSync(getPodmanDriverGatewayPidFile(), { force: true });
    fs.rmSync(path.join(getPodmanDriverGatewayStateDir(), "runtime.json"), { force: true });
  }

  function rememberPodmanDriverGatewayPid(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    fs.mkdirSync(path.dirname(getPodmanDriverGatewayPidFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(getPodmanDriverGatewayPidFile(), `${pid}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.chmodSync(getPodmanDriverGatewayPidFile(), 0o600);
    fs.writeFileSync(
      path.join(getPodmanDriverGatewayStateDir(), "runtime.json"),
      `${JSON.stringify(
        {
          version: 1,
          driver: "podman",
          pid,
          endpoint: getPodmanDriverGatewayEndpoint(currentGatewayPort()),
          socketPath: normalizeOptionalString(process.env.OPENSHELL_PODMAN_SOCKET),
          gatewayName: gatewayBinding.resolveGatewayName(currentGatewayPort()),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  }

  function isPodmanDriverGatewayProcessAlive(): boolean {
    const pid = getPodmanDriverGatewayPid();
    if (pid === null || !isPidAlive(pid)) return false;
    if (!isPodmanDriverGatewayProcess(pid, resolveSiblingBinary("openshell-gateway"))) {
      clearPodmanDriverGatewayRuntimeFiles();
      return false;
    }
    return true;
  }

  return {
    clearPodmanDriverGatewayRuntimeFiles,
    getPodmanDriverGatewayEnv,
    getPodmanDriverGatewayPid,
    getPodmanDriverGatewayPidFile,
    getPodmanDriverGatewayRuntimeDrift,
    getPodmanDriverGatewayStateDir,
    isPidAlive,
    isPodmanDriverGatewayProcess,
    isPodmanDriverGatewayProcessAlive,
    rememberPodmanDriverGatewayPid,
  };
}
