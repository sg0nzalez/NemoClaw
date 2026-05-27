// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import {
  type GatewayMetadataOptions,
  type ResolvedGatewayMetadata,
  resolveGatewayMetadata,
} from "./gateway-metadata";

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

export interface SandboxLogLine {
  sandbox_id?: string;
  timestamp_ms?: number | string;
  level?: string;
  target?: string;
  message?: string;
  source?: string;
  fields?: Record<string, string>;
}

export interface SandboxLogsResult {
  logs: SandboxLogLine[];
  bufferTotal: number;
}

export type SandboxWatchEvent =
  | { type: "sandbox"; sandbox: unknown }
  | { type: "log"; log: SandboxLogLine }
  | { type: "event"; event: unknown }
  | { type: "warning"; message: string };

export interface SandboxForwardHandle {
  sandboxName: string;
  sandboxId: string;
  localPort: number;
  localHost: string;
  targetHost: string;
  targetPort: number;
  close(): Promise<void>;
}

export interface SandboxGrpcClientOptions extends GatewayMetadataOptions {
  gateway?: ResolvedGatewayMetadata;
}

type GrpcClient = grpc.Client & Record<string, (...args: any[]) => any>;

const DEFAULT_GRPC_TIMEOUT_MS = 30_000;
const STREAM_CHUNK_SIZE = 64 * 1024;

let packageDefinition: grpc.GrpcObject | null = null;

function protoRoot(): string {
  return path.join(__dirname, "proto");
}

function loadOpenShellPackage(): grpc.GrpcObject {
  if (packageDefinition) return packageDefinition;
  const definition = protoLoader.loadSync(path.join(protoRoot(), "openshell.proto"), {
    defaults: false,
    enums: String,
    includeDirs: [protoRoot()],
    keepCase: true,
    longs: String,
    oneofs: true,
    bytes: Buffer,
  });
  packageDefinition = grpc.loadPackageDefinition(definition) as grpc.GrpcObject;
  return packageDefinition;
}

function getOpenShellConstructor(): typeof grpc.Client {
  const loaded = loadOpenShellPackage() as any;
  const ctor = loaded.openshell?.v1?.OpenShell;
  if (!ctor) {
    throw new Error("Failed to load openshell.v1.OpenShell from vendored proto files.");
  }
  return ctor;
}

