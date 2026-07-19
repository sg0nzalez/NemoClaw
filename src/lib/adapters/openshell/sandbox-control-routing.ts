// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { log } from "../../cli/logger";
import { createGrpcOpenShellSandboxControlForGateway } from "./grpc-gateway-config";
import {
  type GrpcOpenShellSandboxControl,
  OpenShellGrpcPreDispatchError,
} from "./grpc-sandbox-control";
import {
  createGatewayScopedCliOpenShellSandboxControl,
  OpenShellExecRequestValidationError,
  openShellExecRequestValidationFailure,
  type OpenShellSandboxControl,
  type SandboxExecRequest,
  type SandboxExecResult,
  validateOpenShellExecCommand,
} from "./sandbox-control";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";

export interface ReadOnlyRoutingDependencies {
  createCli: (gatewayName: string) => OpenShellSandboxControl;
  createGrpc: (gatewayName: string) => GrpcOpenShellSandboxControl;
  debug: (message: string, context: unknown) => void;
}

const defaultDependencies: ReadOnlyRoutingDependencies = {
  createCli: createGatewayScopedCliOpenShellSandboxControl,
  createGrpc: createGrpcOpenShellSandboxControlForGateway,
  debug: (message, context) => log.debug(message, context),
};

/**
 * Prefer direct gRPC for the OpenClaw session-list read and retry through the
 * OpenShell CLI only when configuration or sandbox lookup fails before Exec is
 * dispatched. OpenShell v0.0.85 can persist `auth_mode: "cloudflare_jwt"`;
 * only its CLI can establish that OpenShell-owned edge tunnel and manage the
 * associated credential lifecycle, so NemoClaw cannot replace that path here.
 *
 * This is a migration compatibility contract for the single current caller,
 * `runSessionsPassthrough`, not a general routing policy. Remove the CLI
 * fallback when OpenShell's public client or bindings support the edge-tunnel
 * auth and credential-refresh lifecycle. Do not reuse it for another command
 * without reviewing that command's replay semantics; mutations must select one
 * transport before dispatch and must never be replayed automatically.
 */
export async function execSandboxReadOnlyWithGrpcFallback(
  gatewayName: string,
  request: SandboxExecRequest,
  dependencies: ReadOnlyRoutingDependencies = defaultDependencies,
): Promise<SandboxExecResult> {
  const validationError = validateOpenShellExecCommand(request.command);
  if (validationError) return openShellExecRequestValidationFailure(validationError);

  let grpc: GrpcOpenShellSandboxControl;
  try {
    grpc = dependencies.createGrpc(gatewayName);
  } catch (error) {
    if (error instanceof OpenShellExecRequestValidationError) {
      return openShellExecRequestValidationFailure(error);
    }
    dependencies.debug(
      "OpenShell direct gRPC configuration failed; retrying through the CLI",
      error,
    );
    return dependencies.createCli(gatewayName).exec({
      ...request,
      timeoutMs: request.timeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS,
    });
  }

  let preDispatchError: OpenShellGrpcPreDispatchError | undefined;
  try {
    const result = await grpc.exec({
      ...request,
      timeoutMs: request.timeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (!(result.error instanceof OpenShellGrpcPreDispatchError)) return result;
    preDispatchError = result.error;
  } catch (error) {
    if (error instanceof OpenShellGrpcPreDispatchError) {
      preDispatchError = error;
    } else {
      const cause = error instanceof Error ? error : new Error(String(error));
      return { status: null, stdout: "", stderr: "", error: cause };
    }
  } finally {
    try {
      grpc.close();
    } catch (error) {
      dependencies.debug("OpenShell direct gRPC client close failed", error);
    }
  }

  dependencies.debug(
    "OpenShell direct gRPC lookup failed before dispatch; retrying through the CLI",
    preDispatchError.cause,
  );
  return dependencies.createCli(gatewayName).exec({
    ...request,
    timeoutMs: request.timeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS,
  });
}
