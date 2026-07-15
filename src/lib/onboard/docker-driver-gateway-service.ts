// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepSeconds, waitUntilAsync } from "../core/wait";
import { isGatewayHealthy } from "../state/gateway";
import { envInt } from "./env";
import {
  createGatewayHealthWaitOptions,
  formatGatewayHealthWaitLimit,
} from "./gateway-health-wait";
import { isDockerDriverGatewayHttpReady } from "./gateway-http-readiness";

export const OPENSHELL_GATEWAY_USER_SERVICE = "openshell-gateway";
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE = OPENSHELL_GATEWAY_USER_SERVICE;
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER =
  "NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1";

export interface OpenShellGatewayUserServiceOptions {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  home?: string;
  platform?: NodeJS.Platform;
  prepareServiceEnv?: () => void;
  readFileSync?: (filePath: string, encoding: BufferEncoding) => string;
  spawnSyncImpl?: SpawnSyncLike;
}

export interface OpenShellGatewayUserServiceStartResult {
  attempted: boolean;
  fallbackAllowed: boolean;
  reason?: string;
  serviceName?: string;
  started: boolean;
}

export interface InstallNemoclawOpenShellGatewayUserServiceOptions
  extends Pick<
    OpenShellGatewayUserServiceOptions,
    "existsSync" | "home" | "platform" | "readFileSync"
  > {
  chmodSync?: (filePath: string, mode: number) => void;
  gatewayBin: string | null;
  mkdirSync?: typeof fs.mkdirSync;
  rmSync?: typeof fs.rmSync;
  writeFileSync?: typeof fs.writeFileSync;
}

export interface InstallNemoclawOpenShellGatewayUserServiceResult {
  installed: boolean;
  path?: string;
  reason?: string;
  removed?: boolean;
}

export interface SpawnSyncLikeResult {
  error?: Error;
  status: number | null;
  stderr?: Buffer | string | null;
  stdout?: Buffer | string | null;
}

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => SpawnSyncLikeResult;

export interface PackageManagedDockerDriverGatewayOptions {
  clearDockerDriverGatewayRuntimeFiles: () => void;
  exitOnFailure: boolean;
  gatewayName: string;
  hasOpenShellGatewayUserService?: () => boolean;
  healthPollCount?: number;
  healthPollInterval?: number;
  isDockerDriverGatewayReady?: () => Promise<boolean>;
  now?: () => number;
  registerDockerDriverGatewayEndpoint: () => boolean;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  sleepSeconds?: (seconds: number) => void;
  prepareOpenShellGatewayUserServiceEnv?: () => void;
  skipSandboxBridgeReachability: boolean;
  startOpenShellGatewayUserService?: (
    opts?: Pick<OpenShellGatewayUserServiceOptions, "prepareServiceEnv">,
  ) => OpenShellGatewayUserServiceStartResult;
  verifySandboxBridgeGatewayReachableOrExit: (
    exitOnFailure: boolean,
    options?: { skip?: boolean },
  ) => Promise<void>;
}

interface OpenShellGatewayUserServiceIdentity {
  execStart: string;
  fragmentPath: string;
}

interface OpenShellGatewayUserServiceTarget {
  serviceName: string;
  trustedBinaryPaths: string[];
  trustedUnitPaths: string[];
}

export function getOpenShellGatewayUserServicePaths(): string[] {
  return [
    "/usr/local/lib/systemd/user/openshell-gateway.service",
    "/usr/lib/systemd/user/openshell-gateway.service",
    "/lib/systemd/user/openshell-gateway.service",
  ];
}

export function getOpenShellGatewayUserServiceBinaryPaths(): string[] {
  return ["/usr/local/bin/openshell-gateway", "/usr/bin/openshell-gateway"];
}

export function getNemoclawOpenShellGatewayUserServicePath(home = os.homedir()): string {
  return path.join(home, ".config", "systemd", "user", "openshell-gateway.service");
}

export function getNemoclawOpenShellGatewayUserServiceBinaryPaths(home = os.homedir()): string[] {
  return [
    path.join(home, ".local", "bin", "openshell-gateway"),
    ...getOpenShellGatewayUserServiceBinaryPaths(),
  ];
}

function readTextFileIfPresent(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): string {
  const readFileSync = opts.readFileSync ?? fs.readFileSync;
  try {
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    return "";
  }
}