function readRequiredFile(filePath: string, label: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(
      `Failed to read OpenShell ${label} at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function createCredentials(gateway: ResolvedGatewayMetadata): grpc.ChannelCredentials {
  if (gateway.authMode === "plaintext" || gateway.endpoint.protocol === "http:") {
    return grpc.credentials.createInsecure();
  }
  if (!gateway.mtlsDir) {
    throw new Error(
      "OpenShell mTLS gateway metadata did not include a certificate directory. " +
        "Run `openshell gateway info` and verify the gateway is registered locally.",
    );
  }
  const ca = readRequiredFile(path.join(gateway.mtlsDir, "ca.crt"), "mTLS CA");
  const cert = readRequiredFile(path.join(gateway.mtlsDir, "tls.crt"), "mTLS client certificate");
  const key = readRequiredFile(path.join(gateway.mtlsDir, "tls.key"), "mTLS client key");
  return grpc.credentials.createSsl(ca, key, cert);
}

function method<T extends (...args: any[]) => any>(client: GrpcClient, name: string): T {
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  const fn = client[lower] || client[name];
  if (typeof fn !== "function") {
    throw new Error(`OpenShell gRPC method ${name} is unavailable.`);
  }
  return fn.bind(client) as T;
}

function callOptions(timeoutMs?: number): grpc.CallOptions {
  const deadlineMs = timeoutMs ?? DEFAULT_GRPC_TIMEOUT_MS;
  return deadlineMs > 0 ? { deadline: new Date(Date.now() + deadlineMs) } : {};
}

function grpcStatusName(code: number | undefined): string {
  if (typeof code !== "number") return "UNKNOWN";
  return grpc.status[code] || String(code);
}

export function formatGrpcError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const maybe = error as Partial<grpc.ServiceError>;
  const status = grpcStatusName(maybe.code);
  const details = maybe.details || maybe.message || String(error);
  return `${status}: ${details}`;
}

function makeTimeoutError(label: string, timeoutMs: number): Error {
  const error = new Error(`${label} timed out after ${timeoutMs} ms`) as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}

function bufferFromData(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "base64");
  return Buffer.alloc(0);
}

function exitCodeFromEvent(event: any): number | null {
  const raw = event?.exit?.exit_code ?? event?.exit?.exitCode;
  if (raw === undefined || raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 1;
}

function stdinBuffer(input: Buffer | string | undefined): Buffer | undefined {
  if (input === undefined) return undefined;
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

function sandboxIdFromResponse(response: any, sandboxName: string): string {
  const sandbox = response?.sandbox;
  const id = sandbox?.metadata?.id || sandbox?.id;
  if (typeof id === "string" && id.trim()) return id;
  throw new Error(`OpenShell gateway returned no sandbox id for '${sandboxName}'.`);
}

function execRequest(sandboxId: string, argv: string[], opts: SandboxExecOptions = {}) {
  return {
    sandbox_id: sandboxId,
    command: argv,
    workdir: opts.workdir || "",
    environment: opts.env || {},
    timeout_seconds: opts.timeoutSeconds ?? Math.max(0, Math.ceil((opts.timeoutMs ?? 0) / 1000)),
    stdin: stdinBuffer(opts.stdin),
    tty: opts.tty === true,
    cols: opts.cols ?? 0,
    rows: opts.rows ?? 0,
  };
}

function collectExecStream(
  stream: grpc.ClientReadableStream<any>,
  label: string,
  timeoutMs?: number,
): Promise<SandboxStreamResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let exitCode: number | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    stream.on("data", (event: any) => {
      if (event?.stdout?.data !== undefined) stdout.push(bufferFromData(event.stdout.data));
      if (event?.stderr?.data !== undefined) stderr.push(bufferFromData(event.stderr.data));
      const parsedExitCode = exitCodeFromEvent(event);
      if (parsedExitCode !== null) exitCode = parsedExitCode;
    });
    stream.on("error", (error) => {
      settle(() => reject(new Error(`${label} failed: ${formatGrpcError(error)}`)));
    });
    stream.on("end", () => {
      settle(() =>
        resolve({
          status: exitCode ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      );
    });

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          stream.cancel();
        } catch {
          /* ignore */
        }
        settle(() => reject(makeTimeoutError(label, timeoutMs)));
      }, timeoutMs);
    }
  });
}

function collectDuplexExecStream(
  stream: grpc.ClientDuplexStream<any, any>,
  label: string,
  timeoutMs?: number,
): Promise<SandboxStreamResult> {
  return collectExecStream(stream as unknown as grpc.ClientReadableStream<any>, label, timeoutMs);
}

function writeInputChunks(stream: grpc.ClientDuplexStream<any, any>, input: Buffer): void {
  for (let offset = 0; offset < input.length; offset += STREAM_CHUNK_SIZE) {
    stream.write({ stdin: input.subarray(offset, offset + STREAM_CHUNK_SIZE) });
  }
}

export class SandboxGrpcClient {
  readonly gateway: ResolvedGatewayMetadata;
  private readonly client: GrpcClient;

  constructor(options: SandboxGrpcClientOptions = {}) {
    this.gateway = options.gateway ?? resolveGatewayMetadata(options);
    const OpenShell = getOpenShellConstructor();
    this.client = new OpenShell(this.gateway.target, createCredentials(this.gateway), {
      "grpc.max_receive_message_length": 256 * 1024 * 1024,
      "grpc.max_send_message_length": 256 * 1024 * 1024,
    }) as GrpcClient;
  }

  close(): void {
    this.client.close();
  }

  async getSandboxId(sandboxName: string, timeoutMs?: number): Promise<string> {
    const getSandbox = method<
      (request: { name: string }, options: grpc.CallOptions, callback: grpc.requestCallback<any>) => void
    >(this.client, "GetSandbox");
    const response = await new Promise<any>((resolve, reject) => {
      getSandbox({ name: sandboxName }, callOptions(timeoutMs), (error, value) => {
        if (error) {
          reject(new Error(`GetSandbox '${sandboxName}' failed: ${formatGrpcError(error)}`));
        } else {
          resolve(value);
        }
      });
    });
    return sandboxIdFromResponse(response, sandboxName);
  }

  async execBinaryStream(
    sandboxName: string,
    argv: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxStreamResult> {
    const sandboxId = await this.getSandboxId(sandboxName, opts.timeoutMs);
    const execSandbox = method<
      (request: unknown, options?: grpc.CallOptions) => grpc.ClientReadableStream<any>
    >(this.client, "ExecSandbox");
    const request = execRequest(sandboxId, argv, opts);
    return collectExecStream(
      execSandbox(request, callOptions(opts.timeoutMs)),
      `ExecSandbox '${sandboxName}'`,
      opts.timeoutMs,
    );
  }

  async execText(
    sandboxName: string,
    argv: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecResult> {
    const result = await this.execBinaryStream(sandboxName, argv, opts);
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
    const sandboxId = await this.getSandboxId(sandboxName, opts.timeoutMs);
    const execInteractive = method<() => grpc.ClientDuplexStream<any, any>>(
      this.client,
      "ExecSandboxInteractive",
    );
    const stream = execInteractive();
    const result = collectDuplexExecStream(
      stream,
      `ExecSandboxInteractive '${sandboxName}'`,
      opts.timeoutMs,
    );
    stream.write({ start: execRequest(sandboxId, argv, opts) });
    writeInputChunks(stream, stdinBuffer(input) ?? Buffer.alloc(0));
    stream.end();
    return result;
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
    const sandboxId = await this.getSandboxId(sandboxName, opts.timeoutMs);
    const getLogs = method<
      (request: unknown, options: grpc.CallOptions, callback: grpc.requestCallback<any>) => void
    >(this.client, "GetSandboxLogs");
    const response = await new Promise<any>((resolve, reject) => {
      getLogs(
        {
          sandbox_id: sandboxId,
          lines: opts.lines ?? 0,
          since_ms: opts.sinceMs ?? 0,
          sources: opts.sources ?? [],
          min_level: opts.minLevel ?? "",
        },
        callOptions(opts.timeoutMs),
        (error, value) => {
          if (error) {
            reject(new Error(`GetSandboxLogs '${sandboxName}' failed: ${formatGrpcError(error)}`));
          } else {
            resolve(value);
          }
        },
      );
    });
    return {
      logs: Array.isArray(response?.logs) ? response.logs : [],
      bufferTotal: Number(response?.buffer_total ?? 0),
    };
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
    const sandboxId = await this.getSandboxId(sandboxName, opts.timeoutMs);
    const watchSandbox = method<
      (request: unknown, options?: grpc.CallOptions) => grpc.ClientReadableStream<any>
    >(this.client, "WatchSandbox");
    const stream = watchSandbox(
      {
        id: sandboxId,
        follow_status: opts.followStatus === true,
        follow_logs: opts.followLogs === true,
        follow_events: opts.followEvents === true,
        log_tail_lines: opts.logTailLines ?? 0,
        event_tail: opts.eventTail ?? 0,
        stop_on_terminal: opts.stopOnTerminal === true,
        log_since_ms: opts.logSinceMs ?? 0,
        log_sources: opts.logSources ?? [],
        log_min_level: opts.logMinLevel ?? "",
      },
      callOptions(opts.timeoutMs),
    );
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (event: any) => {
        if (!opts.onEvent) return;
        if (event?.sandbox !== undefined) opts.onEvent({ type: "sandbox", sandbox: event.sandbox });
        if (event?.log !== undefined) opts.onEvent({ type: "log", log: event.log });
        if (event?.event !== undefined) opts.onEvent({ type: "event", event: event.event });
        if (event?.warning !== undefined) {
          opts.onEvent({
            type: "warning",
            message: String(event.warning.message || ""),
          });
        }
      });
      stream.on("error", (error) => {
        reject(new Error(`WatchSandbox '${sandboxName}' failed: ${formatGrpcError(error)}`));
      });
      stream.on("end", () => resolve());
    });
  }

  async createSshSession(
    sandboxName: string,
    timeoutMs = DEFAULT_GRPC_TIMEOUT_MS,
  ): Promise<{ sandboxId: string; token: string }> {
    const sandboxId = await this.getSandboxId(sandboxName, timeoutMs);
    const createSession = method<
      (
        request: { sandbox_id: string },
        options: grpc.CallOptions,
        callback: grpc.requestCallback<any>,
      ) => void
    >(this.client, "CreateSshSession");
    const response = await new Promise<any>((resolve, reject) => {
      createSession({ sandbox_id: sandboxId }, callOptions(timeoutMs), (error, value) => {
        if (error) {
          reject(new Error(`CreateSshSession '${sandboxName}' failed: ${formatGrpcError(error)}`));
        } else {
          resolve(value);
        }
      });
    });
    const token = response?.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`OpenShell gateway returned no relay token for '${sandboxName}'.`);
    }
    return { sandboxId, token };
  }

  async forwardTcpConnection(
    socket: net.Socket,
    params: {
      sandboxName: string;
      targetHost: string;
      targetPort: number;
      serviceId?: string;
      timeoutMs?: number;
    },
  ): Promise<void> {
    const { sandboxId, token } = await this.createSshSession(params.sandboxName, params.timeoutMs);
    const forwardTcp = method<() => grpc.ClientDuplexStream<any, any>>(this.client, "ForwardTcp");
    const stream = forwardTcp();
    stream.write({
      init: {
        sandbox_id: sandboxId,
        service_id: params.serviceId || "",
        tcp: { host: params.targetHost, port: params.targetPort },
        authorization_token: token,
      },
    });
    socket.on("data", (chunk) => stream.write({ data: chunk }));
    socket.on("end", () => stream.end());
    socket.on("error", () => {
      try {
        stream.cancel();
      } catch {
        /* ignore */
      }
    });
    stream.on("data", (frame: any) => {
      const data = frame?.data;
      if (data !== undefined) socket.write(bufferFromData(data));
    });
    stream.on("end", () => socket.end());
    stream.on("error", () => socket.destroy());
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
    const localHost = options.localHost || "127.0.0.1";
    const targetHost = options.targetHost || "127.0.0.1";
    const sandboxId = await this.getSandboxId(sandboxName);
    const server = net.createServer((socket) => {
      this.forwardTcpConnection(socket, {
        sandboxName,
        targetHost,
        targetPort: options.targetPort,
        serviceId: options.serviceId,
      }).catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.localPort, localHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return {
      sandboxName,
      sandboxId,
      localPort: options.localPort,
      localHost,
      targetHost,
      targetPort: options.targetPort,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
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

  throw new Error("OpenShell gRPC sync runner is not available. Run `npm run build:cli` first.");
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
      `OpenShell gRPC sync runner returned invalid JSON: ${
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
  if (!response.ok || !response.result) throw new Error(response.error || "OpenShell gRPC exec failed");
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
  if (!response.ok || !response.result) throw new Error(response.error || "OpenShell gRPC exec failed");
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
  if (!response.ok || !response.result) throw new Error(response.error || "OpenShell gRPC exec failed");
  return {
    status: response.result.status,
    stdout: Buffer.from(response.result.stdoutBase64 || "", "base64"),
    stderr: Buffer.from(response.result.stderrBase64 || "", "base64"),
  };
}

export const __grpcTestHooks = {
  collectExecStream,
  exitCodeFromEvent,
};

// Keep CommonJS transpilation happy if this file is ever executed through ESM-aware tooling.
void fileURLToPath;
