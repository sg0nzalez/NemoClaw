// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { hasRecoverableSandboxIdentity } from "../../provider-recovery";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("provider inference recovery gating", () => {
  it.each([
    { label: "fresh provider selection", fresh: true, sandboxName: "dcode-station" },
    { label: "brand-new sandbox identity (#6630)", fresh: false, sandboxName: "dc-after" },
  ])("disables recorded provider recovery for $label", async ({ fresh, sandboxName }) => {
    const { deps, calls } = createDeps();

    await handleProviderInferenceState({
      ...baseOptions(deps),
      fresh,
      sandboxName,
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      sandboxName,
      null,
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("rejects a matching session whose sandbox step is incomplete (#6630)", async () => {
    const session = createSession();
    session.sandboxName = "dc-after";
    const { deps, calls } = createDeps();

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("allows recovery for a registered sandbox", async () => {
    const hasIdentity = vi.fn((name: string) => name === "dc-after");
    const { deps, calls } = createDeps({ hasRecoverableSandboxIdentity: hasIdentity });

    await handleProviderInferenceState({
      ...baseOptions(deps),
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
    );
    expect(hasIdentity).toHaveBeenCalledWith("dc-after", expect.any(String));
  });

  it.each([
    { label: "orphaned", reservationSessionId: undefined },
    { label: "owned by another session", reservationSessionId: "session-other" },
  ])("rejects an $label pending reservation during resume (#6630)", async ({
    reservationSessionId,
  }) => {
    const session = createSession();
    session.sandboxName = "dc-after";
    const entry: SandboxEntry = {
      name: "dc-after",
      pendingRouteReservation: true,
      ...(reservationSessionId ? { reservationSessionId } : {}),
    };
    const hasIdentity = vi.fn((_name: string, sessionId: string | null | undefined) =>
      hasRecoverableSandboxIdentity(entry, sessionId),
    );
    const { deps, calls } = createDeps({ hasRecoverableSandboxIdentity: hasIdentity });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
    );
    expect(hasIdentity).toHaveBeenCalledWith("dc-after", session.sessionId);
  });

  it("allows recovery for the current session's pending reservation (#6630)", async () => {
    const session = createSession();
    session.sandboxName = "dc-after";
    const entry: SandboxEntry = {
      name: "dc-after",
      pendingRouteReservation: true,
      reservationSessionId: session.sessionId,
    };
    const hasIdentity = vi.fn((_name: string, sessionId: string | null | undefined) =>
      hasRecoverableSandboxIdentity(entry, sessionId),
    );
    const { deps, calls } = createDeps({ hasRecoverableSandboxIdentity: hasIdentity });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
    );
    expect(hasIdentity).toHaveBeenCalledWith("dc-after", session.sessionId);
  });

  it("allows recovery for a matching completed session sandbox", async () => {
    const session = createSession();
    session.sandboxName = "dc-after";
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps();

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
    );
  });
});
