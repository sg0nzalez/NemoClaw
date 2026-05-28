// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  __forwardBridgeTestHooks,
  stopForwardBridge,
  writeForwardState,
} from "./forward-bridge-state";

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

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not become ready")), 2_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function canListen(port: number): Promise<boolean> {
  const server = net.createServer();
  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

describe("OpenShell SDK forward bridge readiness", () => {
  it("does not treat state-file presence as readiness when the local port is unreachable", async () => {
    const port = await unusedLocalPort();
    expect(__forwardBridgeTestHooks.probeForwardReady("127.0.0.1", port)).toBe(false);
  });

  it("treats local TCP reachability as bridge readiness without requiring dashboard HTTP", async () => {
    const port = await unusedLocalPort();
    const server = net.createServer((socket) => socket.end("not-http"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    try {
      expect(__forwardBridgeTestHooks.probeForwardReady("127.0.0.1", port)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("waits for a stopped bridge process to release its local port", async () => {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forward-stop-"));
    process.env.HOME = home;
    const port = await unusedLocalPort();
    const child = spawn(process.execPath, [
      "-e",
      [
        "const net=require('node:net');",
        `const srv=net.createServer((socket)=>socket.end('ok')).listen(${port}, '127.0.0.1', () => console.log('ready'));`,
        "setInterval(()=>{}, 1000);",
      ].join(""),
    ]);
    try {
      await waitForReady(child);
      expect(await canListen(port)).toBe(false);
      writeForwardState({
        sandboxName: "alpha",
        bind: "127.0.0.1",
        port,
        targetHost: "127.0.0.1",
        targetPort: 8642,
        pid: child.pid ?? -1,
        startedAt: new Date().toISOString(),
      });

      expect(stopForwardBridge("alpha", port)).toBe(true);
      expect(await canListen(port)).toBe(true);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
