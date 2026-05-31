// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createSandboxGrpcClient } from "./grpc";
import { writeForwardState } from "./forward-bridge-state";

type RunnerArgs = {
  sandboxName: string;
  bind: string;
  port: number;
  targetHost: string;
  targetPort: number;
};

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error("missing forward bridge args");
  const args = JSON.parse(raw) as RunnerArgs;
  const client = createSandboxGrpcClient();
  const handle = await client.startForward(args.sandboxName, {
    localHost: args.bind,
    localPort: args.port,
    targetHost: args.targetHost,
    targetPort: args.targetPort,
    serviceId: `nemoclaw-dashboard-${args.port}`,
  });

  writeForwardState({
    sandboxName: args.sandboxName,
    bind: args.bind,
    port: args.port,
    targetHost: args.targetHost,
    targetPort: args.targetPort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const close = async () => {
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
    client.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
