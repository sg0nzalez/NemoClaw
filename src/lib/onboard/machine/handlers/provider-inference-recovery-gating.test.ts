// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../../../state/onboard-session";
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
    const { deps, calls } = createDeps({ hasRegisteredSandbox: () => true });

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
