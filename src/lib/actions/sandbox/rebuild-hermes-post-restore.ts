// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { sleepSeconds } from "../../core/wait";
import * as processRecovery from "./process-recovery";

export type HermesPostRestoreGatewayState =
  | "not-applicable"
  | "healthy"
  | "recovered"
  | "unverified";

type GatewayRecoveryObservation = {
  checked: boolean;
  wasRunning: boolean | null;
  recovered: boolean;
  forwardRecoveryFailed?: boolean;
  secretBoundaryRefused?: boolean;
  secretBoundaryReason?: string;
  mcpReconciliationRefused?: boolean;
};

interface HermesPostRestoreGatewayDeps {
  checkAndRecoverSandboxProcesses?: (
    sandboxName: string,
    options: { quiet: boolean },
  ) => GatewayRecoveryObservation;
  sleepSeconds?: (seconds: number) => void;
}

const POST_RESTORE_SUPERVISOR_ATTEMPTS = 3;
const POST_RESTORE_SUPERVISOR_RETRY_SECONDS = 3;

function isTransientManagedSupervisorChurn(observation: GatewayRecoveryObservation): boolean {
  // State restoration can make PID 1 replace Hermes between the healthy HTTP
  // probe and its validator-enforced recovery request. Retry only the exact
  // controller classification; validator and integrity output stays terminal.
  return (
    observation.secretBoundaryRefused === true &&
    observation.secretBoundaryReason === "supervisor-churn"
  );
}

function classifyGatewayObservation(
  observation: GatewayRecoveryObservation,
): HermesPostRestoreGatewayState {
  if (
    !observation.checked ||
    observation.forwardRecoveryFailed === true ||
    observation.secretBoundaryRefused === true ||
    observation.mcpReconciliationRefused === true
  ) {
    return "unverified";
  }
  if (observation.wasRunning === true) return "healthy";
  if (observation.recovered) return "recovered";
  return "unverified";
}

/**
 * Re-prove Hermes gateway health after workspace state restoration.
 *
 * Inner onboarding verifies the fresh image before rebuild restores the prior
 * state. That restore can still stop or wedge the gateway, so its earlier
 * readiness message is not authoritative for rebuild completion.
 */
export function ensureHermesGatewayAfterStateRestore(
  sandboxName: string,
  agentName: string,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayState {
  if (agentName !== "hermes") return "not-applicable";
  const checkAndRecover =
    deps.checkAndRecoverSandboxProcesses ?? processRecovery.checkAndRecoverSandboxProcesses;
  const wait = deps.sleepSeconds ?? sleepSeconds;
  for (let attempt = 1; attempt <= POST_RESTORE_SUPERVISOR_ATTEMPTS; attempt += 1) {
    const observation: GatewayRecoveryObservation = checkAndRecover(sandboxName, { quiet: true });
    if (
      attempt < POST_RESTORE_SUPERVISOR_ATTEMPTS &&
      isTransientManagedSupervisorChurn(observation)
    ) {
      wait(POST_RESTORE_SUPERVISOR_RETRY_SECONDS);
      continue;
    }
    return classifyGatewayObservation(observation);
  }
  return "unverified";
}

export function printHermesGatewayRestoreRecovery(
  sandboxName: string,
  state: HermesPostRestoreGatewayState,
  writeLine: (message: string) => void = console.log,
): void {
  if (state !== "unverified") return;
  writeLine(
    `    Hermes gateway health was not verified after state restore — run \`${CLI_NAME} ${sandboxName} recover\` before relying on this sandbox`,
  );
}
