// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  ExecOptions as SdkExecOptions,
  ExecResult as SdkExecResult,
  Health,
  ListOptions,
  SandboxRef,
  SandboxSpec,
} from "@openshell/sdk";

import {
  type GatewayMetadataOptions,
  type ResolvedGatewayMetadata,
  resolveGatewayMetadata,
} from "./gateway-metadata";
import {
  formatDirectGrpcError,
  OpenShellDirectGrpcClient,
  type SandboxLogsResult,
  type SandboxWatchEvent,
} from "./direct-grpc";

export type { SandboxLogLine, SandboxLogsResult, SandboxWatchEvent } from "./direct-grpc";

export interface SandboxExecOptions {
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  timeoutSeconds?: number;
  stdin?: Buffer | string;
  tty?: boolean;
  cols?: number;
  rows?: number;
}

export interface SandboxExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SandboxStreamResult {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface SandboxForwardHandle {
  sandboxName: string;
  localPort: number;
  localHost: string;
  targetHost: string;
  targetPort: number;
  close(): Promise<void>;
}

export interface SandboxGrpcClientOptions extends GatewayMetadataOptions {
  gateway?: ResolvedGatewayMetadata;
}

const DEFAULT_SDK_TIMEOUT_MS = 30_000;
const MAX_SYNC_STDIO_BUFFER = 512 * 1024 * 1024;

type OpenShellClientConstructor = typeof import("@openshell/sdk").OpenShellClient;
type OpenShellClientInstance = InstanceType<OpenShellClientConstructor>;

const clientCache = new Map<string, Promise<OpenShellClientInstance>>();
let sdkClientConstructor: OpenShellClientConstructor | null = null;

function openShellClientConstructor(): OpenShellClientConstructor {
  if (!sdkClientConstructor) {
    sdkClientConstructor = require("@openshell/sdk").OpenShellClient as OpenShellClientConstructor;
  }
  return sdkClientConstructor;
}

function cacheKey(gateway: ResolvedGatewayMetadata): string {
  return [
    gateway.name,
    gateway.connectOptions.gateway,
    gateway.authMode,
    gateway.insecureTls ? "insecure" : "verify",
    gateway.caCertPath || "",
  ].join("\n");
}

function getSharedSdkClient(gateway: ResolvedGatewayMetadata): Promise<OpenShellClientInstance> {
  if (!gateway.sdkCompatible) {
    throw new Error(
      "The selected OpenShell gateway uses mTLS client-certificate authentication, " +
        "but @openshell/sdk does not expose client-certificate auth yet. " +
        "Select a plaintext, OIDC, or Cloudflare JWT gateway, or land SDK mTLS support upstream first.",
    );
  }
  const key = cacheKey(gateway);
  let existing = clientCache.get(key);
  if (!existing) {
    existing = openShellClientConstructor().connect(gateway.connectOptions);
    clientCache.set(key, existing);
  }
  return existing;
}

function stdinBuffer(input: Buffer | string | undefined): Buffer | undefined {
  if (input === undefined) return undefined;
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

function timeoutSecs(opts: SandboxExecOptions): number | undefined {
  if (opts.timeoutSeconds !== undefined) return opts.timeoutSeconds;
  if (opts.timeoutMs === undefined || opts.timeoutMs <= 0) return undefined;
  return Math.max(1, Math.ceil(opts.timeoutMs / 1000));
}

function toSdkExecOptions(opts: SandboxExecOptions = {}): SdkExecOptions {
  return {
    ...(opts.workdir ? { workdir: opts.workdir } : {}),
    ...(opts.env ? { environment: opts.env } : {}),
    ...(timeoutSecs(opts) !== undefined ? { timeoutSecs: timeoutSecs(opts) } : {}),
    ...(stdinBuffer(opts.stdin) ? { stdin: stdinBuffer(opts.stdin) } : {}),
  };
}

function sdkExitCode(result: SdkExecResult): number {
  const raw = (result as SdkExecResult & { exit_code?: unknown }).exitCode ?? (result as any).exit_code;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 1;
}

function sdkBuffer(value: Buffer | Uint8Array | string | undefined): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.alloc(0);
}

function sdkResultToStream(result: SdkExecResult): SandboxStreamResult {
  return {
    status: sdkExitCode(result),
    stdout: sdkBuffer(result.stdout),
    stderr: sdkBuffer(result.stderr),
  };
}

function sdkErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = /^\[([^\]]+)\]/.exec(error.message);
  return match ? match[1] : null;
}

export function formatSdkError(error: unknown): string {
  const code = sdkErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const clean = message.replace(/^\[[^\]]+\]\s*/, "");
  return code ? `${code}: ${clean}` : clean;
}

export const formatGrpcError = formatSdkError;

function shouldTryDirectGrpcFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("@openshell/sdk is not published yet") ||
    message.includes("does not expose client-certificate auth yet")
  );
}

export class SandboxGrpcClient {
  readonly gateway: ResolvedGatewayMetadata;

  constructor(options: SandboxGrpcClientOptions = {}) {
    this.gateway = options.gateway ?? resolveGatewayMetadata(options);
  }

  private sdk(): Promise<OpenShellClientInstance> {
    return getSharedSdkClient(this.gateway);
  }

  close(): void {
    // @openshell/sdk clients are shared and currently expose no close method.
  }

  async health(): Promise<Health> {
    try {
      return await (await this.sdk()).health();
    } catch (error) {
      throw new Error(`OpenShell SDK health failed: ${formatSdkError(error)}`);
    }
  }

  async createSandbox(spec: SandboxSpec): Promise<SandboxRef> {
    try {
      return await (await this.sdk()).createSandbox(spec);
    } catch (error) {
      throw new Error(`CreateSandbox failed: ${formatSdkError(error)}`);
    }
  }

  async getSandbox(sandboxName: string): Promise<SandboxRef> {
    try {
      return await (await this.sdk()).getSandbox(sandboxName);
    } catch (error) {
      throw new Error(`GetSandbox '${sandboxName}' failed: ${formatSdkError(error)}`);
    }
  }

  async listSandboxes(options?: ListOptions | null): Promise<SandboxRef[]> {
    try {
      return await (await this.sdk()).listSandboxes(options);
    } catch (error) {
      throw new Error(`ListSandboxes failed: ${formatSdkError(error)}`);
    }
  }

  async deleteSandbox(sandboxName: string): Promise<boolean> {
    try {
      return await (await this.sdk()).deleteSandbox(sandboxName);
    } catch (error) {
      throw new Error(`DeleteSandbox '${sandboxName}' failed: ${formatSdkError(error)}`);
    }
  }

  async waitReady(sandboxName: string, timeoutSeconds: number): Promise<SandboxRef> {
    try {
      return await (await this.sdk()).waitReady(sandboxName, timeoutSeconds);
    } catch (error) {
      throw new Error(`WaitReady '${sandboxName}' failed: ${formatSdkError(error)}`);
    }
  }

  async waitDeleted(sandboxName: string, timeoutSeconds: number): Promise<void> {
    try {
      await (await this.sdk()).waitDeleted(sandboxName, timeoutSeconds);
    } catch (error) {
      throw new Error(`WaitDeleted '${sandboxName}' failed: ${formatSdkError(error)}`);
    }
  }

