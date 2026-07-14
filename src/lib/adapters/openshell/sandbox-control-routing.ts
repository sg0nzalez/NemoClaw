// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { log } from "../../cli/logger";
import { createGrpcOpenShellSandboxControlForGateway } from "./grpc-gateway-config";
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

/**
 * Prefer direct gRPC for a read-only sandbox exec and retry through the
 * OpenShell CLI when gateway resolution or transport fails. This retry policy
 * is intentionally restricted to read-only commands: a failed mutation may
 * have committed remotely and must never be replayed automatically.
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