function isNemoclawManagedOpenShellGatewayUserServiceUnit(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): boolean {
  return readTextFileIfPresent(filePath, opts).includes(
    NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  );
}

function hasUpstreamOpenShellGatewayUserService(
  opts: Pick<OpenShellGatewayUserServiceOptions, "existsSync" | "platform"> = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const existsSync = opts.existsSync ?? fs.existsSync;
  return getOpenShellGatewayUserServicePaths().some((candidate) => existsSync(candidate));
}

export function hasNemoclawOpenShellGatewayUserService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    "existsSync" | "home" | "platform" | "readFileSync"
  > = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(opts.home);
  return (
    existsSync(servicePath) && isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, opts)
  );
}

function resolveOpenShellGatewayUserService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    "existsSync" | "home" | "platform" | "readFileSync"
  > = {},
): OpenShellGatewayUserServiceTarget | null {
  if ((opts.platform ?? process.platform) !== "linux") return null;
  if (hasUpstreamOpenShellGatewayUserService(opts)) {
    return {
      serviceName: OPENSHELL_GATEWAY_USER_SERVICE,
      trustedBinaryPaths: getOpenShellGatewayUserServiceBinaryPaths(),
      trustedUnitPaths: getOpenShellGatewayUserServicePaths(),
    };
  }
  if (hasNemoclawOpenShellGatewayUserService(opts)) {
    const home = opts.home ?? os.homedir();
    return {
      serviceName: OPENSHELL_GATEWAY_USER_SERVICE,
      trustedBinaryPaths: getNemoclawOpenShellGatewayUserServiceBinaryPaths(home),
      trustedUnitPaths: [getNemoclawOpenShellGatewayUserServicePath(home)],
    };
  }
  return null;
}

export function hasOpenShellGatewayUserService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    "existsSync" | "home" | "platform" | "readFileSync"
  > = {},
): boolean {
  return resolveOpenShellGatewayUserService(opts) !== null;
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  return (
    spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      encoding: "utf-8",
      env,
    }).status === 0
  );
}

