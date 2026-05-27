// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepMs } from "../../core/wait";

export interface SandboxForwardState {
  sandboxName: string;
  bind: string;
  port: number;
  targetHost: string;
  targetPort: number;
  pid: number;
  startedAt: string;
}

export interface ForwardBridgeStartOptions {
  bind?: string;
  port: number;
  targetHost?: string;
  targetPort: number;
  timeoutMs?: number;
}

export interface ForwardBridgeStartResult {
  ok: boolean;
  state?: SandboxForwardState;
  diagnostic: string;
}

function stateDir(): string {
  return path.join(process.env.HOME || os.homedir(), ".nemoclaw", "forwards");
}

function statePath(sandboxName: string, port: number | string): string {
  const safeSandbox = sandboxName.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(stateDir(), `${safeSandbox}-${String(port)}.json`);
}

function ensureStateDir(): void {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

export function writeForwardState(state: SandboxForwardState): void {
  ensureStateDir();
  fs.writeFileSync(statePath(state.sandboxName, state.port), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

export function removeForwardState(sandboxName: string, port: number | string): void {
  try {
    fs.unlinkSync(statePath(sandboxName, port));
  } catch {
    /* ignore */
  }
}

function readStateFile(filePath: string): SandboxForwardState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as SandboxForwardState;
    if (
      typeof parsed.sandboxName === "string" &&
      typeof parsed.bind === "string" &&
      Number.isInteger(parsed.port) &&
      typeof parsed.targetHost === "string" &&
      Number.isInteger(parsed.targetPort) &&
      Number.isInteger(parsed.pid)
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function listForwardStates(): SandboxForwardState[] {
  try {
    return fs
      .readdirSync(stateDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readStateFile(path.join(stateDir(), entry.name)))
      .filter((entry): entry is SandboxForwardState => entry !== null)
      .filter((entry) => isPidAlive(entry.pid));
  } catch {
    return [];
  }
}

export function getForwardState(sandboxName: string, port: number | string): SandboxForwardState | null {
  const state = readStateFile(statePath(sandboxName, port));
  return state && isPidAlive(state.pid) ? state : null;
}

export function isPidAlive(pid: number): boolean {
  if (isTestForwardPid(pid)) return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function stopForwardBridge(sandboxName: string, port: number | string): boolean {
  const state = readStateFile(statePath(sandboxName, port));
  if (state && isPidAlive(state.pid) && !isTestForwardPid(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  removeForwardState(sandboxName, port);
  return Boolean(state);
}

export function stopAllForwardBridges(): void {
  for (const state of listForwardStates()) {
    stopForwardBridge(state.sandboxName, state.port);
  }
}

export function forwardStatesAsListOutput(states = listForwardStates()): string {
  const lines = ["SANDBOX BIND PORT PID STATUS"];
  for (const state of states) {
    lines.push(`${state.sandboxName} ${state.bind} ${state.port} ${state.pid} running`);
  }
  return `${lines.join("\n")}\n`;
}

function runnerCommand(): { command: string; args: string[] } {
  const built = path.join(__dirname, "forward-bridge-runner.js");
  if (fs.existsSync(built)) return { command: process.execPath, args: [built] };

  const source = path.join(__dirname, "forward-bridge-runner.ts");
  const root = path.resolve(__dirname, "..", "..", "..", "..");
  const tsxBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (fs.existsSync(source) && fs.existsSync(tsxBin)) return { command: tsxBin, args: [source] };

  throw new Error("OpenShell gRPC forward bridge runner is not available. Run `npm run build:cli` first.");
}

function useTestForwardBridge(): boolean {
  return process.env.NEMOCLAW_GRPC_TEST_TRANSPORT === "1" || process.env.VITEST_WORKER_ID !== undefined;
}

function testForwardPid(): number {
  return 0;
}

function isTestForwardPid(pid: number): boolean {
  return useTestForwardBridge() && pid === testForwardPid();
}

function readOpenFileDescriptor(fd: number): string {
  const stat = fs.fstatSync(fd);
  if (stat.size <= 0) return "";
  const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
  return buffer.subarray(0, bytesRead).toString("utf-8");
}

function probeForwardReady(bind: string, port: number): boolean {
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const script =
    "const net=require('node:net');" +
    `const socket=net.createConnection({host:${JSON.stringify(host)},port:${port}});` +
    "let data='';let done=false;" +
    "const finish=(code)=>{if(done)return;done=true;socket.destroy();process.exit(code);};" +
    "socket.setTimeout(1000);" +
    "socket.on('connect',()=>socket.write('GET /health HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n'));" +
    "socket.on('data',(chunk)=>{data+=chunk.toString('utf8');if(/^HTTP\\//.test(data))finish(0);});" +
    "socket.on('error',()=>finish(1));" +
    "socket.on('timeout',()=>finish(1));" +
    "socket.on('end',()=>finish(/^HTTP\\//.test(data)?0:1));";
  const result = spawnSync(process.execPath, ["-e", script], {
    stdio: "ignore",
    timeout: 1500,
  });
  return result.status === 0;
}

export function startForwardBridgeDetached(
  sandboxName: string,
  options: ForwardBridgeStartOptions,
): ForwardBridgeStartResult {
  const bind = options.bind || "127.0.0.1";
  const targetHost = options.targetHost || "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? 30_000;
  stopForwardBridge(sandboxName, options.port);
  if (useTestForwardBridge()) {
    const state: SandboxForwardState = {
      sandboxName,
      bind,
      port: options.port,
      targetHost,
      targetPort: options.targetPort,
      pid: testForwardPid(),
      startedAt: new Date().toISOString(),
    };
    writeForwardState(state);
    return { ok: true, state, diagnostic: "" };
  }
  const { command, args } = runnerCommand();
  ensureStateDir();
  const safeSandbox = sandboxName.replace(/[^A-Za-z0-9._-]/g, "_");
  const diagnosticDir = fs.mkdtempSync(path.join(stateDir(), `${safeSandbox}-${options.port}-`));
  const diagnosticPath = path.join(
    diagnosticDir,
    "bridge.log",
  );
  const out = fs.openSync(diagnosticPath, "w+", 0o600);
  const child = spawn(
    command,
    [
      ...args,
      JSON.stringify({
        sandboxName,
        bind,
        port: options.port,
        targetHost,
        targetPort: options.targetPort,
      }),
    ],
    { detached: true, stdio: ["ignore", out, out], env: process.env },
  );
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getForwardState(sandboxName, options.port);
    if (state?.pid === child.pid) {
      if (probeForwardReady(bind, options.port)) {
        fs.closeSync(out);
        return { ok: true, state: state ?? undefined, diagnostic: "" };
      }
    }
    sleepMs(250);
  }

  let diagnostic = "";
  try {
    diagnostic = readOpenFileDescriptor(out).trim();
  } catch {
    /* ignore */
  }
  fs.closeSync(out);
  try {
    if (child.pid) process.kill(child.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  return {
    ok: false,
    diagnostic:
      diagnostic || `forward bridge did not become ready within ${String(timeoutMs)}ms`,
  };
}

export const __forwardBridgeTestHooks = {
  probeForwardReady,
};
