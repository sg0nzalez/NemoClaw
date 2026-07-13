// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";

import { resolveOpenshell } from "../adapters/openshell/resolve";
import * as agentRuntime from "../agent/runtime";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import * as registry from "../state/registry";
import { GATEWAY_STOP_SCRIPT } from "./gateway-stop-script";

type Reporter = (message: string) => void;
type StopAttemptResult = ReturnType<typeof spawnSync>;
type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export type SandboxGatewayStopDeps = {
  getSandbox?: typeof registry.getSandbox;
  getRegisteredAgent?: typeof agentRuntime.getRegisteredAgent;
  getAgentDisplayName?: typeof agentRuntime.getAgentDisplayName;
  hasGatewayRuntime?: typeof agentRuntime.hasGatewayRuntime;
  resolveOpenshell?: typeof resolveOpenshell;
  runProcess?: ProcessRunner;
  info?: Reporter;
  warn?: Reporter;
};

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function defaultInfo(message: string): void {
  console.log(`[services] ${message}`);
}

function defaultWarn(message: string): void {
  console.log(`[services] ${message}`);
}

function validateSandboxName(name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`Invalid sandbox name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Stop only a proven OpenClaw gateway; supervised agents remain owned by their sandbox. */
export function stopSandboxChannels(sandboxName: string, deps: SandboxGatewayStopDeps = {}): void {
  const info = deps.info ?? defaultInfo;
  const warn = deps.warn ?? defaultWarn;
  const validatedSandboxName = validateSandboxName(sandboxName);
  let sandbox: ReturnType<typeof registry.getSandbox>;
  try {
    sandbox = (deps.getSandbox ?? registry.getSandbox)(validatedSandboxName);
  } catch (error) {
    warn(
      `Could not read the sandbox registry for '${validatedSandboxName}': ` +
        `${(error as Error).message ?? String(error)}. Skipping in-sandbox gateway stop.`,
    );
    return;
  }
  const agent = (deps.getRegisteredAgent ?? agentRuntime.getRegisteredAgent)(sandbox);

  if (sandbox?.agent && sandbox.agent !== "openclaw" && !agent) {
    warn(
      `Could not resolve registered agent '${sandbox.agent}' for sandbox ` +
        `'${validatedSandboxName}'; skipping in-sandbox gateway stop.`,
    );
    return;
  }
  if (!(deps.hasGatewayRuntime ?? agentRuntime.hasGatewayRuntime)(agent)) {
    const agentDisplayName = (deps.getAgentDisplayName ?? agentRuntime.getAgentDisplayName)(agent);
    info(`${agentDisplayName} has no gateway runtime; skipping in-sandbox gateway stop.`);
    return;
  }

  const agentDisplayName = (deps.getAgentDisplayName ?? agentRuntime.getAgentDisplayName)(agent);
  if (agent) {
    info(
      `${agentDisplayName} gateway is managed by the sandbox; ` +
        "leaving it running while host forwards stop.",
    );
    return;
  }

  let gatewayName: string;
  try {
    gatewayName = resolveSandboxGatewayName(sandbox);
  } catch (error) {
    warn(
      `Could not resolve the OpenShell gateway for sandbox '${validatedSandboxName}': ` +
        `${(error as Error).message ?? String(error)}. Skipping in-sandbox gateway stop.`,
    );
    return;
  }

  const gatewayLabel = `${agentDisplayName} gateway`;
  info(`Stopping in-sandbox ${gatewayLabel} (sandbox: ${validatedSandboxName})...`);

  const openshell = (deps.resolveOpenshell ?? resolveOpenshell)();
  if (!openshell) {
    warn(`openshell not found — cannot stop ${gatewayLabel} inside sandbox.`);
    return;
  }

  const fallbackResult = (deps.runProcess ?? spawnSync)(
    openshell,
    ["sandbox", "exec", "--name", validatedSandboxName, "--gateway", gatewayName, "--", "sh", "-s"],
    {
      encoding: "utf-8",
      input: GATEWAY_STOP_SCRIPT,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20000,
    },
  );
  reportStopResult(fallbackResult, gatewayLabel, info, warn);
}

function reportStopResult(
  result: StopAttemptResult,
  gatewayLabel: string,
  info: Reporter,
  warn: Reporter,
): void {
  if (result.status === 0) {
    info(`${gatewayLabel} stopped inside sandbox.`);
    return;
  }
  if (result.status === 1) {
    info(`${gatewayLabel} was not running inside sandbox.`);
    return;
  }

  const details = [result.stderr, result.stdout]
    .map((text) => (typeof text === "string" ? text : text?.toString()))
    .filter((text): text is string => Boolean(text?.trim()))
    .map((text) => text.trim())
    .join(" ");
  warn(
    `Could not stop ${gatewayLabel} inside sandbox (exit ${String(result.status ?? "unknown")}).` +
      " The sandbox may be unreachable or the gateway may still be running." +
      (details ? ` Details: ${details}` : ""),
  );
}