function text(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function userManagerLooksUnavailable(reason: string): boolean {
  return /Failed to connect to bus|No medium found|XDG_RUNTIME_DIR|System has not been booted|Host is down/i.test(
    reason,
  );
}

function runSystemctlUser(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { ok: boolean; reason?: string; stdout?: string } {
  const result = opts.spawnSyncImpl("systemctl", ["--user", ...args], {
    encoding: "utf-8",
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  } satisfies SpawnSyncOptions);
  if (result.error) {
    return { ok: false, reason: result.error.message };
  }
  if (result.status !== 0) {
    const detail =
      text(result.stderr).trim() || text(result.stdout).trim() || `exit ${String(result.status)}`;
    return { ok: false, reason: detail };
  }
  return { ok: true, stdout: text(result.stdout) };
}

function parseSystemctlShowProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return properties;
}

function isTrustedOpenShellGatewayUserServiceIdentity(
  service: OpenShellGatewayUserServiceTarget,
  identity: OpenShellGatewayUserServiceIdentity,
): boolean {
  const fragmentPath = path.normalize(identity.fragmentPath.trim());
  const trustedUnit = service.trustedUnitPaths.some(
    (candidate) => path.normalize(candidate) === fragmentPath,
  );
  if (!trustedUnit) return false;
  const execStartPath = extractSystemdExecStartPath(identity.execStart);
  if (!execStartPath) return false;
  const normalizedExecStartPath = path.normalize(execStartPath);
  return service.trustedBinaryPaths.some(
    (candidate) => path.normalize(candidate) === normalizedExecStartPath,
  );
}

function extractSystemdExecStartPath(execStart: string): string | null {
  const pathMatch = /(?:^|[\s;])path=([^\s;]+)/.exec(execStart);
  if (!pathMatch) return null;
  const execStartPath = pathMatch[1]?.trim();
  return execStartPath && path.isAbsolute(execStartPath) ? execStartPath : null;
}

function readTrustedOpenShellGatewayUserServiceIdentity(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { fallbackAllowed: boolean; ok: boolean; reason?: string } {
  const result = runSystemctlUser(
    ["show", service.serviceName, "--property=FragmentPath", "--property=ExecStart"],
    opts,
  );
  if (!result.ok) {
    return {
      fallbackAllowed: userManagerLooksUnavailable(result.reason ?? ""),
      ok: false,
      reason: `systemctl --user show ${service.serviceName} failed: ${result.reason}`,
    };
  }

  const properties = parseSystemctlShowProperties(result.stdout ?? "");
  const identity = {
    execStart: properties.ExecStart ?? "",
    fragmentPath: properties.FragmentPath ?? "",
  };
  if (!identity.fragmentPath || !identity.execStart) {
    return {
      fallbackAllowed: true,
      ok: false,
      reason: "service identity is incomplete",
    };
  }
  if (!isTrustedOpenShellGatewayUserServiceIdentity(service, identity)) {
    return {
      fallbackAllowed: true,
      ok: false,
      reason: `service identity is not a trusted OpenShell gateway (${identity.fragmentPath})`,
    };
  }
  return { fallbackAllowed: false, ok: true };
}

function assertSafeSystemdExecPath(filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error("OpenShell gateway service ExecStart must be an absolute path");
  }
  if (/[\0\r\n\t ]/.test(filePath)) {
    throw new Error("OpenShell gateway service ExecStart path cannot contain whitespace");
  }
}

export function buildNemoclawOpenShellGatewayUserService(gatewayBin: string): string {
  assertSafeSystemdExecPath(gatewayBin);
  return [
    "# NemoClaw-managed OpenShell gateway user service",
    `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
    "[Unit]",
    "Description=OpenShell Gateway",
    "Documentation=https://github.com/NVIDIA/OpenShell",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    "StateDirectory=openshell/gateway",
    "EnvironmentFile=-%E/openshell/gateway.env",
    `ExecStart=${gatewayBin}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "PrivateTmp=true",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function installNemoclawOpenShellGatewayUserService(
  opts: InstallNemoclawOpenShellGatewayUserServiceOptions,
): InstallNemoclawOpenShellGatewayUserServiceResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return { installed: false, reason: "not a Linux host" };
  const home = opts.home ?? os.homedir();
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home);
  const existsSync = opts.existsSync ?? fs.existsSync;
  if (hasUpstreamOpenShellGatewayUserService(opts)) {
    if (
      existsSync(servicePath) &&
      isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, {
        readFileSync: opts.readFileSync,
      })
    ) {
      const rmSync = opts.rmSync ?? fs.rmSync;
      rmSync(servicePath, { force: true });
      return {
        installed: false,
        path: servicePath,
        reason: "upstream OpenShell gateway service is installed",
        removed: true,
      };
    }
    return { installed: false, reason: "upstream OpenShell gateway service is installed" };
  }
  if (!opts.gatewayBin) return { installed: false, reason: "OpenShell gateway binary not found" };

  const alreadyExists = existsSync(servicePath);
  if (
    alreadyExists &&
    !isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, {
      readFileSync: opts.readFileSync,
    })
  ) {
    return {
      installed: false,
      path: servicePath,
      reason: "refusing to overwrite a non-NemoClaw gateway user service",
    };
  }

  let unit: string;
  try {
    unit = buildNemoclawOpenShellGatewayUserService(opts.gatewayBin);
  } catch (error) {
    return {
      installed: false,
      path: servicePath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const serviceDir = path.dirname(servicePath);
  const mkdirSync = opts.mkdirSync ?? fs.mkdirSync;
  const chmodSync = opts.chmodSync ?? fs.chmodSync;
  const writeFileSync = opts.writeFileSync ?? fs.writeFileSync;
  mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  chmodSync(serviceDir, 0o700);
  writeFileSync(servicePath, unit, { encoding: "utf-8", mode: 0o600 });
  chmodSync(servicePath, 0o600);
  return { installed: true, path: servicePath };
}

export function startOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): OpenShellGatewayUserServiceStartResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") {
    return { attempted: false, fallbackAllowed: true, started: false, reason: "not a Linux host" };
  }
  const existsSync = opts.existsSync ?? fs.existsSync;
  const service = resolveOpenShellGatewayUserService({
    existsSync,
    home: opts.home,
    platform,
    readFileSync: opts.readFileSync,
  });
  if (!service) {
    return {
      attempted: false,
      fallbackAllowed: true,
      started: false,
      reason: "service unit not installed",
    };
  }

  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  if (!commandExists("systemctl")) {
    return {
      attempted: true,
      fallbackAllowed: true,
      started: false,
      reason: "systemctl is not available",
    };
  }

  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  for (const args of [["daemon-reload"]]) {
    const result = runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const reason = `systemctl --user ${args.join(" ")} failed: ${result.reason}`;
      return {
        attempted: true,
        fallbackAllowed: userManagerLooksUnavailable(result.reason ?? ""),
        reason,
        started: false,
      };
    }
  }

  const identity = readTrustedOpenShellGatewayUserServiceIdentity(service, { env, spawnSyncImpl });
  if (!identity.ok) {
    return {
      attempted: true,
      fallbackAllowed: identity.fallbackAllowed,
      reason: identity.reason,
      started: false,
    };
  }

  try {
    opts.prepareServiceEnv?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      fallbackAllowed: false,
      reason: `failed to prepare OpenShell gateway service environment: ${detail}`,
      started: false,
    };
  }

  for (const args of [
    ["enable", service.serviceName],
    ["restart", service.serviceName],
  ]) {
    const result = runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const reason = `systemctl --user ${args.join(" ")} failed: ${result.reason}`;
      return {
        attempted: true,
        fallbackAllowed: userManagerLooksUnavailable(result.reason ?? ""),
        reason,
        started: false,
      };
    }
  }

  return {
    attempted: true,
    fallbackAllowed: false,
    serviceName: service.serviceName,
    started: true,
  };
}

