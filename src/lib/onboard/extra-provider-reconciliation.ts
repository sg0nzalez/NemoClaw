// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNoOpenShellGatewayEndpointOverride } from "../openshell-gateway-endpoint-guard";
import type { SandboxProviderRunOpenshell } from "./sandbox-provider-cleanup";

export type ReconcileExtraProvidersDeps = {
  runOpenshell?: SandboxProviderRunOpenshell;
  /**
   * Scope existence probes to this gateway (`provider get -g <name>`),
   * mirroring the gateway-scoped runner the other onboarding provider
   * probes use. When set, the same endpoint-override guard applies.
   */
  gatewayName?: string;
  listExtraProviders?: () => string[];
  forgetExtraProvider?: (name: string) => boolean;
  warn?: (message: string) => void;
};

/**
 * Diagnostic shapes for "the probed provider does not exist": both the CLI's
 * `provider 'X' not found` and the gRPC-style `NotFound: provider "X"`
 * orderings. Anchored to the word "provider" on the same line so missing-
 * sandbox or missing-gateway errors never count as a provider-not-found.
 */
const PROVIDER_NOT_FOUND_RE =
  /provider[^\n]{0,200}?(?:\bNotFound\b|\bnot\s+found\b)|(?:\bNotFound\b|\bnot\s+found\b)(?::|\s)[^\n]{0,200}?\bprovider\b/i;

function toText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function") {
    return (value as Buffer).toString();
  }
  return "";
}

function defaultRunOpenshell(
  args: string[],
  opts?: Record<string, unknown>,
): ReturnType<SandboxProviderRunOpenshell> {
  const runtime = require("../adapters/openshell/runtime") as {
    runOpenshell: SandboxProviderRunOpenshell;
  };
  return runtime.runOpenshell(args, opts);
}

function defaultListExtraProviders(): string[] {
  const { listExtraProviders } = require("../state/registry") as {
    listExtraProviders: () => string[];
  };
  return listExtraProviders();
}

function defaultForgetExtraProvider(name: string): boolean {
  const { removeExtraProvider } = require("../state/registry") as {
    removeExtraProvider: (name: string) => boolean;
  };
  return removeExtraProvider(name);
}

// SOURCE_OF_TRUTH_REVIEW (extra-provider registry vs gateway drift, #6501):
// invalid state = the host registry records an extra provider (written by
// `credentials add` → `addExtraProvider`) that the gateway no longer knows,
// created by gateway-side `provider delete` or pointing the CLI at a rebuilt
// gateway — neither path can update the host record because OpenShell emits
// no provider-deletion signal the CLI could observe. Passing the dangling
// name to `sandbox create --provider` then fails every subsequent onboard
// with "provider not found", even when the user declined the feature that
// once created it. Reconciling at consumption time recovers regardless of
// how the desync happened. Regression proof lives in
// test/extra-provider-reconciliation.test.ts and the spawn-level onboard
// test in test/onboard-extra-provider-prune.test.ts. Remove this helper when
// OpenShell exposes a structured provider-deletion event (or the registry
// stops mirroring gateway provider state).
/**
 * Resolve the registry-recorded extra providers that sandbox creation may
 * attach, dropping records the gateway no longer knows about (#6501).
 *
 * Each recorded name is probed with `provider get` (the same existence
 * check `upsertProvider` uses); a record is pruned only when the gateway
 * explicitly answers "provider … not found". Any other failure — gateway
 * down, timeout, unexpected diagnostic — keeps the record (fail-open, with
 * a debug note for diagnosability) so a real outage still surfaces through
 * the sandbox-create diagnostics instead of silently dropping a healthy
 * provider.
 */
export function reconcileRegisteredExtraProviders(
  deps: ReconcileExtraProvidersDeps = {},
): string[] {
  const recorded = (deps.listExtraProviders ?? defaultListExtraProviders)();
  if (recorded.length === 0) return recorded;
  if (deps.gatewayName) assertNoOpenShellGatewayEndpointOverride();
  const gatewayArgs = deps.gatewayName ? ["-g", deps.gatewayName] : [];
  const runOpenshell = deps.runOpenshell ?? defaultRunOpenshell;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const forget = deps.forgetExtraProvider ?? defaultForgetExtraProvider;
  return recorded.filter((name) => {
    const result = runOpenshell(["provider", "get", ...gatewayArgs, name], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    });
    if (result.status === 0) return true;
    const output = `${toText(result.stdout)}${toText(result.stderr)}`;
    if (!PROVIDER_NOT_FOUND_RE.test(output)) {
      console.debug(
        `reconcileRegisteredExtraProviders: keeping '${name}' — existence probe failed without a provider-not-found diagnostic (fail-open).`,
      );
      return true;
    }
    warn(
      `  Skipping recorded provider '${name}': not registered with the OpenShell gateway. ` +
        `Removing the stale local record; recreate it with 'nemoclaw credentials add' if needed.`,
    );
    try {
      forget(name);
    } catch {
      // A registry write failure must not abort onboarding — the dangling
      // record is still skipped for this run and re-pruned on the next one.
    }
    return false;
  });
}
