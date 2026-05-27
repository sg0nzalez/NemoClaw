// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

import { describe, expect, it } from "vitest";

import { __forwardBridgeTestHooks } from "./forward-bridge-state";

async function unusedLocalPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe("OpenShell gRPC forward bridge readiness", () => {
  it("does not treat state-file presence as readiness when the local port is unreachable", async () => {
    const port = await unusedLocalPort();
    expect(__forwardBridgeTestHooks.probeForwardReady("127.0.0.1", port)).toBe(false);
  });
});
