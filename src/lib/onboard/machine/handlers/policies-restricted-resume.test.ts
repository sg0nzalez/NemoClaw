// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handlePoliciesState } from "./policies";
import {
  basePolicyHandlerOptions as baseOptions,
  createPolicyHandlerDeps as createDeps,
  makeMessagingPlan,
} from "./policies-test-fixtures";

// Handler-level fallback for the runtime check the advisor calls out: the
// narrowest live assertion (read the actual OpenShell-applied preset list
// after restricted OpenClaw onboarding and confirm `openclaw-pricing` and
// `openclaw-diagnostics-otel-local` are absent) lives in the nightly
// `network-policy-vitest` scenario — that path requires real OpenShell plus
// an `nvapi-` inference key and is intentionally not run on every PR push.
// This contract test covers the handler-side reconciliation branch — that
// restricted resume forces `setupPoliciesWithSelection` to run rather than
// taking the resume-skip branch whenever
// `policyResumeSelection.suppressedAgentRequiredPresetsLive` is true — so the
// recorded-empty + live-suppressed-preset case cannot silently leave
// third-party egress active on restricted sandboxes.
// Removal condition: when the nightly live `network-policy-vitest` scenario
// asserts the actual applied preset list on restricted OpenClaw onboarding
// (both default and `NEMOCLAW_OPENCLAW_OTEL=1` cases), this handler-level
// contract test stays as the cheap reconciliation regression and the live
// scenario takes over as the source-of-truth runtime gate.
describe("handlePoliciesState — restricted resume reconciliation", () => {
  it("forces setup reconciliation on restricted resume when suppressed presets are live", async () => {
    const session = createSession({ policyPresets: [] });
    const prepareResume = vi.fn((_sandboxName, _options) => ({
      policyPresets: [],
      recordedPolicyPresetsNeedReconcile: false,
      disabledMessagingPolicyPresetApplied: false,
      suppressedAgentRequiredPresetsLive: true,
    }));
    const { deps, calls, setSession } = createDeps({
      preparePolicyPresetResumeSelection: prepareResume,
      arePolicyPresetsApplied: vi.fn(() => true),
      getActiveSandbox: vi.fn(() => ({
        messaging: { plan: makeMessagingPlan("my-assistant", []) },
        policyTier: "restricted",
      })),
    });
    setSession(session);

    await handlePoliciesState({ ...baseOptions(deps), resume: true });

    expect(prepareResume).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ tierName: "restricted" }),
    );
    expect(calls.skipped).not.toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: [] }),
    );
  });

  it("forces setup reconciliation when resume-selection lookup throws on restricted tier", async () => {
    const session = createSession({ policyPresets: [] });
    const prepareResume = vi.fn(() => {
      throw new Error("sandbox not ready");
    });
    const appliedCheck = vi.fn(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { deps, calls, setSession } = createDeps({
        preparePolicyPresetResumeSelection: prepareResume,
        arePolicyPresetsApplied: appliedCheck,
        getActiveSandbox: vi.fn(() => ({
          messaging: { plan: makeMessagingPlan("my-assistant", []) },
          policyTier: "restricted",
        })),
      });
      setSession(session);

      await handlePoliciesState({ ...baseOptions(deps), resume: true });

      expect(prepareResume).toHaveBeenCalled();
      expect(appliedCheck).not.toHaveBeenCalled();
      expect(calls.skipped).not.toHaveBeenCalled();
      expect(calls.recordSkip).not.toHaveBeenCalled();
      expect(calls.setupPolicies).toHaveBeenCalledWith(
        "my-assistant",
        expect.objectContaining({ selectedPresets: [] }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("resume-selection lookup failed"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("forces setup reconciliation when applied-presets check throws on restricted tier", async () => {
    const session = createSession({ policyPresets: ["dns"] });
    const prepareResume = vi.fn(() => ({
      policyPresets: ["dns"],
      recordedPolicyPresetsNeedReconcile: false,
      disabledMessagingPolicyPresetApplied: false,
      suppressedAgentRequiredPresetsLive: false,
    }));
    const appliedCheck = vi.fn(() => {
      throw new Error("policy list unavailable");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { deps, calls, setSession } = createDeps({
        preparePolicyPresetResumeSelection: prepareResume,
        arePolicyPresetsApplied: appliedCheck,
        getActiveSandbox: vi.fn(() => ({
          messaging: { plan: makeMessagingPlan("my-assistant", []) },
          policyTier: "restricted",
        })),
      });
      setSession(session);

      await handlePoliciesState({ ...baseOptions(deps), resume: true });

      expect(appliedCheck).toHaveBeenCalledWith("my-assistant", ["dns"]);
      expect(calls.skipped).not.toHaveBeenCalled();
      expect(calls.recordSkip).not.toHaveBeenCalled();
      expect(calls.setupPolicies).toHaveBeenCalledWith(
        "my-assistant",
        expect.objectContaining({ selectedPresets: ["dns"] }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("applied-presets check failed"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
