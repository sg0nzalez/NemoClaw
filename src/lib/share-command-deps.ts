// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import { CLI_NAME } from "./cli/branding";
import { G, R } from "./cli/terminal-style";
import { assertNoOpenShellGatewayEndpointOverride } from "./openshell-gateway-endpoint-guard";

export interface ShareCommandDeps {
  /** Run `openshell sandbox ssh-config <name>` and return its output. */
  getSshConfig: (sandboxName: string) => { status: number | null; output: string };
  /** Ensure the sandbox is live, exit process if not. */
  ensureLive: (sandboxName: string) => Promise<void>;
  /**
   * Check whether `remotePath` exists via a replay-safe, gateway-scoped gRPC
   * probe with the reviewed read-only CLI fallback. Returns false when the path
   * is missing or the sandbox cannot be queried. Used by `share mount` before
   * invoking `sshfs`, which otherwise exits non-zero with empty stderr. See #3414.
   */
  checkSandboxPathExists: (sandboxName: string, remotePath: string) => Promise<boolean>;
  /** NVIDIA-green ANSI code (empty string if color disabled). */
  colorGreen: string;
  /** ANSI reset code (empty string if color disabled). */
  colorReset: string;
  /** CLI executable name for user-facing messages (supports alias launchers). */
  cliName: string;
}

export function buildShareCommandDeps(): ShareCommandDeps {
  const { captureOpenshell } = require("./adapters/openshell/runtime") as {
    captureOpenshell: (
      args: string[],
      opts?: { ignoreError?: boolean; timeout?: number },
    ) => { status: number | null; output: string };
  };
  const { ensureLiveSandboxOrExit } = require("./actions/sandbox/gateway-state") as {
    ensureLiveSandboxOrExit: (sandboxName: string) => Promise<unknown>;
  };
  const { getSandboxTargetGatewayName } = require("./actions/sandbox/gateway-target") as {
    getSandboxTargetGatewayName: (sandboxName: string) => string;
  };
  const { execSandboxReadOnlyWithGrpcFallback } =
    require("./adapters/openshell/sandbox-control-routing") as typeof import("./adapters/openshell/sandbox-control-routing.js");

  return {
    getSshConfig: (sandboxName: string) => {
      assertNoOpenShellGatewayEndpointOverride();
      return captureOpenshell(
        [
          "--gateway",
          getSandboxTargetGatewayName(sandboxName),
          "sandbox",
          "ssh-config",
          sandboxName,
        ],
        {
          ignoreError: true,
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        },
      );
    },
    ensureLive: async (sandboxName: string) => {
      await ensureLiveSandboxOrExit(sandboxName);
    },
    checkSandboxPathExists: async (sandboxName: string, remotePath: string) => {
      try {
        assertNoOpenShellGatewayEndpointOverride();
        const result = await execSandboxReadOnlyWithGrpcFallback(
          getSandboxTargetGatewayName(sandboxName),
          {
            sandboxName,
            command: ["test", "-e", remotePath],
            maxOutputBytes: 4096,
            timeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
          },
        );
        return result.status === 0 && !result.error && !result.signal;
      } catch {
        return false;
      }
    },
    colorGreen: G,
    colorReset: R,
    cliName: CLI_NAME,
  };
}
