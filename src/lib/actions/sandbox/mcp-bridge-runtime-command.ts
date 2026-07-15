// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { shellQuote } from "../../core/shell-quote";

/**
 * Variables sourced for sandbox proxy access that must not leak into a child
 * diagnostic process. The managed MCP credential remains an explicit
 * openshell:resolve placeholder in the command arguments and is resolved only
 * at the OpenShell egress boundary.
 */
export const MCP_RUNTIME_SANITIZED_ENV_VARS = [
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
  "NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
] as const;

/**
 * OpenShell binds generated MCP policies to the configured adapter executable
 * and its process ancestry. Keep that runtime as the parent of a shared child
 * command instead of implementing the wire operation separately per adapter.
 */
export function wrapMcpRuntimeCommand(
  adapter: AgentMcpAdapter,
  command: readonly string[],
): string {
  const quotedCommand = command.map(shellQuote).join(" ");
  switch (adapter) {
    case "mcporter": {
      const runner =
        'const { spawnSync } = require("node:child_process"); const result = spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" }); process.exit(result.status ?? 1);';
      return `nemoclaw-start node -e ${shellQuote(runner)} ${quotedCommand}`;
    }
    case "hermes-config": {
      const runner =
        "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
      return `/opt/hermes/.venv/bin/python -c ${shellQuote(runner)} ${quotedCommand}`;
    }
    case "deepagents-config": {
      const runner =
        "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
      return `/opt/venv/bin/python3 -c ${shellQuote(runner)} ${quotedCommand}`;
    }
  }
}
