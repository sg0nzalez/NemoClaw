// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import {
  type GatewayMetadataOptions,
  type ResolvedGatewayMetadata,
  resolveGatewayMetadata,
} from "./gateway-metadata";

type GrpcClient = grpc.Client & Record<string, (...args: any[]) => any>;

const DEFAULT_GRPC_TIMEOUT_MS = 30_000;

let packageDefinition: grpc.GrpcObject | null = null;

export interface DirectGrpcClientOptions extends GatewayMetadataOptions {
  gateway?: ResolvedGatewayMetadata;
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

export interface DirectForwardHandle {
  sandboxName: string;
  localPort: number;
  localHost: string;
  targetHost: string;
  targetPort: number;
  close(): Promise<void>;
}

export interface DirectExecOptions {
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  timeoutSeconds?: number;
  stdin?: Buffer | string;
  tty?: boolean;
  cols?: number;
  rows?: number;
}

export interface DirectStreamResult {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface DirectTextResult {
  status: number;
  stdout: string;
  stderr: string;
}

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

function callCredentials(gateway: ResolvedGatewayMetadata): grpc.CallCredentials | null {
  const md = new grpc.Metadata();
  const oidcToken = gateway.connectOptions.oidcToken;
  const edgeToken = gateway.connectOptions.edgeToken;
  if (oidcToken) {
    md.set("authorization", `Bearer ${oidcToken}`);
  } else if (edgeToken) {
    md.set("cf-access-token", edgeToken);
    md.set("cf-access-jwt-assertion", edgeToken);
    md.set("cookie", `CF_Authorization=${edgeToken}`);
  }
  if (md.getMap && Object.keys(md.getMap()).length === 0) return null;
  return grpc.credentials.createFromMetadataGenerator((_params, callback) => {
    callback(null, md);
  });
}

function createCredentials(gateway: ResolvedGatewayMetadata): grpc.ChannelCredentials {
  if (gateway.authMode === "plaintext" || gateway.endpoint.protocol === "http:") {
    return grpc.credentials.createInsecure();
  }

  if (gateway.insecureTls) {
    throw new Error(
      "OpenShell raw gRPC does not support OPENSHELL_GATEWAY_INSECURE for HTTPS gateways yet. " +
        "Use a trusted CA in the gateway metadata, an mTLS gateway, or the upstream SDK transport.",
    );
  }

  const rootCerts = gateway.connectOptions.caCert;
  let channelCredentials: grpc.ChannelCredentials;
  if (gateway.authMode === "mtls") {
    if (!gateway.mtlsDir) {
      throw new Error(
        "OpenShell mTLS gateway metadata did not include a certificate directory. " +
          "Run `openshell gateway info` and verify the gateway is registered locally.",
      );
    }
    const ca = readRequiredFile(path.join(gateway.mtlsDir, "ca.crt"), "mTLS CA");
    const cert = readRequiredFile(path.join(gateway.mtlsDir, "tls.crt"), "mTLS client certificate");
    const key = readRequiredFile(path.join(gateway.mtlsDir, "tls.key"), "mTLS client key");
    channelCredentials = grpc.credentials.createSsl(ca, key, cert);
  } else {
    channelCredentials = grpc.credentials.createSsl(rootCerts);
  }

  const perCallCredentials = callCredentials(gateway);
  return perCallCredentials
    ? grpc.credentials.combineChannelCredentials(channelCredentials, perCallCredentials)
    : channelCredentials;
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

export function formatDirectGrpcError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const maybe = error as Partial<grpc.ServiceError>;
  const status = grpcStatusName(maybe.code);
  const details = maybe.details || maybe.message || String(error);
  return `${status}: ${details}`;
}

function bufferFromData(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "base64");
  return Buffer.alloc(0);
}

function stdinBuffer(input: Buffer | string | undefined): Buffer | undefined {
  if (input === undefined) return undefined;
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

function timeoutSeconds(opts: DirectExecOptions): number {
  if (opts.timeoutSeconds !== undefined) return opts.timeoutSeconds;
  if (opts.timeoutMs === undefined || opts.timeoutMs <= 0) return 0;
  return Math.max(1, Math.ceil(opts.timeoutMs / 1000));
}

function execRequest(sandboxId: string, argv: string[], opts: DirectExecOptions = {}) {
  return {
    sandbox_id: sandboxId,
    command: argv,
    workdir: opts.workdir || "",
    environment: opts.env || {},
    timeout_seconds: timeoutSeconds(opts),
    stdin: stdinBuffer(opts.stdin),
    tty: opts.tty === true,
    cols: opts.cols ?? 0,
    rows: opts.rows ?? 0,
  };
}

function makeTimeoutError(label: string, timeoutMs: number): Error {
  const error = new Error(`${label} timed out after ${timeoutMs} ms`) as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}

function collectExecStream(
  stream: grpc.ClientReadableStream<any>,
  label: string,
  timeoutMs?: number,
): Promise<DirectStreamResult> {
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
      if (event?.exit?.exit_code !== undefined) {
        const parsed = Number(event.exit.exit_code);
        exitCode = Number.isFinite(parsed) ? parsed : 1;
      }
    });
    stream.on("error", (error) => {
      settle(() => reject(new Error(`${label} failed: ${formatDirectGrpcError(error)}`)));
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

function sandboxIdFromResponse(response: any, sandboxName: string): string {
  const sandbox = response?.sandbox;
  const id = sandbox?.metadata?.id || sandbox?.id;
  if (typeof id === "string" && id.trim()) return id;
  throw new Error(`OpenShell gateway returned no sandbox id for '${sandboxName}'.`);
}

function sandboxPhase(response: any): string | number | null {
  const phase = response?.sandbox?.phase;
  return typeof phase === "string" || typeof phase === "number" ? phase : null;
}

function isReadyPhase(phase: string | number | null): boolean {
  return phase === null || phase === "SANDBOX_PHASE_READY" || phase === 2 || phase === "2";
}

function callUnary<TRequest, TResponse>(
  client: GrpcClient,
  name: string,
  request: TRequest,
  timeoutMs?: number,
): Promise<TResponse> {
  const fn = method<
    (request: TRequest, options: grpc.CallOptions, callback: grpc.requestCallback<TResponse>) => void
  >(client, name);
  return new Promise<TResponse>((resolve, reject) => {
    fn(request, callOptions(timeoutMs), (error, value) => {
      if (error) reject(new Error(`${name} failed: ${formatDirectGrpcError(error)}`));
      else resolve(value as TResponse);
    });
  });
}

export class OpenShellDirectGrpcClient {
  readonly gateway: ResolvedGatewayMetadata;
  private readonly client: GrpcClient;

  constructor(options: DirectGrpcClientOptions = {}) {
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
    const response = await callUnary<{ name: string }, any>(
      this.client,
      "GetSandbox",
      { name: sandboxName },
      timeoutMs,
    ).catch((error) => {
      throw new Error(`GetSandbox '${sandboxName}' failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return sandboxIdFromResponse(response, sandboxName);
  }

  async getReadySandboxIdForForward(sandboxName: string, timeoutMs?: number): Promise<string> {
    const response = await callUnary<{ name: string }, any>(
      this.client,
      "GetSandbox",
      { name: sandboxName },
      timeoutMs,
    ).catch((error) => {
      throw new Error(`GetSandbox '${sandboxName}' failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const phase = sandboxPhase(response);
    if (!isReadyPhase(phase)) {
      throw new Error(`sandbox '${sandboxName}' is not ready for forwarding (phase: ${String(phase)})`);
    }
    return sandboxIdFromResponse(response, sandboxName);
  }

  async execBinaryStream(
    sandboxName: string,
    argv: string[],
    opts: DirectExecOptions = {},
  ): Promise<DirectStreamResult> {
    const sandboxId = await this.getSandboxId(sandboxName, opts.timeoutMs);
    const execSandbox = method<
      (request: unknown, options?: grpc.CallOptions) => grpc.ClientReadableStream<any>
    >(this.client, "ExecSandbox");
    return collectExecStream(
      execSandbox(execRequest(sandboxId, argv, opts), callOptions(opts.timeoutMs)),
      `ExecSandbox '${sandboxName}'`,
      opts.timeoutMs,
    );
  }

  async execText(
    sandboxName: string,
    argv: string[],
    opts: DirectExecOptions = {},
  ): Promise<DirectTextResult> {
    const result = await this.execBinaryStream(sandboxName, argv, opts);
    return {
      status: result.status,
      stdout: result.stdout.toString("utf-8"),
      stderr: result.stderr.toString("utf-8"),
    };
  }

  async createForwardSessionToken(sandboxId: string, timeoutMs?: number): Promise<string> {
    const response = await callUnary<{ sandbox_id: string }, any>(
      this.client,
      "CreateSshSession",
      { sandbox_id: sandboxId },
      timeoutMs,
    );
    const token = response?.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("OpenShell gateway returned no ForwardTcp authorization token.");
    }
    return token;
  }

  async revokeForwardSessionToken(token: string, timeoutMs?: number): Promise<void> {
    if (!token) return;
    try {
      await callUnary<{ token: string }, unknown>(this.client, "RevokeSshSession", { token }, timeoutMs);
    } catch {
      /* best-effort cleanup */
    }
  }

  async forwardTcpConnection(
    socket: net.Socket,
    params: {
      sandboxName: string;
      sandboxId: string;
      targetHost: string;
      targetPort: number;
      serviceId?: string;
      timeoutMs?: number;
    },
  ): Promise<void> {
    const token = await this.createForwardSessionToken(params.sandboxId, params.timeoutMs);
    const forwardTcp = method<() => grpc.ClientDuplexStream<any, any>>(this.client, "ForwardTcp");
    const stream = forwardTcp();
    let streamEnded = false;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          streamEnded = true;
          socket.off("data", onSocketData);
          socket.off("end", onSocketEnd);
          socket.off("close", onSocketClose);
          socket.off("error", onSocketError);
          stream.off("data", onStreamData);
          stream.off("end", onStreamEnd);
          stream.off("error", onStreamError);
          stream.on("error", () => {
            /* swallow late cancellation after local socket shutdown */
          });
          if (error) reject(error);
          else resolve();
        };
        const onSocketData = (chunk: Buffer) => {
          if (!streamEnded) stream.write({ data: chunk });
        };
        const onSocketEnd = () => {
          streamEnded = true;
          stream.end();
        };
        const onSocketClose = () => {
          if (!streamEnded) {
            try {
              stream.end();
            } catch {
              /* ignore */
            }
          }
          streamEnded = true;
          finish();
        };
        const onSocketError = (error: Error) => {
          streamEnded = true;
          try {
            stream.cancel();
          } catch {
            /* ignore */
          }
          finish(error);
        };
        const onStreamData = (frame: any) => {
          const data = bufferFromData(frame?.data);
          if (data.length > 0 && !socket.destroyed) socket.write(data);
        };
        const onStreamEnd = () => {
          streamEnded = true;
          if (!socket.destroyed) socket.end();
          finish();
        };
        const onStreamError = (error: grpc.ServiceError) => {
          streamEnded = true;
          socket.destroy();
          finish(new Error(`ForwardTcp '${params.sandboxName}' failed: ${formatDirectGrpcError(error)}`));
        };

        socket.on("data", onSocketData);
        socket.on("end", onSocketEnd);
        socket.on("close", onSocketClose);
        socket.on("error", onSocketError);
        stream.on("data", onStreamData);
        stream.on("end", onStreamEnd);
        stream.on("error", onStreamError);

        stream.write({
          init: {
            sandbox_id: params.sandboxId,
            service_id: params.serviceId || "",
            tcp: {
              host: params.targetHost,
              port: params.targetPort,
            },
            authorization_token: token,
          },
        });
      });
    } finally {
      await this.revokeForwardSessionToken(token, params.timeoutMs);
    }
  }

  async startForward(
    sandboxName: string,
    options: {
      localPort: number;
      localHost?: string;
      targetHost?: string;
      targetPort: number;
      serviceId?: string;
      timeoutMs?: number;
    },
  ): Promise<DirectForwardHandle> {
    const localHost = options.localHost || "127.0.0.1";
    const targetHost = options.targetHost || "127.0.0.1";
    const sandboxId = await this.getReadySandboxIdForForward(sandboxName, options.timeoutMs);
    const server = net.createServer((socket) => {
      this.forwardTcpConnection(socket, {
        sandboxName,
        sandboxId,
        targetHost,
        targetPort: options.targetPort,
        serviceId: options.serviceId,
        timeoutMs: options.timeoutMs,
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
    const response = await callUnary<unknown, any>(
      this.client,
      "GetSandboxLogs",
      {
        sandbox_id: sandboxId,
        lines: opts.lines ?? 0,
        since_ms: opts.sinceMs ?? 0,
        sources: opts.sources ?? [],
        min_level: opts.minLevel ?? "",
      },
      opts.timeoutMs,
    ).catch((error) => {
      throw new Error(
        `GetSandboxLogs '${sandboxName}' failed: ${error instanceof Error ? error.message : String(error)}`,
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
        reject(new Error(`WatchSandbox '${sandboxName}' failed: ${formatDirectGrpcError(error)}`));
      });
      stream.on("end", () => resolve());
    });
  }
}

export function __clearDirectGrpcPackageCacheForTests(): void {
  packageDefinition = null;
}

export const __directGrpcTestHooks = {
  protoRoot,
  createCredentials,
  formatDirectGrpcError,
  bufferFromData,
  isReadyPhase,
};
