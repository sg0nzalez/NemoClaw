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
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER =
  "NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1";
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE = `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`;

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
    "env" | "existsSync" | "home" | "platform" | "readFileSync"
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

export interface InstallAndReportNemoclawOpenShellGatewayUserServiceOptions
  extends InstallNemoclawOpenShellGatewayUserServiceOptions {
  log?: (message: string) => void;
  warn?: (message: string) => void;
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

function effectiveHome(home: string | undefined, env: NodeJS.ProcessEnv | undefined): string {
  return home ?? env?.HOME ?? os.homedir();
}

export function getOpenShellUserConfigHome(home = os.homedir(), env?: NodeJS.ProcessEnv): string {
  const configured = env?.XDG_CONFIG_HOME?.trim();
  if (configured && path.isAbsolute(configured)) return path.normalize(configured);
  return path.join(home, ".config");
}

export function getNemoclawOpenShellGatewayUserServicePath(
  home = os.homedir(),
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(
    getOpenShellUserConfigHome(home, env),
    "systemd",
    "user",
    "openshell-gateway.service",
  );
}

export function getNemoclawOpenShellGatewayUserServiceBinaryPaths(home = os.homedir()): string[] {
  return [
    path.join(home, ".local", "bin", "openshell-gateway"),
    ...getOpenShellGatewayUserServiceBinaryPaths(),
  ];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTextFileIfPresent(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): string {
  const readFileSync = opts.readFileSync ?? fs.readFileSync;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function hasNemoclawOpenShellGatewayUserServiceMarker(unit: string): boolean {
  return unit
    .split(/\r?\n/)
    .some((line) => line.trimEnd() === NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE);
}

function isNemoclawManagedOpenShellGatewayUserServiceUnit(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): boolean {
  return hasNemoclawOpenShellGatewayUserServiceMarker(readTextFileIfPresent(filePath, opts));
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
    "env" | "existsSync" | "home" | "platform" | "readFileSync"
  > = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const env = opts.env ?? process.env;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const home = effectiveHome(opts.home, opts.env);
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
  return (
    existsSync(servicePath) &&
    isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, {
      readFileSync: opts.readFileSync,
    })
  );
}

function resolveOpenShellGatewayUserService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    "env" | "existsSync" | "home" | "platform" | "readFileSync"
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
    const env = opts.env ?? process.env;
    const home = effectiveHome(opts.home, opts.env);
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
    return {
      serviceName: OPENSHELL_GATEWAY_USER_SERVICE,
      trustedBinaryPaths: getNemoclawOpenShellGatewayUserServiceBinaryPaths(home),
      trustedUnitPaths: [servicePath],
    };
  }
  return null;
}

export function hasOpenShellGatewayUserService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    "env" | "existsSync" | "home" | "platform" | "readFileSync"
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

function isTrustedNemoclawGatewayServiceBinaryPath(filePath: string, home: string): boolean {
  const normalizedPath = path.normalize(filePath);
  return getNemoclawOpenShellGatewayUserServiceBinaryPaths(home).some(
    (candidate) => path.normalize(candidate) === normalizedPath,
  );
}

