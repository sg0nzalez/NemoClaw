// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { describe, expect, it, vi } from "vitest";

vi.mock("@openshell/sdk", () => ({
  OpenShellClient: { connect: vi.fn() },
}));

import { __directGrpcTestHooks } from "./direct-grpc";
import {
  __clearSandboxSdkClientCacheForTests,
  __grpcTestHooks,
  createSandboxGrpcClient,
  execBinaryStreamSync,
} from "./grpc";

function loadOpenShellService(): grpc.ServiceDefinition {
  const protoRoot = __directGrpcTestHooks.protoRoot();
  const definition = protoLoader.loadSync(path.join(protoRoot, "openshell.proto"), {
    defaults: false,
    enums: String,
    includeDirs: [protoRoot],
    keepCase: true,
    longs: String,
    oneofs: true,
    bytes: Buffer,
  });
  const loaded = grpc.loadPackageDefinition(definition) as any;
  return loaded.openshell.v1.OpenShell.service as grpc.ServiceDefinition;
}

describe("OpenShell SDK adapter", () => {
  it("maps NemoClaw exec options to SDK exec options", () => {
    const opts = __grpcTestHooks.toSdkExecOptions({
      workdir: "/sandbox/workspace",
      env: { A: "1" },
      timeoutMs: 1500,
      stdin: "hello",
    });

    expect(opts.workdir).toBe("/sandbox/workspace");
    expect(opts.environment).toEqual({ A: "1" });
    expect(opts.timeoutSecs).toBe(2);
    expect(opts.stdin?.toString("utf-8")).toBe("hello");
  });

  it("normalizes SDK exec results into NemoClaw's binary result shape", () => {
    const result = __grpcTestHooks.sdkResultToStream({
      exitCode: 42,
      stdout: Buffer.from("out"),
      stderr: Buffer.from("err"),
    });

    expect(result).toEqual({
      status: 42,
      stdout: Buffer.from("out"),
      stderr: Buffer.from("err"),
    });
  });

  it("formats SDK error-code prefixes without exposing raw binding noise", () => {
    expect(__grpcTestHooks.formatSdkError(new Error("[not_found] sandbox missing"))).toBe(
      "not_found: sandbox missing",
    );
    expect(__grpcTestHooks.formatSdkError(new Error("plain failure"))).toBe("plain failure");
  });

  it("falls back to raw ExecSandbox when the SDK package is still the placeholder", async () => {
    const { OpenShellClient } = await import("@openshell/sdk");
    vi.mocked(OpenShellClient.connect).mockRejectedValueOnce(
      new Error("@openshell/sdk is not published yet"),
    );
    __clearSandboxSdkClientCacheForTests();

    const server = new grpc.Server();
    server.addService(loadOpenShellService(), {
      GetSandbox: (_call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
        callback(null, {
          sandbox: {
            metadata: { id: "sandbox-123", name: "alpha" },
            phase: "SANDBOX_PHASE_READY",
          },
        });
      },
      ExecSandbox: (call: grpc.ServerWritableStream<any, any>) => {
        expect(call.request).toMatchObject({
          sandbox_id: "sandbox-123",
          command: ["sh", "-c", "printf ok"],
          timeout_seconds: 1,
        });
        call.write({ stdout: { data: Buffer.from("ok") } });
        call.write({ exit: { exit_code: 0 } });
        call.end();
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
        if (error) reject(error);
        else resolve(boundPort);
      });
    });
    const client = createSandboxGrpcClient({ gatewayEndpoint: `http://127.0.0.1:${port}` });
    try {
      await expect(client.execText("alpha", ["sh", "-c", "printf ok"], { timeoutMs: 1_000 })).resolves.toEqual({
        status: 0,
        stdout: "ok",
        stderr: "",
      });
    } finally {
      client.close();
      server.forceShutdown();
    }
  });

  it("preserves large sync-runner binary stdout through the fake SDK runner", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-large-stdout-"));
    const oldEnv = {
      transport: process.env.NEMOCLAW_SDK_TEST_TRANSPORT,
      fakeExec: process.env.NEMOCLAW_SDK_TEST_FAKE_EXEC_BIN,
    };
    try {
      const fakeExec = path.join(fixture, "sdk-fake-exec.cjs");
      fs.writeFileSync(
        fakeExec,
        `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  status: 0,
  stdoutBase64: Buffer.alloc(2 * 1024 * 1024, 0x61).toString("base64"),
  stderrBase64: ""
}));
`,
        { mode: 0o755 },
      );
      process.env.NEMOCLAW_SDK_TEST_TRANSPORT = "1";
      process.env.NEMOCLAW_SDK_TEST_FAKE_EXEC_BIN = fakeExec;

      const result = execBinaryStreamSync("alpha", ["cat", "/tmp/large"], { timeoutMs: 15_000 });
      expect(result.status).toBe(0);
      expect(result.stdout.length).toBe(2 * 1024 * 1024);
    } finally {
      if (oldEnv.transport === undefined) delete process.env.NEMOCLAW_SDK_TEST_TRANSPORT;
      else process.env.NEMOCLAW_SDK_TEST_TRANSPORT = oldEnv.transport;
      if (oldEnv.fakeExec === undefined) delete process.env.NEMOCLAW_SDK_TEST_FAKE_EXEC_BIN;
      else process.env.NEMOCLAW_SDK_TEST_FAKE_EXEC_BIN = oldEnv.fakeExec;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
