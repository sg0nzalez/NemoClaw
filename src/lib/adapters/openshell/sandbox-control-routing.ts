// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { log } from "../../cli/logger";
import {
  createGrpcOpenShellSandboxControlForGateway,
  OpenShellGrpcEdgeTunnelRequiredError,
} from "./grpc-gateway-config";
import {
  type GrpcOpenShellSandboxControl,
  OpenShellGrpcPreDispatchError,
} from "./grpc-sandbox-control";
import {
  createCliOpenShellSandboxControl,
  type OpenShellSandboxControl,
  type SandboxExecRequest,
  type SandboxExecResult,
} from "./sandbox-control";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";

export interface ReadOnlyRoutingDependencies {
  cli: OpenShellSandboxControl;
  createGrpc: (gatewayName: string) => GrpcOpenShellSandboxControl;
  debug: (message: string, context: unknown) => void;
}

const defaultDependencies: ReadOnlyRoutingDependencies = {
  cli: createCliOpenShellSandboxControl(),
  createGrpc: createGrpcOpenShellSandboxControlForGateway,
  debug: (message, context) => log.debug(message, context),
};

export interface OpenShellMutationControlSelection {
  control: OpenShellSandboxControl;
  transport: "grpc" | "cli-edge-tunnel";
  close(): void;
}

/**
 * Select one transport before a mutating workflow starts. Direct gRPC is the
 * default. The CLI is selected only for the explicit Cloudflare edge-tunnel
 * mode that a direct client cannot traverse. This function never retries an
 * operation after dispatch.
 */
export function selectOpenShellSandboxControlForMutation(
  gatewayName: string,
  dependencies: ReadOnlyRoutingDependencies = defaultDependencies,
): OpenShellMutationControlSelection {
  try {
    const grpc = dependencies.createGrpc(gatewayName);
    return {
      control: grpc,
      transport: "grpc",
      close: () => {
        try {
          grpc.close();
        } catch (error) {
          dependencies.debug("OpenShell direct gRPC client close failed", error);
        }
      },
    };
  } catch (error) {
    if (!(error instanceof OpenShellGrpcEdgeTunnelRequiredError)) throw error;
    return {
      control: dependencies.cli,
      transport: "cli-edge-tunnel",
      close: () => {},
    };
  }
}

/**
 * Prefer direct gRPC for explicitly reviewed read-only probes and retry through
 * the OpenShell CLI only when configuration or sandbox lookup fails before
 * Exec is dispatched. OpenShell v0.0.72 can persist
 * `auth_mode: "cloudflare_jwt"`; only its CLI can establish that
 * OpenShell-owned edge tunnel and manage the associated credential lifecycle,
 * so NemoClaw cannot replace that path here.
 *
 * This migration contract is limited to call sites whose operations were
 * individually reviewed as side-effect-free: session listing, rebuild and
 * managed-file probes, debug diagnostics, version checks, and state-file
 * backup reads at this slice. It is not a general routing policy. Remove the
 * CLI fallback when OpenShell's public client or bindings support the
 * edge-tunnel auth and credential-refresh lifecycle. Every added caller
 * requires a replay-semantics review; mutations must select one transport
 * before dispatch and must never be replayed automatically.
 */
export async function execSandboxReadOnlyWithGrpcFallback(
  gatewayName: string,
  request: SandboxExecRequest,
  dependencies: ReadOnlyRoutingDependencies = defaultDependencies,
): Promise<SandboxExecResult> {
  let grpc: GrpcOpenShellSandboxControl | undefined;
  try {
    grpc = dependencies.createGrpc(gatewayName);
    const result = await grpc.exec({
      ...request,
      timeoutMs: request.timeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (!(result.error instanceof OpenShellGrpcPreDispatchError)) return result;
    dependencies.debug(
      "OpenShell direct gRPC lookup failed before dispatch; retrying through the CLI",
      result.error.cause,
    );
  } catch (error) {
    dependencies.debug(
      "OpenShell direct gRPC configuration failed; retrying through the CLI",
      error,
    );
  } finally {
    try {
      grpc?.close();
    } catch (error) {
      dependencies.debug("OpenShell direct gRPC client close failed", error);
    }
  }
  return dependencies.cli.exec({
    ...request,
    timeoutMs: request.timeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS,
  });
}