export function buildNemoclawOpenShellGatewayUserService(gatewayBin: string): string {
  assertSafeSystemdExecPath(gatewayBin);
  return [
    "# NemoClaw-managed OpenShell gateway user service",
    NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
    "[Unit]",
    "Description=OpenShell Gateway",
    "Documentation=https://github.com/NVIDIA/OpenShell",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    "StateDirectory=openshell/gateway",
    "Environment=OPENSHELL_LOCAL_TLS_DIR=%h/.local/state/openshell/tls",
    "EnvironmentFile=-%E/openshell/gateway.env",
    `ExecStartPre=${gatewayBin} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal --server-san localhost --server-san 127.0.0.1`,
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
  const home = effectiveHome(opts.home, opts.env);
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, opts.env);
  const existsSync = opts.existsSync ?? fs.existsSync;
  if (hasUpstreamOpenShellGatewayUserService(opts)) {
    if (
      existsSync(servicePath) &&
      isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, {
        readFileSync: opts.readFileSync,
      })
    ) {
      const rmSync = opts.rmSync ?? fs.rmSync;
      try {
        rmSync(servicePath, { force: true });
      } catch (error) {
        return {
          installed: false,
          path: servicePath,
          reason: `failed to remove NemoClaw gateway user service override: ${formatError(error)}`,
        };
      }
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
  if (!isTrustedNemoclawGatewayServiceBinaryPath(opts.gatewayBin, home)) {
    return {
      installed: false,
      path: servicePath,
      reason: "OpenShell gateway service ExecStart path is not in a trusted install path",
    };
  }

  const serviceDir = path.dirname(servicePath);
  const mkdirSync = opts.mkdirSync ?? fs.mkdirSync;
  const chmodSync = opts.chmodSync ?? fs.chmodSync;
  const writeFileSync = opts.writeFileSync ?? fs.writeFileSync;
  try {
    mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
    chmodSync(serviceDir, 0o700);
    writeFileSync(servicePath, unit, { encoding: "utf-8", mode: 0o600 });
    chmodSync(servicePath, 0o600);
  } catch (error) {
    return {
      installed: false,
      path: servicePath,
      reason: `failed to write OpenShell gateway user service: ${formatError(error)}`,
    };
  }
  return { installed: true, path: servicePath };
}

function isBenignGatewayUserServiceInstallSkip(reason: string | undefined): boolean {
  return (
    reason === "not a Linux host" || reason === "upstream OpenShell gateway service is installed"
  );
}

export function installAndReportNemoclawOpenShellGatewayUserService(
  opts: InstallAndReportNemoclawOpenShellGatewayUserServiceOptions,
): InstallNemoclawOpenShellGatewayUserServiceResult {
  const result = installNemoclawOpenShellGatewayUserService(opts);
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  if (result.installed && result.path) {
    log(`  Installed OpenShell gateway user service: ${result.path}`);
  } else if (result.removed && result.path) {
    log(`  Removed NemoClaw OpenShell gateway user service override: ${result.path}`);
  } else if (result.reason && !isBenignGatewayUserServiceInstallSkip(result.reason)) {
    warn(`  OpenShell gateway user service not installed: ${result.reason}.`);
  }
  return result;
}

export function startOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): OpenShellGatewayUserServiceStartResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") {
    return { attempted: false, fallbackAllowed: true, started: false, reason: "not a Linux host" };
  }
  const env = opts.env ?? process.env;
  const home = effectiveHome(opts.home, opts.env);
  const existsSync = opts.existsSync ?? fs.existsSync;
  const service = resolveOpenShellGatewayUserService({
    env,
    existsSync,
    home,
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

  const active = runSystemctlUser(["is-active", "--quiet", service.serviceName], {
    env,
    spawnSyncImpl,
  });
  if (!active.ok) {
    const reason = `systemctl --user is-active --quiet ${service.serviceName} failed: ${active.reason}`;
    return {
      attempted: true,
      fallbackAllowed: userManagerLooksUnavailable(active.reason ?? ""),
      reason,
      serviceName: service.serviceName,
      started: false,
    };
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
  let lastReadiness = {
    cliHealthy: false,
    grpcHealthy: false,
    registered: false,
  };
  const healthy =
    waitOptions !== null &&
    (await waitUntilAsync(async () => {
      const registered = registerDockerDriverGatewayEndpoint();
      if (!registered) {
        lastReadiness = { cliHealthy: false, grpcHealthy: false, registered };
        return false;
      }
      const status = runCaptureOpenshell(["status"], { ignoreError: true });
      const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
        ignoreError: true,
      });
      const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
      const cliHealthy = isGatewayHealthy(status, namedInfo, currentInfo);
      const grpcHealthy = await isDockerDriverGatewayReady();
      lastReadiness = { cliHealthy, grpcHealthy, registered };
      return cliHealthy || grpcHealthy;
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
  console.error(
    `  Last readiness check: endpoint registered=${lastReadiness.registered ? "yes" : "no"}, OpenShell CLI health=${lastReadiness.cliHealthy ? "yes" : "no"}, direct gRPC health=${lastReadiness.grpcHealthy ? "yes" : "no"}.`,
  );
  console.error("  Check: systemctl --user status openshell-gateway");
  if (exitOnFailure) process.exit(1);
  throw new Error(message);
}
