// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import {
  createProviderRecoveryHelpers,
  hasRecoverableSandboxIdentity,
  isRecoverableSandboxIdentity,
  shouldRecoverRecordedProvider,
  validateLiveGatewayInference,
} from "./provider-recovery";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateLiveGatewayInference", () => {
  it("accepts a complete bounded provider/model pair", () => {
    expect(
      validateLiveGatewayInference({
        provider: " compatible-endpoint ",
        model: " nvidia/nemotron-3-ultra ",
      }),
    ).toEqual({ provider: "compatible-endpoint", model: "nvidia/nemotron-3-ultra" });
  });

  it.each([
    ["missing provider", { provider: null, model: "model" }],
    ["missing model", { provider: "nvidia-prod", model: null }],
    ["unsafe provider", { provider: "nvidia-prod\nModel: attacker", model: "model" }],
    ["oversized provider", { provider: `p${"x".repeat(128)}`, model: "model" }],
    ["unsafe model", { provider: "nvidia-prod", model: "model;touch /tmp/pwned" }],
    ["oversized model", { provider: "nvidia-prod", model: `m${"x".repeat(512)}` }],
  ])("rejects %s", (_label, inference) => {
    expect(validateLiveGatewayInference(inference)).toBeNull();
  });
});

describe("shouldRecoverRecordedProvider", () => {
  it.each([
    {
      label: "rejects gateway recovery for a brand-new sandbox",
      fresh: false,
      sandboxName: "dc-after",
      hasRecoverableSandboxIdentity: false,
      sessionSandboxName: null,
      expected: false,
    },
    {
      label: "allows gateway recovery before an interactive sandbox name is selected",
      fresh: false,
      sandboxName: null,
      hasRecoverableSandboxIdentity: false,
      sessionSandboxName: null,
      expected: true,
    },
    {
      label: "allows gateway recovery for a registered sandbox",
      fresh: false,
      sandboxName: "dc-after",
      hasRecoverableSandboxIdentity: true,
      sessionSandboxName: null,
      expected: true,
    },
    {
      label: "allows gateway recovery for a matching session",
      fresh: false,
      sandboxName: "dc-after",
      hasRecoverableSandboxIdentity: false,
      sessionSandboxName: "dc-after",
      expected: true,
    },
    {
      label: "rejects gateway recovery for a different session sandbox",
      fresh: false,
      sandboxName: "dc-after",
      hasRecoverableSandboxIdentity: false,
      sessionSandboxName: "dc-before",
      expected: false,
    },
    {
      label: "rejects gateway recovery when fresh overrides existing identity",
      fresh: true,
      sandboxName: "dc-after",
      hasRecoverableSandboxIdentity: true,
      sessionSandboxName: "dc-after",
      expected: false,
    },
  ])("$label", ({
    fresh,
    sandboxName,
    hasRecoverableSandboxIdentity,
    sessionSandboxName,
    expected,
  }) => {
    expect(
      shouldRecoverRecordedProvider({
        fresh,
        sandboxName,
        hasRecoverableSandboxIdentity,
        sessionSandboxName,
      }),
    ).toBe(expected);
  });
});

describe("recoverable sandbox identity", () => {
  const pending = (reservationSessionId?: string): registry.SandboxEntry => ({
    name: "dc-after",
    pendingRouteReservation: true,
    ...(reservationSessionId ? { reservationSessionId } : {}),
  });

  it.each([
    { label: "missing registry row", entry: null, sessionId: "session-current", expected: false },
    {
      label: "orphaned pending reservation",
      entry: pending(),
      sessionId: "session-current",
      expected: false,
    },
    {
      label: "another session's pending reservation",
      entry: pending("session-other"),
      sessionId: "session-current",
      expected: false,
    },
    {
      label: "the current session's pending reservation",
      entry: pending("session-current"),
      sessionId: "session-current",
      expected: true,
    },
    {
      label: "fully registered sandbox",
      entry: { name: "dc-after" },
      sessionId: null,
      expected: true,
    },
  ])("classifies $label (#6630)", ({ entry, sessionId, expected }) => {
    expect(isRecoverableSandboxIdentity(entry, sessionId)).toBe(expected);
  });

  it("loads the named registry row before applying session ownership (#6630)", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(pending("session-current"));

    expect(hasRecoverableSandboxIdentity("dc-after", "session-current")).toBe(true);
    expect(registry.getSandbox).toHaveBeenCalledWith("dc-after");
  });
});

