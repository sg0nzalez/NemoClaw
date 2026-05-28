// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createSandboxGrpcClient, type SandboxExecOptions } from "./grpc";

type SyncRequest = {
  op: "execText" | "execBinary" | "execInput";
  sandboxName: string;
  argv: string[];
  inputBase64?: string;
  opts?: SandboxExecOptions;
};

type FakeExecResponse = {
  status: number;
  stdoutBase64?: string;
  stderrBase64?: string;
  stdout?: string;
  stderr?: string;
};

function readRequest(): SyncRequest {
  const raw = fs.readFileSync(0, "utf-8");
  return JSON.parse(raw) as SyncRequest;
}

function fakeSdkExecCommand(): { command: string; args: string[] } {
  const helper = process.env.NEMOCLAW_SDK_TEST_FAKE_EXEC_BIN;
  if (!helper) {
    throw new Error("NEMOCLAW_SDK_TEST_FAKE_EXEC_BIN is required when NEMOCLAW_SDK_TEST_TRANSPORT=1");
  }
  if (/\.(?:c|m)?js$/i.test(helper)) return { command: process.execPath, args: [helper] };
  return { command: helper, args: [] };
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function legacyRemoteCommand(argv: readonly string[], input: Buffer): string {
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

function runLegacyRemoteFakeExec(
  command: string,
  args: string[],
  request: SyncRequest,
  input: Buffer,
): FakeExecResponse {
  const result = spawnSync(command, [...args, `openshell-${request.sandboxName}`, legacyRemoteCommand(request.argv, input)], {
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout:
      request.opts?.timeoutMs && request.opts.timeoutMs > 0
        ? request.opts.timeoutMs + 5_000
        : undefined,
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdoutBase64: Buffer.from(result.stdout || "").toString("base64"),
    stderrBase64: Buffer.from(result.stderr || "").toString("base64"),
  };
}

function runFakeSdkExec(request: SyncRequest, input: Buffer): FakeExecResponse {
  const { command, args } = fakeSdkExecCommand();
  if (path.basename(args[0] ?? command) === "ssh") {
    return runLegacyRemoteFakeExec(command, args, request, input);
  }
  const result = spawnSync(command, args, {
    input: JSON.stringify({
      sandboxName: request.sandboxName,
      argv: request.argv,
      inputBase64: input.toString("base64"),
      opts: request.opts ?? {},
    }),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout:
      request.opts?.timeoutMs && request.opts.timeoutMs > 0
        ? request.opts.timeoutMs + 5_000
        : undefined,
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `fake SDK exec exited ${result.status}`).trim());
  }
  return JSON.parse(result.stdout) as FakeExecResponse;
}

function writeTextResult(result: FakeExecResponse): void {
  const stdout =
    result.stdout ??
    Buffer.from(result.stdoutBase64 || "", "base64").toString("utf-8");
  const stderr =
    result.stderr ??
    Buffer.from(result.stderrBase64 || "", "base64").toString("utf-8");
  process.stdout.write(
    JSON.stringify({
      ok: true,
      result: { status: result.status, stdout, stderr },
    }),
  );
}

function writeBinaryResult(result: FakeExecResponse): void {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      result: {
        status: result.status,
        stdoutBase64:
          result.stdoutBase64 ?? Buffer.from(result.stdout || "", "utf-8").toString("base64"),
        stderrBase64:
          result.stderrBase64 ?? Buffer.from(result.stderr || "", "utf-8").toString("base64"),
      },
    }),
  );
}

async function main(): Promise<void> {
  const request = readRequest();
  const input =
    request.op === "execInput"
      ? Buffer.from(request.inputBase64 || "", "base64")
      : Buffer.alloc(0);

  if (process.env.NEMOCLAW_SDK_TEST_TRANSPORT === "1") {
    const result = runFakeSdkExec(request, input);
    if (request.op === "execText") writeTextResult(result);
    else writeBinaryResult(result);
    return;
  }

  const client = createSandboxGrpcClient();
  if (request.op === "execText") {
    const result = await client.execText(request.sandboxName, request.argv, request.opts ?? {});
    process.stdout.write(JSON.stringify({ ok: true, result }));
    return;
  }
  if (request.op === "execBinary") {
    const result = await client.execBinary(request.sandboxName, request.argv, request.opts ?? {});
    writeBinaryResult({
      status: result.status,
      stdoutBase64: result.stdout.toString("base64"),
      stderrBase64: result.stderr.toString("base64"),
    });
    return;
  }
  const result = await client.execInputStream(
    request.sandboxName,
    request.argv,
    input,
    request.opts ?? {},
  );
  writeBinaryResult({
    status: result.status,
    stdoutBase64: result.stdout.toString("base64"),
    stderrBase64: result.stderr.toString("base64"),
  });
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
