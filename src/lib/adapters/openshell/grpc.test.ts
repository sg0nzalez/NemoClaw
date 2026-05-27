// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { __grpcTestHooks } from "./grpc";

function collect(events: unknown[]) {
  const stream = new EventEmitter() as EventEmitter & { cancel: () => void };
  stream.cancel = () => undefined;
  const result = __grpcTestHooks.collectExecStream(stream as any, "test exec", 0);
  queueMicrotask(() => {
    for (const event of events) stream.emit("data", event);
    stream.emit("end");
  });
  return result;
}

describe("OpenShell gRPC exec stream parsing", () => {
  it("parses keepCase exit_code events", async () => {
    await expect(
      collect([
        { stdout: { data: Buffer.from("ok\n") } },
        { exit: { exit_code: 0 } },
      ]),
    ).resolves.toMatchObject({
      status: 0,
      stdout: Buffer.from("ok\n"),
    });
  });

  it("parses camelCase exitCode events", async () => {
    await expect(
      collect([
        { stderr: { data: Buffer.from("boom\n") } },
        { exit: { exitCode: 42 } },
      ]),
    ).resolves.toMatchObject({
      status: 42,
      stderr: Buffer.from("boom\n"),
    });
  });

  it("keeps missing exit events non-successful so call sites must prove completion", async () => {
    await expect(collect([{ stdout: { data: Buffer.from("partial") } }])).resolves.toMatchObject({
      status: 1,
      stdout: Buffer.from("partial"),
    });
  });
});