describe("provider recovery persisted routing state", () => {
  function helpers() {
    return createProviderRecoveryHelpers({
      parseGatewayInference: () => ({ provider: "nvidia-prod", model: null }),
      runCaptureOpenshell: () => "Gateway inference:",
    });
  }

  it("rejects partial live gateway output", () => {
    vi.spyOn(registry, "listSandboxes").mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha" }],
    });

    expect(helpers().readLiveInference("alpha")).toBeNull();
  });

  it("prefers the selected sandbox registry endpoint over session state", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      endpointUrl: "https://registry.example/v1",
    });
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(
      onboardSession.createSession({
        sandboxName: "alpha",
        endpointUrl: "https://session.example/v1",
      }),
    );

    expect(helpers().readRecordedEndpointUrl("alpha")).toBe("https://registry.example/v1");
  });

  it("reads a complete route atomically from registry or a matching session", () => {
    vi.spyOn(registry, "getSandbox")
      .mockReturnValueOnce({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: " https://registry.example/v1 ",
        preferredInferenceApi: "openai-completions",
      })
      .mockReturnValueOnce(null);
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(
      onboardSession.createSession({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: "https://session.example/v1",
        preferredInferenceApi: "openai-responses",
      }),
    );
    const recovery = helpers();

    expect(recovery.readRecordedInferenceRoute("alpha")).toEqual({
      provider: "compatible-endpoint",
      model: "model-a",
      endpointUrl: "https://registry.example/v1",
      preferredInferenceApi: "openai-completions",
      source: "registry",
    });
    expect(recovery.readRecordedInferenceRoute("alpha")).toEqual({
      provider: "compatible-endpoint",
      model: "model-b",
      endpointUrl: "https://session.example/v1",
      preferredInferenceApi: "openai-responses",
      source: "session",
    });
  });

  it("rejects a partial current registry route instead of mixing in stale session fields", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      provider: "compatible-endpoint",
      model: "current-model",
      endpointUrl: "https://current.example/v1",
      preferredInferenceApi: null,
    });
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(
      onboardSession.createSession({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "stale-model",
        endpointUrl: "https://stale.example/v1",
        preferredInferenceApi: "openai-completions",
      }),
    );

    expect(helpers().readRecordedInferenceRoute("alpha")).toBeNull();
  });

  it("rejects a partial registry row without completing it from live gateway output", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      provider: "compatible-endpoint",
      model: null,
      endpointUrl: "https://registry.example/v1",
      preferredInferenceApi: "openai-completions",
    });
    vi.spyOn(registry, "listSandboxes").mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha", provider: "compatible-endpoint" }],
    });
    const parseGatewayInference = vi.fn(() => ({
      provider: "compatible-endpoint",
      model: "gateway-model",
    }));
    const runCaptureOpenshell = vi.fn(() =>
      JSON.stringify({ provider: "compatible-endpoint", model: "gateway-model" }),
    );
    const recovery = createProviderRecoveryHelpers({
      parseGatewayInference,
      runCaptureOpenshell,
    });

    expect(recovery.readRecordedInferenceRoute("alpha")).toBeNull();
    expect(runCaptureOpenshell).not.toHaveBeenCalled();
    expect(parseGatewayInference).not.toHaveBeenCalled();
  });

  it("reports every other recorded endpoint for the same global provider", () => {
    vi.spyOn(registry, "listSandboxes").mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [
        { name: "alpha", provider: "compatible-endpoint", endpointUrl: "https://a.example/v1" },
        { name: "beta", provider: "compatible-endpoint", endpointUrl: "https://b.example/v1" },
        { name: "gamma", provider: "compatible-endpoint", endpointUrl: null },
        { name: "delta", provider: "openai-api", endpointUrl: "https://api.openai.com/v1" },
      ],
    });

    expect(helpers().readRecordedProviderEndpoints("compatible-endpoint", "alpha")).toEqual([
      "https://b.example/v1",
      "",
    ]);
  });
});
