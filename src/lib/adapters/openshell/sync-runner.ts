// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { createSandboxGrpcClient, type SandboxExecOptions } from "./grpc";

type SyncRequest = {
  op: "execText" | "execBinary" | "execInput";
  sandboxName: string;
  argv: string[];
  inputBase64?: string;
  opts?: SandboxExecOptions;
};

function readRequest(): SyncRequest {
  const raw = fs.readFileSync(0, "utf-8");
  return JSON.parse(raw) as SyncRequest;
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function legacyFakeRemoteCommand(argv: readonly string[], input: Buffer = Buffer.alloc(0)): string {
  if (
    input.length > 0 &&
    (argv[0] === "sh" || argv[0] === "bash") &&
    (argv[1] === "-s" || argv[1] === "-")
  ) {
    return input.toString("utf-8");
  }
  if ((argv[0] === "sh" || argv[0] === "bash") && (argv[1] === "-c" || argv[1] === "-lc")) {
    return argv[2] ?? "";
  }
  return argv.map(shellQuoteArg).join(" ");
}

function runLegacyFakeSshTransport(
  request: SyncRequest,
  input: Buffer = Buffer.alloc(0),
): { status: number; stdout: Buffer; stderr: Buffer } {
  if (
    process.env.NEMOCLAW_GRPC_TEST_TRANSPORT !== "1" ||
    process.env.NEMOCLAW_GRPC_TEST_LEGACY_FAKE_SSH !== "1"
  ) {
    throw new Error("legacy fake transport is not enabled");
  }

  const sshBin = process.env.NEMOCLAW_GRPC_TEST_FAKE_SSH_BIN || "ssh";
  const remoteCommand = legacyFakeRemoteCommand(request.argv, input);
  const helperArgs = [`openshell-${request.sandboxName}`, remoteCommand];
  const helperCommand = /\.(?:c|m)?js$/i.test(sshBin) ? process.execPath : sshBin;
  const helperArgv = helperCommand === process.execPath ? [sshBin, ...helperArgs] : helperArgs;
  const result = spawnSync(helperCommand, helperArgv, {
    input,
    timeout:
      request.opts?.timeoutMs && request.opts.timeoutMs > 0
        ? request.opts.timeoutMs + 5_000
        : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || ""),
  };
}

async function main(): Promise<void> {
  const request = readRequest();
  if (process.env.NEMOCLAW_GRPC_TEST_TRANSPORT === "1") {
    const input =
      request.op === "execInput"
        ? Buffer.from(request.inputBase64 || "", "base64")
        : Buffer.alloc(0);
    const result = runLegacyFakeSshTransport(request, input);
    if (request.op === "execText") {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          result: {
            status: result.status,
            stdout: result.stdout.toString("utf-8"),
            stderr: result.stderr.toString("utf-8"),
          },
        }),
      );
      return;
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        result: {
          status: result.status,
          stdoutBase64: result.stdout.toString("base64"),
          stderrBase64: result.stderr.toString("base64"),
        },
      }),
    );
    return;
  }

  const client = createSandboxGrpcClient();
  try {
    if (request.op === "execText") {
      const result = await client.execText(request.sandboxName, request.argv, request.opts ?? {});
      process.stdout.write(JSON.stringify({ ok: true, result }));
      return;
    }
    if (request.op === "execBinary") {
      const result = await client.execBinaryStream(request.sandboxName, request.argv, request.opts ?? {});
      process.stdout.write(
        JSON.stringify({
          ok: true,
          result: {
            status: result.status,
            stdoutBase64: result.stdout.toString("base64"),
            stderrBase64: result.stderr.toString("base64"),
          },
        }),
      );
      return;
    }
    const input = Buffer.from(request.inputBase64 || "", "base64");
    const result = await client.execInputStream(request.sandboxName, request.argv, input, request.opts ?? {});
    process.stdout.write(
      JSON.stringify({
        ok: true,
        result: {
          status: result.status,
          stdoutBase64: result.stdout.toString("base64"),
          stderrBase64: result.stderr.toString("base64"),
        },
      }),
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(0);
});
