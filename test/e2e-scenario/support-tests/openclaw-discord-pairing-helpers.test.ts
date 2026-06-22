// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPairingApproveCommand,
  buildPairingPendingCommand,
} from "../live/openclaw-pairing-helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGTERM");
  child = undefined;
});

function encodeClientText(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
}

async function waitForPort(portFile: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return Number(fs.readFileSync(portFile, "utf8").trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("fake Discord Gateway did not write a port file");
}

async function sendDiscordIdentify(port: number, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for fake Discord Gateway"));
    }, 5_000);
    let buffer = Buffer.alloc(0);

    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        [
          "GET /gateway?v=10&encoding=json HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      buffer.toString("latin1").includes("\r\n\r\n")
        ? (() => {
            socket.write(
              encodeClientText(
                JSON.stringify({
                  op: 2,
                  d: {
                    token,
                    intents: 0,
                    properties: { os: "linux", browser: "test", device: "test" },
                  },
                }),
              ),
            );
            clearTimeout(timer);
            socket.end();
            resolve();
          })()
        : undefined;
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("OpenClaw Discord pairing helper contracts", () => {
  it("shell-quotes pairing code and user without command substitution", () => {
    const code = "abc$(touch /tmp/e2e-should-not-run)";
    const user = "user`touch /tmp/e2e-should-not-run`";

    const pendingCommand = buildPairingPendingCommand("discord", code, user);
    const approveCommand = buildPairingApproveCommand("discord", code);

    expect(pendingCommand).toContain("'abc$(touch /tmp/e2e-should-not-run)'");
    expect(pendingCommand).toContain("'user`touch /tmp/e2e-should-not-run`'");
    expect(approveCommand).toContain("'abc$(touch /tmp/e2e-should-not-run)'");
    expect(pendingCommand).not.toContain('"abc$(touch /tmp/e2e-should-not-run)"');
    expect(approveCommand).not.toContain('"abc$(touch /tmp/e2e-should-not-run)"');
  });

  it("fake Discord Gateway capture omits raw identify token while preserving rewrite booleans", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-discord-gateway-"));
    const captureFile = path.join(tmp, "capture.jsonl");
    const portFile = path.join(tmp, "port");
    const sentinel = "test-sentinel-discord-token";
    try {
      child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, "test/e2e/lib/fake-discord-gateway.cjs")],
        {
          env: {
            ...process.env,
            FAKE_DISCORD_GATEWAY_HOST: "127.0.0.1",
            FAKE_DISCORD_GATEWAY_PORT: "0",
            FAKE_DISCORD_GATEWAY_PORT_FILE: portFile,
            FAKE_DISCORD_GATEWAY_CAPTURE_FILE: captureFile,
            FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: sentinel,
          },
          stdio: "ignore",
        },
      );
      const port = await waitForPort(portFile);
      await sendDiscordIdentify(port, sentinel);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const serialized = fs.readFileSync(captureFile, "utf8");
      const identify = serialized
        .trim()
        .split(/\n+/)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.event === "identify");

      expect(serialized).not.toContain(sentinel);
      expect(identify).not.toHaveProperty("token");
      expect(identify?.tokenMatchesExpected).toBe(true);
      expect(identify?.tokenLooksPlaceholder).toBe(false);
    } finally {
      child?.kill("SIGTERM");
      child = undefined;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
