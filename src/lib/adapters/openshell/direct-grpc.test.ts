// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";
import path from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";

import { __directGrpcTestHooks, OpenShellDirectGrpcClient } from "./direct-grpc";

function unusedLocalPort(): Promise<number> {
  const server = net.createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

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

function readOne(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(Buffer.from(chunk)));
    socket.once("error", reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("OpenShell raw gRPC adapter", () => {
  it("backs a local TCP forward with OpenShell ForwardTcp frames", async () => {
    const service = loadOpenShellService();
    const server = new grpc.Server();
    const frames: any[] = [];
    const revoked: string[] = [];
    server.addService(service, {
      GetSandbox: (_call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
        callback(null, {
          sandbox: {
            metadata: { id: "sandbox-123", name: "alpha" },
            phase: "SANDBOX_PHASE_READY",
          },
        });
      },
      CreateSshSession: (_call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
        callback(null, { sandbox_id: "sandbox-123", token: "forward-token" });
      },
      RevokeSshSession: (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
        revoked.push(String(call.request.token));
        callback(null, { revoked: true });
      },
      ExecSandbox: (call: grpc.ServerWritableStream<any, any>) => {
        frames.push({ exec: call.request });
        call.write({ stdout: { data: Buffer.from("exec-out") } });
        call.write({ stderr: { data: Buffer.from("exec-err") } });
        call.write({ exit: { exit_code: 7 } });
        call.end();
      },
      ForwardTcp: (call: grpc.ServerDuplexStream<any, any>) => {
        call.on("data", (frame) => {
          frames.push(frame);
          if (frame.data) call.write({ data: frame.data });
        });
        call.on("end", () => call.end());
      },
    });

    const gatewayPort = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    const localPort = await unusedLocalPort();
    const client = new OpenShellDirectGrpcClient({
      gatewayEndpoint: `http://127.0.0.1:${gatewayPort}`,
    });

    try {
      const exec = await client.execText("alpha", ["sh", "-c", "printf hi"], {
        workdir: "/sandbox",
        env: { A: "1" },
        timeoutMs: 1_000,
      });
      expect(exec).toEqual({ status: 7, stdout: "exec-out", stderr: "exec-err" });

      const handle = await client.startForward("alpha", {
        localHost: "127.0.0.1",
        localPort,
        targetHost: "127.0.0.1",
        targetPort: 8642,
        serviceId: "nemoclaw-dashboard-8642",
      });
      try {
        const socket = net.createConnection({ host: "127.0.0.1", port: localPort });
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        socket.write(Buffer.from("ping"));
        expect((await readOne(socket)).toString("utf-8")).toBe("ping");
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        socket.end();
        await closed;
        await waitFor(() => revoked.includes("forward-token"));
      } finally {
        await handle.close();
      }

      expect(frames[0]).toMatchObject({
        exec: {
          sandbox_id: "sandbox-123",
          command: ["sh", "-c", "printf hi"],
          workdir: "/sandbox",
          environment: { A: "1" },
          timeout_seconds: 1,
        },
      });
      expect(frames[1]).toMatchObject({
        init: {
          sandbox_id: "sandbox-123",
          service_id: "nemoclaw-dashboard-8642",
          authorization_token: "forward-token",
          tcp: { host: "127.0.0.1", port: 8642 },
        },
      });
      expect(frames.some((frame) => Buffer.isBuffer(frame.data) && frame.data.toString("utf-8") === "ping")).toBe(
        true,
      );
      expect(revoked).toContain("forward-token");
    } finally {
      client.close();
      server.forceShutdown();
    }
  });
});
