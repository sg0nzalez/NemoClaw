// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { listScenarios } from "../scenarios/registry.ts";
import { liveScenarioSupport } from "../scenarios/runtime-support.ts";

describe("live Vitest registry discovery support", () => {
  it("classifies every typed registry scenario", () => {
    const scenarios = listScenarios();

    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      const support = liveScenarioSupport(scenario);
      expect(support.supported || support.reasons.length > 0).toBe(true);
    }
  });

  it("wires the canonical Ubuntu cloud OpenClaw path through phase fixtures", () => {
    const scenario = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");

    expect(scenario).toBeTruthy();
    expect(liveScenarioSupport(scenario!).supported).toBe(true);
    expect(liveScenarioSupport(scenario!).pendingRuntimeSuites).toEqual([
      "smoke",
      "inference",
      "credentials",
    ]);
  });

  it("keeps unsupported onboarding profiles skipped with a concrete reason", () => {
    const scenario = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-hermes");

    expect(scenario).toBeTruthy();
    expect(liveScenarioSupport(scenario!)).toMatchObject({
      supported: false,
      reasons: ["onboarding 'cloud-hermes' is not wired for live Vitest fixtures"],
    });
  });

  it("wires the smoke/onboarding migration family through phase fixtures", () => {
    const supportedIds = [
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-no-docker-preflight-negative",
      "ubuntu-repo-cloud-openclaw-resume",
      "ubuntu-repo-cloud-openclaw-repair",
      "ubuntu-repo-cloud-openclaw-double-same-provider",
      "ubuntu-repo-cloud-openclaw-custom-policies",
      "ubuntu-invalid-nvidia-key-negative",
      "ubuntu-gateway-port-conflict-negative",
    ];

    for (const id of supportedIds) {
      const scenario = listScenarios().find((entry) => entry.id === id);
      expect(scenario, `${id} must exist`).toBeTruthy();
      expect(liveScenarioSupport(scenario!), `${id} should be live-supported`).toMatchObject({
        supported: true,
        reasons: [],
      });
    }
  });

  it("keeps provider-switch onboarding skipped until inference fixtures own it", () => {
    const scenario = listScenarios().find(
      (entry) => entry.id === "ubuntu-repo-cloud-openclaw-double-provider-switch",
    );

    expect(scenario).toBeTruthy();
    expect(liveScenarioSupport(scenario!)).toMatchObject({
      supported: false,
      reasons: [
        "onboarding 'cloud-nvidia-openclaw-double-provider-switch' is not wired for live Vitest fixtures",
      ],
    });
  });

  it("keeps docker-missing scenarios skipped unless the executable onboarding profile is wired", () => {
    const base = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-hermes");
    expect(base).toBeTruthy();
    const scenario = {
      ...base!,
      id: "synthetic-docker-missing-hermes",
      environment: {
        ...base!.environment!,
        runtime: "docker-missing",
        onboarding: "cloud-hermes",
      },
      expectedStateId: "preflight-failure-no-sandbox",
    };

    expect(liveScenarioSupport(scenario)).toMatchObject({
      supported: false,
      reasons: ["onboarding 'cloud-hermes-no-docker' is not wired for live Vitest fixtures"],
    });
  });

  it("keeps unwhitelisted lifecycle profiles skipped with the lifecycle reason", () => {
    const scenario = listScenarios().find((entry) => entry.id === "ubuntu-rebuild-openclaw");

    expect(scenario).toBeTruthy();
    expect(liveScenarioSupport(scenario!)).toMatchObject({
      supported: false,
      reasons: ["lifecycle 'rebuild-current-version' is not wired for live Vitest fixtures"],
    });
  });

  it("accepts the whitelisted post-reboot-recovery lifecycle scenario", () => {
    const scenario = listScenarios().find(
      (entry) => entry.id === "ubuntu-repo-docker-post-reboot-recovery",
    );

    expect(scenario).toBeTruthy();
    expect(scenario!.environment?.lifecycle).toBe("post-reboot-recovery");
    expect(liveScenarioSupport(scenario!)).toMatchObject({
      supported: true,
      reasons: [],
    });
  });
});
