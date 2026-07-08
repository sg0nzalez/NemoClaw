// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { detectGpu, type GpuDetection } from "../inference/nim";
import { failLine } from "../cli/terminal-style";
import { assertDockerBridgeAndContainerDnsHealthy } from "./bridge-dns-preflight";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import { resolveNemoClawGatewayRuntime } from "./gateway-runtime-selection";
import { warnIfHostProxyMissesLoopback } from "./http-proxy-preflight";
import { assertPodmanRuntimeAvailable } from "./podman-runtime-preflight";
import {
  assertCdiNvidiaGpuSpecPresent,
  assessHost,
  type HostAssessment,
  planHostRemediation,
} from "./preflight";
import { printDockerNotReachableError, printUnsupportedRuntimeError } from "./preflight-messages";
import { printRemediationActions } from "./remediation";
import { resolveSandboxGpuConfig, type SandboxGpuConfig } from "./sandbox-gpu-mode";
import {
  resolveSandboxGpuFlagFromOptions,
  validateSandboxGpuPreflight,
} from "./sandbox-gpu-preflight";
import type { OnboardOptions } from "./types";

export type FatalRuntimePreflightOptions = Pick<
  OnboardOptions,
  "sandboxGpu" | "sandboxGpuDevice" | "gpu" | "noGpu"
> & {
  optedOutGpuPassthrough?: boolean;
};

export interface FatalRuntimePreflightContext {
  nonInteractive: boolean;
  exitProcess?: (code: number) => never;
}

export interface FatalRuntimePreflightResult {
  gpu: GpuDetection | null;
  host: HostAssessment;
  sandboxGpuConfig: SandboxGpuConfig;
}

const exitProcessByDefault = (code: number): never => process.exit(code);

/** Reject runtimes that cannot support the OpenShell Docker-driver integration. */
export function rejectUnsupportedContainerRuntime(
  host: HostAssessment,
  exitProcess: (code: number) => never = exitProcessByDefault,
): void {
  if (
    isLinuxDockerDriverGatewayEnabled() &&
    resolveNemoClawGatewayRuntime() === "docker" &&
    host.runtime === "podman"
  ) {
    printUnsupportedRuntimeError();
    exitProcess(1);
  }
}

function runPodmanRuntimePreflight(
  options: FatalRuntimePreflightOptions,
  exitProcess: (code: number) => never,
): FatalRuntimePreflightResult {
  const baseHost = assessHost();
  const podman = assertPodmanRuntimeAvailable(undefined, exitProcess);
  const host: HostAssessment = {
    ...baseHost,
    runtime: "podman",
    isUnsupportedRuntime: false,
    notes: [...baseHost.notes, `Podman socket: ${podman.socketPath}`],
  };
  console.log("  ✓ Podman is running (rootless)");
  if (podman.infoSummary) console.log(`  ⓘ Podman: ${podman.infoSummary}`);
  warnIfHostProxyMissesLoopback();
  const gpu = detectGpu();
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options),
    device: options.sandboxGpuDevice ?? null,
  });
  validateSandboxGpuPreflight(sandboxGpuConfig, {}, exitProcess);
  if (sandboxGpuConfig.sandboxGpuEnabled) {
    console.error("");
    console.error(
      failLine("Podman gateway runtime POC does not yet support sandbox GPU passthrough."),
    );
    console.error("    Re-run with --no-gpu or NEMOCLAW_SANDBOX_GPU=0.");
    exitProcess(1);
  }
  console.log("  ✓ Container runtime: podman");
  if (host.notes.includes("Running under WSL")) console.log("  ⓘ Running under WSL");
  return { gpu, host, sandboxGpuConfig };
}

/** Run the non-mutating runtime gates shared by fresh, resume, and rebuild onboarding. */
export function runFatalOnboardRuntimePreflight(
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
): FatalRuntimePreflightResult {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  if (resolveNemoClawGatewayRuntime() === "podman") {
    return runPodmanRuntimePreflight(options, exitProcess);
  }
  const host = assessHost();
  if (!host.dockerReachable) {
    printDockerNotReachableError();
    printRemediationActions(planHostRemediation(host));
    exitProcess(1);
  }
  rejectUnsupportedContainerRuntime(host, exitProcess);
  console.log("  ✓ Docker is running");
  warnIfHostProxyMissesLoopback();
  const gpu = detectGpu();
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options),
    device: options.sandboxGpuDevice ?? null,
  });
  const explicitlyOptedOutGpuPassthrough =
    options.optedOutGpuPassthrough === true || options.noGpu === true;
  assertCdiNvidiaGpuSpecPresent(
    host,
    explicitlyOptedOutGpuPassthrough,
    sandboxGpuConfig.hostGpuPlatform,
    exitProcess,
  );
  assertDockerBridgeAndContainerDnsHealthy(host, context.nonInteractive, exitProcess);
  validateSandboxGpuPreflight(sandboxGpuConfig, {}, exitProcess);
  if (host.runtime !== "unknown") console.log(`  ✓ Container runtime: ${host.runtime}`);
  if (host.notes.includes("Running under WSL")) console.log("  ⓘ Running under WSL");
  return { gpu, host, sandboxGpuConfig };
}
