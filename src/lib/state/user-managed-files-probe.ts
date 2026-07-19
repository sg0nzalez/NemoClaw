// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSandboxReadOnlyWithGrpcFallback } from "../adapters/openshell/sandbox-control-routing.js";
import { loadAgent } from "../agent/defs.js";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding.js";
import { shellQuote } from "../runner.js";
import * as registry from "./registry.js";

export const USER_MANAGED_FILES_BASE = "/sandbox";

export interface UserManagedFilesProbe {
  declared: string[];
  existing: string[];
}

const _verbose = (): boolean => process.env.NEMOCLAW_REBUILD_VERBOSE === "1";

function _log(msg: string): void {
  if (_verbose()) console.error(`  [user-managed-files-probe ${new Date().toISOString()}] ${msg}`);
}

export async function probeUserManagedFiles(sandboxName: string): Promise<UserManagedFilesProbe> {
  const sb = registry.getSandbox(sandboxName);
  if (!sb) {
    throw new Error(`user-managed file probe failed: sandbox '${sandboxName}' is not registered`);
  }
  const agentName = sb.agent || "openclaw";
  const declared = [...(loadAgent(agentName).userManagedFiles ?? [])];
  if (declared.length === 0) return { declared, existing: [] };

  _log(
    `sandbox=${sandboxName}, agent=${agentName}, declared=[${declared.join(",")}], base=${USER_MANAGED_FILES_BASE}`,
  );
  const command =
    declared
      .map(
        (relPath) =>
          `if [ -f ${shellQuote(`${USER_MANAGED_FILES_BASE}/${relPath}`)} ]; then printf '%s\\n' ${shellQuote(relPath)}; fi`,
      )
      .join("; ") + " 2>/dev/null";
  const result = await execSandboxReadOnlyWithGrpcFallback(resolveSandboxGatewayName(sb), {
    sandboxName,
    command: ["sh", "-c", command],
    timeoutMs: 30_000,
  });
  const stdout = result.stdout.trim();
  if (result.error || result.status === null || (result.status !== 0 && stdout.length === 0)) {
    const detail = result.stderr.trim() || result.error?.message || `exit=${result.status}`;
    _log(`OpenShell probe failed: ${detail.substring(0, 200)}`);
    throw new Error(`user-managed file probe failed: ${detail.substring(0, 200)}`);
  }
  const existing = stdout.split("\n").filter((line) => line.length > 0);
  _log(`${existing.length}/${declared.length} present in sandbox`);
  return { declared, existing };
}