  async execBinary(
    sandboxName: string,
    argv: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxStreamResult> {
    try {
      const result = await (await this.sdk()).exec(sandboxName, argv, toSdkExecOptions(opts));
      return sdkResultToStream(result);
    } catch (error) {
      if (shouldTryDirectGrpcFallback(error)) {
        const direct = new OpenShellDirectGrpcClient({ gateway: this.gateway });
        try {
          return await direct.execBinaryStream(sandboxName, argv, opts);
        } catch (directError) {
          const detail =
            directError instanceof Error ? directError.message : formatDirectGrpcError(directError);
          throw new Error(
            `OpenShell SDK exec '${sandboxName}' failed: ${formatSdkError(error)}; ` +
              `direct gRPC ExecSandbox fallback failed: ${detail}`,
          );
        } finally {
          direct.close();
        }
      }
      throw new Error(`OpenShell SDK exec '${sandboxName}' failed: ${formatSdkError(error)}`);
    }
  }

  async execBinaryStream(
    sandboxName: string,
    argv: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxStreamResult> {
    return this.execBinary(sandboxName, argv, opts);
  }

  async execText(
    sandboxName: string,
    argv: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecResult> {
    const result = await this.execBinary(sandboxName, argv, opts);
    return {
      status: result.status,
      stdout: result.stdout.toString("utf-8"),
      stderr: result.stderr.toString("utf-8"),
    };
  }

  async execInputStream(
    sandboxName: string,
    argv: string[],
    input: Buffer | string,
    opts: SandboxExecOptions = {},
  ): Promise<SandboxStreamResult> {
    return this.execBinary(sandboxName, argv, { ...opts, stdin: stdinBuffer(input) });
  }

  async startForward(
    sandboxName: string,
    options: {
      localPort: number;
      localHost?: string;
      targetHost?: string;
      targetPort: number;
      serviceId?: string;
    },
  ): Promise<SandboxForwardHandle> {
    const direct = new OpenShellDirectGrpcClient({ gateway: this.gateway });
    try {
      const handle = await direct.startForward(sandboxName, options);
      return {
        ...handle,
        close: async () => {
          try {
            await handle.close();
          } finally {
            direct.close();
          }
        },
      };
    } catch (error) {
      direct.close();
      const detail = error instanceof Error ? error.message : formatDirectGrpcError(error);
      throw new Error(`OpenShell gRPC ForwardTcp '${sandboxName}' failed: ${detail}`);
    }
  }

  async getSandboxLogs(
    sandboxName: string,
    opts: {
      lines?: number;
      sinceMs?: number;
      sources?: string[];
      minLevel?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<SandboxLogsResult> {
    const direct = new OpenShellDirectGrpcClient({ gateway: this.gateway });
    try {
      return await direct.getSandboxLogs(sandboxName, opts);
    } finally {
      direct.close();
    }
  }

  async watchSandbox(
    sandboxName: string,
    opts: {
      followStatus?: boolean;
      followLogs?: boolean;
      followEvents?: boolean;
      logTailLines?: number;
      eventTail?: number;
      stopOnTerminal?: boolean;
      logSinceMs?: number;
      logSources?: string[];
      logMinLevel?: string;
      timeoutMs?: number;
      onEvent?: (event: SandboxWatchEvent) => void;
    } = {},
  ): Promise<void> {
    const direct = new OpenShellDirectGrpcClient({ gateway: this.gateway });
    try {
      await direct.watchSandbox(sandboxName, opts);
    } finally {
      direct.close();
    }
  }
}

export function createSandboxGrpcClient(options: SandboxGrpcClientOptions = {}): SandboxGrpcClient {
  return new SandboxGrpcClient(options);
}

interface SyncRunnerResponse {
  ok: boolean;
  result?: {
    status: number;
    stdout?: string;
    stderr?: string;
    stdoutBase64?: string;
    stderrBase64?: string;
  };
  error?: string;
}

function syncRunnerCommand(): { command: string; args: string[] } {
  const built = path.join(__dirname, "sync-runner.js");
  if (fs.existsSync(built)) return { command: process.execPath, args: [built] };

  const source = path.join(__dirname, "sync-runner.ts");
  const root = path.resolve(__dirname, "..", "..", "..", "..");
  const tsxBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (fs.existsSync(source) && fs.existsSync(tsxBin)) return { command: tsxBin, args: [source] };

  throw new Error("OpenShell SDK sync runner is not available. Run `npm run build:cli` first.");
}

function runSyncRunner(
  payload: Record<string, unknown>,
  timeoutMs?: number,
): SyncRunnerResponse {
  const { command, args } = syncRunnerCommand();
  const result = spawnSync(command, args, {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs && timeoutMs > 0 ? timeoutMs + 5_000 : undefined,
    maxBuffer: MAX_SYNC_STDIO_BUFFER,
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `sync runner exited ${result.status}`).trim());
  }
  try {
    return JSON.parse(result.stdout) as SyncRunnerResponse;
  } catch (error) {
    throw new Error(
      `OpenShell SDK sync runner returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function execTextSync(
  sandboxName: string,
  argv: string[],
  opts: SandboxExecOptions = {},
): SandboxExecResult {
  const response = runSyncRunner({ op: "execText", sandboxName, argv, opts }, opts.timeoutMs);
  if (!response.ok || !response.result) throw new Error(response.error || "OpenShell SDK exec failed");
  return {
    status: response.result.status,
    stdout: response.result.stdout || "",
    stderr: response.result.stderr || "",
  };
}

export function execBinaryStreamSync(
  sandboxName: string,
  argv: string[],
  opts: SandboxExecOptions = {},
): SandboxStreamResult {
  const response = runSyncRunner({ op: "execBinary", sandboxName, argv, opts }, opts.timeoutMs);
  if (!response.ok || !response.result) throw new Error(response.error || "OpenShell SDK exec failed");
  return {
    status: response.result.status,
    stdout: Buffer.from(response.result.stdoutBase64 || "", "base64"),
    stderr: Buffer.from(response.result.stderrBase64 || "", "base64"),
  };
}

export function execInputStreamSync(
  sandboxName: string,
  argv: string[],
  input: Buffer | string,
  opts: SandboxExecOptions = {},
): SandboxStreamResult {
  const inputBase64 = (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString("base64");
  const response = runSyncRunner(
    { op: "execInput", sandboxName, argv, inputBase64, opts },
    opts.timeoutMs,
  );
  if (!response.ok || !response.result) throw new Error(response.error || "OpenShell SDK exec failed");
  return {
    status: response.result.status,
    stdout: Buffer.from(response.result.stdoutBase64 || "", "base64"),
    stderr: Buffer.from(response.result.stderrBase64 || "", "base64"),
  };
}

export function __clearSandboxSdkClientCacheForTests(): void {
  clientCache.clear();
}

export const __grpcTestHooks = {
  formatSdkError,
  toSdkExecOptions,
  sdkResultToStream,
  cacheKey,
  shouldTryDirectGrpcFallback,
};
