// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import path from "node:path";
import {
  Metadata,
  Server,
  ServerCredentials,
  type CallOptions,
  type sendUnaryData,
  type ServerUnaryCall,
  type ServerWritableStream,
  type ServiceClientConstructor,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadPackageDefinition } from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { describe, expect, it, vi } from "vitest";

import {
  createGrpcOpenShellSandboxControl,
  createOpenShellGrpcApi,
  OpenShellGrpcOutputLimitError,
  OpenShellGrpcPreDispatchError,
  type OpenShellGrpcApi,
} from "./grpc-sandbox-control";

class FakeStream extends EventEmitter {
  cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }
}

interface FakeApiOptions {
  sandboxId?: string;
  getError?: ServiceError;
  emit?: (stream: FakeStream) => void;
}

function fakeApi(fixture: FakeApiOptions = {}): {
  api: OpenShellGrpcApi;
  stream: FakeStream;
  getMetadata: Metadata[];
  execMetadata: Metadata[];
  getOptions: CallOptions[];
  execOptions: CallOptions[];
  close: ReturnType<typeof vi.fn>;
} {
  const stream = new FakeStream();
  const getMetadata: Metadata[] = [];
  const execMetadata: Metadata[] = [];
  const getOptions: CallOptions[] = [];
  const execOptions: CallOptions[] = [];
  const close = vi.fn();
  const api: OpenShellGrpcApi = {
    close,
    getSandbox(request, metadata, options, callback) {
      getMetadata.push(metadata);
      getOptions.push(options);
      queueMicrotask(() => {
        fixture.getError
          ? callback(fixture.getError)
          : callback(null, {
              sandbox: {
                metadata: fixture.sandboxId === "" ? {} : { id: fixture.sandboxId ?? "sb-id" },
              },
            });
      });
      return request;
    },
    execSandbox(request, metadata, options) {
      execMetadata.push(metadata);
      execOptions.push(options);
      queueMicrotask(() => fixture.emit?.(stream));
      return Object.assign(stream, { request });
    },
  };
  return { api, stream, getMetadata, execMetadata, getOptions, execOptions, close };
}

function serviceError(message: string): ServiceError {
  return Object.assign(new Error(message), {
    code: 14,
    details: message,
    metadata: new Metadata(),
  });
}

function bind(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, port) => {
      error ? reject(error) : resolve(port);
    });
  });
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.tryShutdown((error) => {
      error ? reject(error) : resolve();
    });
  });
}

