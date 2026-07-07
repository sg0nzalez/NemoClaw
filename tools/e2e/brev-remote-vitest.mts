// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../src/lib/core/shell-quote";

export type BrevVitestProject = "cli" | "e2e-live";

export const BREV_SECURITY_SUITE_TIMEOUT_MS = 20 * 60_000;
export const BREV_MESSAGING_PROVIDER_TIMEOUT_MS = 70 * 60_000;
export const BREV_MESSAGING_COMPAT_TIMEOUT_MS = 40 * 60_000;
export const BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_TIMEOUT_MS = 55 * 60_000;
export const BREV_REMOTE_WRAPPER_GRACE_MS = 120_000;
export const BREV_WORKFLOW_OWNERSHIP_ENV = "NEMOCLAW_BREV_WORKFLOW_OWNS_INSTANCE";
export const BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE = "tool-disclosure-performance-smoke";
export const BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_ARTIFACT_DIR =
  "/tmp/nemoclaw-tool-disclosure-performance-smoke-artifacts";
export const BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_MCP_PORT = 43_117;

const BREV_SUITES_WITHOUT_HARNESS_SANDBOX = new Set([
  "all",
  "full",
  "gpu",
  "messaging-compatible-endpoint",
  "messaging-providers",
  BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE,
]);

export function brevSuiteNeedsHarnessSandbox(testSuite: string): boolean {
  return !BREV_SUITES_WITHOUT_HARNESS_SANDBOX.has(testSuite);
}

export function brevSuiteHarnessSandboxName(testSuite: string): string | undefined {
  return brevSuiteNeedsHarnessSandbox(testSuite) ? "e2e-test" : undefined;
}

export function brevWorkflowOwnsInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BREV_WORKFLOW_OWNERSHIP_ENV] === "1";
}

export function buildBrevSshForwardEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG"]) {
    if (env[name] !== undefined) selected[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) selected[name] = value;
  }
  return selected;
}

export function buildBrevMcpSshForwardArgs(instanceName: string, localPort: number): string[] {
  if (!instanceName) throw new Error("Brev MCP SSH forward requires an instance name");
  if (!Number.isInteger(localPort) || localPort < 1_024 || localPort > 65_535) {
    throw new Error("Brev MCP SSH forward local port must be between 1024 and 65535");
  }
  return [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_MCP_PORT}`,
    instanceName,
  ];
}

export function buildBrevRemoteVitestCommand(project: BrevVitestProject, target: string): string {
  const vitestCommand = [
    "./node_modules/.bin/vitest",
    "run",
    "--project",
    project,
    target,
    "--silent=false",
    "--reporter=default",
  ]
    .map(shellQuote)
    .join(" ");

  return [
    // A nested live installer test may run npm link and prune the repository's
    // dev dependencies. Restore the reviewed lockfile graph before the next
    // remote suite, with lifecycle scripts disabled, instead of letting npx
    // download an unpinned replacement.
    "if [ ! -x ./node_modules/.bin/vitest ]; then npm ci --ignore-scripts --no-audit --no-fund; fi",
    "test -x ./node_modules/.bin/vitest",
    `NEMOCLAW_RUN_LIVE_E2E=1 ${vitestCommand}`,
  ].join(" && ");
}