export async function startPackageManagedDockerDriverGateway({
  clearDockerDriverGatewayRuntimeFiles,
  exitOnFailure,
  gatewayName,
  hasOpenShellGatewayUserService:
    hasOpenShellGatewayUserServiceImpl = hasOpenShellGatewayUserService,
  healthPollCount,
  healthPollInterval,
  isDockerDriverGatewayReady = isDockerDriverGatewayHttpReady,
  now = Date.now,
  registerDockerDriverGatewayEndpoint,
  runCaptureOpenshell,
  sleepSeconds: sleepSecondsImpl = sleepSeconds,
  prepareOpenShellGatewayUserServiceEnv,
  skipSandboxBridgeReachability,
  startOpenShellGatewayUserService:
    startOpenShellGatewayUserServiceImpl = startOpenShellGatewayUserService,
  verifySandboxBridgeGatewayReachableOrExit,
}: PackageManagedDockerDriverGatewayOptions): Promise<boolean> {
  if (!hasOpenShellGatewayUserServiceImpl()) return false;

  console.log("  Starting OpenShell Docker-driver gateway via user service...");
  const serviceStart = startOpenShellGatewayUserServiceImpl({
    prepareServiceEnv: prepareOpenShellGatewayUserServiceEnv,
  });
  if (!serviceStart.started) {
    const detail = serviceStart.reason ? ` (${serviceStart.reason})` : "";
    if (serviceStart.fallbackAllowed) {
      console.warn(
        `  OpenShell gateway user service is unavailable${detail}; using standalone fallback.`,
      );
      return false;
    }
    const message = `OpenShell gateway user service failed to start${detail}.`;
    console.error(`  ${message}`);
    console.error(
      `  Check: systemctl --user status ${
        serviceStart.serviceName ?? OPENSHELL_GATEWAY_USER_SERVICE
      }`,
    );
    if (exitOnFailure) process.exit(1);
    throw new Error(message);
  }

  const pollCount = healthPollCount ?? envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
  const pollInterval = healthPollInterval ?? envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  const waitOptions = createGatewayHealthWaitOptions(pollCount, pollInterval, now, (ms) =>
    sleepSecondsImpl(ms / 1000),
  );
  const healthy =
    waitOptions !== null &&
    (await waitUntilAsync(async () => {
      if (!registerDockerDriverGatewayEndpoint()) return false;
      const status = runCaptureOpenshell(["status"], { ignoreError: true });
      const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
        ignoreError: true,
      });
      const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
      return (
        isGatewayHealthy(status, namedInfo, currentInfo) && (await isDockerDriverGatewayReady())
      );
    }, waitOptions));
  if (healthy) {
    clearDockerDriverGatewayRuntimeFiles();
    await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, {
      skip: skipSandboxBridgeReachability,
    });
    console.log("  ✓ OpenShell gateway user service is healthy");
    return true;
  }

  const message = `OpenShell gateway user service started but did not become healthy within the configured ${formatGatewayHealthWaitLimit(
    pollCount,
    pollInterval,
  )}.`;
  console.error(`  ${message}`);
  console.error("  Check: systemctl --user status openshell-gateway");
  if (exitOnFailure) process.exit(1);
  throw new Error(message);
}