describe("gRPC OpenShell sandbox control", () => {
  it("resolves a sandbox id and normalizes streamed output", async () => {
    const euro = Buffer.from("€");
    const fake = fakeApi({
      emit(stream) {
        stream.emit("data", { stdout: { data: Buffer.from("hello ") } });
        stream.emit("data", { stdout: { data: euro.subarray(0, 1) } });
        stream.emit("data", { stdout: { data: euro.subarray(1) } });
        stream.emit("data", { stderr: { data: Buffer.from("warning\n") } });
        stream.emit("data", { exit: { exitCode: 7 } });
        stream.emit("end");
      },
    });
    const control = createGrpcOpenShellSandboxControl(
      { endpoint: "https://gateway.example:443", bearerToken: "secret-token" },
      fake.api,
    );

    await expect(
      control.exec({
        sandboxName: "alpha",
        command: ["sh", "-lc", "echo hello"],
        stdin: "request body",
      }),
    ).resolves.toEqual({
      status: 7,
      stdout: "hello €",
      stderr: "warning\n",
    });
    expect(fake.getMetadata[0].get("authorization")).toEqual(["Bearer secret-token"]);
    expect(fake.execMetadata[0]).toBe(fake.getMetadata[0]);
    expect((fake.stream as FakeStream & { request: unknown }).request).toEqual({
      sandboxId: "sb-id",
      command: ["sh", "-lc", "echo hello"],
      stdin: Buffer.from("request body"),
    });
    control.close();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("executes against the pinned OpenShell service definition", async () => {
    const protoFile = path.resolve(
      __dirname,
      "../../../../third_party/openshell/v0.0.72/proto/openshell.proto",
    );
    const loaded = loadPackageDefinition(
      protoLoader.loadSync(protoFile, {
        defaults: false,
        includeDirs: [path.dirname(protoFile)],
        keepCase: false,
        oneofs: true,
      }),
    ) as unknown as {
      openshell: { v1: { OpenShell: ServiceClientConstructor } };
    };
    const server = new Server();
    const requests: unknown[] = [];
    server.addService(loaded.openshell.v1.OpenShell.service, {
      getSandbox(
        call: ServerUnaryCall<{ name: string }, { sandbox: { metadata: { id: string } } }>,
        callback: sendUnaryData<{ sandbox: { metadata: { id: string } } }>,
      ) {
        requests.push(call.request);
        callback(null, { sandbox: { metadata: { id: "wire-id" } } });
      },
      execSandbox(
        call: ServerWritableStream<
          { sandboxId: string; command: string[]; stdin?: Buffer },
          {
            stdout?: { data: Buffer };
            stderr?: { data: Buffer };
            exit?: { exitCode: number };
          }
        >,
      ) {
        requests.push(call.request);
        call.write({ stdout: { data: Buffer.from("wire stdout") } });
        call.write({ stderr: { data: Buffer.from("wire stderr") } });
        call.write({ exit: { exitCode: 0 } });
        call.end();
      },
    });
    const port = await bind(server);
    const control = createGrpcOpenShellSandboxControl({
      endpoint: `http://127.0.0.1:${port}`,
    });
    try {
      await expect(
        control.exec({
          sandboxName: "alpha",
          command: ["cat"],
          stdin: Buffer.from([0, 255, 10]),
        }),
      ).resolves.toEqual({
        status: 0,
        stdout: "wire stdout",
        stderr: "wire stderr",
      });
      expect(requests).toEqual([
        { name: "alpha" },
        { sandboxId: "wire-id", command: ["cat"], stdin: Buffer.from([0, 255, 10]) },
      ]);
    } finally {
      control.close();
      await shutdown(server);
    }
  });

  it("returns lookup failures without starting exec", async () => {
    const error = serviceError("gateway unavailable");
    const fake = fakeApi({ getError: error });
    const control = createGrpcOpenShellSandboxControl(
      { endpoint: "http://127.0.0.1:8080" },
      fake.api,
    );

    await expect(control.exec({ sandboxName: "alpha", command: ["true"] })).resolves.toEqual({
      status: null,
      stdout: "",
      stderr: "",
      error: expect.objectContaining({
        cause: error,
        name: OpenShellGrpcPreDispatchError.name,
      }),
    });
    expect(fake.execMetadata).toEqual([]);
  });

  it("uses one deadline for lookup and exec and forwards the command timeout", async () => {
    const fake = fakeApi({
      emit(stream) {
        stream.emit("data", { exit: { exitCode: 0 } });
        stream.emit("end");
      },
    });
    const control = createGrpcOpenShellSandboxControl(
      { endpoint: "http://127.0.0.1:8080" },
      fake.api,
    );
    const before = Date.now();

    await control.exec({ sandboxName: "alpha", command: ["true"], timeoutMs: 1500 });

    expect(fake.getOptions[0].deadline).toBeInstanceOf(Date);
    expect(fake.execOptions[0].deadline).toBe(fake.getOptions[0].deadline);
    expect((fake.getOptions[0].deadline as Date).getTime()).toBeGreaterThanOrEqual(before + 1500);
    expect((fake.stream as FakeStream & { request: unknown }).request).toEqual({
      sandboxId: "sb-id",
      command: ["true"],
      timeoutSeconds: 2,
    });
  });

  it("rejects sandbox responses without a stable id", async () => {
    const fake = fakeApi({ sandboxId: "" });
    const control = createGrpcOpenShellSandboxControl(
      { endpoint: "http://localhost:8080" },
      fake.api,
    );

    const result = await control.exec({
      sandboxName: "alpha",
      command: ["true"],
    });

    expect(result).toEqual({
      status: null,
      stdout: "",
      stderr: "",
      error: expect.objectContaining({
        message: "OpenShell returned sandbox 'alpha' without an id",
      }),
    });
  });

  it.each([
    [{ maxOutputBytes: -1 }, "maxOutputBytes"],
    [{ timeoutMs: 1.5 }, "timeoutMs"],
  ])("rejects invalid execution limits before gateway lookup", async (limits, field) => {
    const fake = fakeApi();
    const control = createGrpcOpenShellSandboxControl(
      { endpoint: "http://127.0.0.1:8080" },
      fake.api,
    );

    const result = await control.exec({ sandboxName: "alpha", command: ["true"], ...limits });

    expect(result.error?.message).toContain(field);
    expect(fake.getMetadata).toEqual([]);
  });

  it("caps combined output, cancels the stream, and returns ENOBUFS-compatible context", async () => {
    const fake = fakeApi({
      emit(stream) {
        stream.emit("data", { stdout: { data: Buffer.from("abcdef") } });
      },
    });
    const control = createGrpcOpenShellSandboxControl({ endpoint: "http://[::1]:8080" }, fake.api);

    const result = await control.exec({
      sandboxName: "alpha",
      command: ["cat", "large-file"],
      maxOutputBytes: 4,
    });

    expect(result).toEqual({
      status: null,
      stdout: "abcd",
      stderr: "",
      error: expect.any(OpenShellGrpcOutputLimitError),
    });
    expect((result.error as NodeJS.ErrnoException).code).toBe("ENOBUFS");
    expect(fake.stream.cancelled).toBe(true);
  });

  it("preserves partial output when the stream fails", async () => {
    const error = serviceError("relay reset");
    const fake = fakeApi({
      emit(stream) {
        stream.emit("data", { stdout: { data: Buffer.from("partial") } });
        stream.emit("error", error);
      },
    });
    const control = createGrpcOpenShellSandboxControl(
      { endpoint: "http://127.0.0.1:8080" },
      fake.api,
    );

    await expect(control.exec({ sandboxName: "alpha", command: ["true"] })).resolves.toEqual({
      status: null,
      stdout: "partial",
      stderr: "",
      error,
    });
  });

  it("fails closed when the stream ends without an exit event", async () => {
    const fake = fakeApi({ emit: (stream) => stream.emit("end") });
    const control = createGrpcOpenShellSandboxControl(
      { endpoint: "http://127.0.0.1:8080" },
      fake.api,
    );

    const result = await control.exec({
      sandboxName: "alpha",
      command: ["true"],
    });

    expect(result.error?.message).toBe("OpenShell gRPC exec stream ended without an exit status");
  });

  it.each([
    ["ftp://localhost:8080", "must use http:// or https://"],
    ["http://gateway.example:8080", "restricted to loopback"],
    ["http://localhost:8080/path", "must not contain"],
  ])("rejects unsafe endpoint %s", (endpoint, message) => {
    expect(() => createOpenShellGrpcApi({ endpoint })).toThrow(message);
  });

  it("rejects bearer tokens or TLS material on plaintext endpoints", () => {
    expect(() =>
      createOpenShellGrpcApi({
        endpoint: "http://localhost:8080",
        bearerToken: "token",
      }),
    ).toThrow("requires TLS");
    expect(() =>
      createOpenShellGrpcApi({
        endpoint: "http://localhost:8080",
        caCertificate: Buffer.from("ca"),
      }),
    ).toThrow("require an https:// endpoint");
  });

  it("rejects incomplete mTLS credentials", () => {
    expect(() =>
      createOpenShellGrpcApi({
        endpoint: "https://gateway.example:443",
        clientCertificate: Buffer.from("cert"),
      }),
    ).toThrow("clientCertificate and clientKey must be provided together");
  });
});
