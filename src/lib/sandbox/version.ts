// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Sandbox version staleness detection.
//
// Compares the agent version running inside a sandbox against the version
// this NemoClaw release was built for. Two code paths:
//   Fast: registry lookup (used when agentVersion is already cached)
//   Slow: sandbox exec, run version_command, cache result in registry

import { parseVersionFromText } from "../adapters/openshell/client.js";
import { execSandboxReadOnlyWithGrpcFallback } from "../adapters/openshell/sandbox-control-routing.js";
import { loadAgent } from "../agent/defs.js";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding.js";
import * as registry from "../state/registry.js";
import { evaluateStaleness } from "./version-scheme.js";

const VERSION_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export interface VersionCheckResult {
  sandboxVersion: string | null;
  expectedVersion: string | null;
  /**
   * True when the sandbox should be rebuilt. This includes scheme-mismatch
   * cases, which are fail-closed: an incomparable pair is treated as stale so
   * the rebuild flow realigns the runtime and cache.
   */
  isStale: boolean;
  /**
   * True whenever the check could not observe a runtime version — probe
   * failed, no expected version, or opted-out probing. Callers should render
   * an "unable to verify" state rather than treat `isStale === false` as a
   * positive signal. Scheme mismatches do NOT set this: they set
   * `schemeMismatch` and `isStale`.
   */
  verificationFailed: boolean;
  /**
   * How the staleness verdict was reached.
   * - `"registry"` / `"sandbox-exec"`: `isStale` is authoritative for this sandbox
   *   as long as `verificationFailed` is `false`.
   * - `"unavailable"`: no staleness check was attempted (missing expected
   *   version, or the caller opted out of probing).
   * - `"unknown"`: a probe was attempted but the runtime version could not be
   *   inspected — callers should treat this as "unable to verify", not
   *   "verified current".
   */
  detectionMethod: "registry" | "sandbox-exec" | "unavailable" | "unknown";
  /**
   * `true` when the runtime and expected versions use different schemes
   * (semver vs calendar). In that case `isStale` is forced to `true` so the
   * normal rebuild flow realigns the runtime with the current manifest; the
   * flag lets callers distinguish this fail-closed path from a numeric
   * comparison that observed a genuinely older version.
   */
  schemeMismatch?: boolean;
  /** Categorises why the result could not be computed, so callers can surface a distinct state. */
  unavailableReason?: "no-expected-version" | "skip-probe" | "probe-failed";
}

/**
 * Controls whether version checks may use cached metadata or must inspect the sandbox runtime.
 */
export interface VersionCheckOptions {
  forceProbe?: boolean;
  skipProbe?: boolean;
}

/**
 * Resolve the agent definition for a sandbox.
 * Falls back to "openclaw" when the sandbox has no agent set.
 */
function resolveAgentForSandbox(sandboxName: string): ReturnType<typeof loadAgent> {
  const sb = registry.getSandbox(sandboxName);
  const agentName = sb?.agent || "openclaw";
  return loadAgent(agentName);
}

/**
 * Probe the live agent version through OpenShell's sandbox exec API.
 * Returns the parsed version string or null on failure.
 */
export async function probeAgentVersion(sandboxName: string): Promise<string | null> {
  const agent = resolveAgentForSandbox(sandboxName);
  try {
    const result = await execSandboxReadOnlyWithGrpcFallback(
      resolveSandboxGatewayName(registry.getSandbox(sandboxName)),
      {
        sandboxName,
        command: ["sh", "-c", agent.versionCommand],
        maxOutputBytes: VERSION_PROBE_MAX_OUTPUT_BYTES,
        timeoutMs: 15_000,
      },
    );
    if (result.status !== 0 || result.error) return null;
    return parseVersionFromText(result.stdout, agent.versionCommand);
  } catch {
    return null;
  }
}

/**
 * Check whether a sandbox is running an outdated agent version.
 *
 * Fast path: compare registry.agentVersion against manifest expected_version.
 * Slow path: run version_command through sandbox exec and cache the result.
 */
export async function checkAgentVersion(
  sandboxName: string,
  opts?: VersionCheckOptions,
): Promise<VersionCheckResult> {
  const agent = resolveAgentForSandbox(sandboxName);
  const expectedVersion = agent.expectedVersion;

  if (!expectedVersion) {
    return {
      sandboxVersion: null,
      expectedVersion: null,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unavailable",
      unavailableReason: "no-expected-version",
    };
  }

  const sb = registry.getSandbox(sandboxName);

  // Fast path: version already cached in registry. A scheme mismatch here
  // means the cached value predates the current expected-version scheme
  // (e.g. a calendar tag left over before Hermes moved to semver, #6049).
  // `evaluateStaleness` fails closed with `isStale: true` in that case, so
  // the sandbox is routed through the normal rebuild flow — no cache write
  // and no follow-up probe race — and the rebuild itself repopulates the
  // cache with a matching-scheme value.
  if (sb?.agentVersion && !opts?.forceProbe) {
    const verdict = evaluateStaleness(
      sandboxName,
      agent.versionScheme ?? null,
      sb.agentVersion,
      expectedVersion,
    );
    return {
      sandboxVersion: sb.agentVersion,
      expectedVersion,
      isStale: verdict.isStale,
      verificationFailed: false,
      detectionMethod: "registry",
      schemeMismatch: verdict.schemeMismatch,
    };
  }

  if (opts?.skipProbe && !opts.forceProbe) {
    return {
      sandboxVersion: null,
      expectedVersion,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unavailable",
      unavailableReason: "skip-probe",
    };
  }

  // Slow path: sandbox exec
  const probed = await probeAgentVersion(sandboxName);
  if (probed && sb) {
    // Cache for future fast-path lookups
    registry.updateSandbox(sandboxName, { agentVersion: probed });
  }

  if (!probed) {
    return {
      sandboxVersion: null,
      expectedVersion,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unknown",
      unavailableReason: "probe-failed",
    };
  }

  const verdict = evaluateStaleness(
    sandboxName,
    agent.versionScheme ?? null,
    probed,
    expectedVersion,
  );
  return {
    sandboxVersion: probed,
    expectedVersion,
    isStale: verdict.isStale,
    verificationFailed: false,
    detectionMethod: "sandbox-exec",
    schemeMismatch: verdict.schemeMismatch,
  };
}

/**
 * Format a user-facing staleness warning for console output.
 */
export function formatStalenessWarning(sandboxName: string, result: VersionCheckResult): string[] {
  const agentName = resolveAgentForSandbox(sandboxName).displayName;
  return [
    "",
    `  \u26a0 Sandbox '${sandboxName}' is running ${agentName} ${result.sandboxVersion} (current: ${result.expectedVersion})`,
    `    Run: nemoclaw ${sandboxName} rebuild`,
    "",
  ];
}
