// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxEntry } from "../../state/registry";

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(() => ({ status: 0, output: "" })),
  captureOpenshellBinary: vi.fn(),
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(() => ({ status: 0 })),
}));
vi.mock("../../gateway-runtime-action", () => ({
  getNamedGatewayLifecycleState: vi.fn(() => ({ kind: "healthy_named" })),
}));
vi.mock("../../inference/local", () => ({
  findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
  probeLocalProviderHealth: vi.fn(() => ({ ok: true })),
}));
vi.mock("../../inference/ollama/proxy", () => ({
  ensureOllamaAuthProxy: vi.fn(() => true),
  probeOllamaAuthProxyHealth: vi.fn(() => ({ ok: true })),
}));
vi.mock("../../runner", () => ({
  ROOT: "/repo",
  runCapture: vi.fn(() => ({ status: 0, output: "" })),
  shellQuote: (value: string) => `'${value}'`,
}));
vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(),
  printGatewayLifecycleHint: vi.fn(),
}));

import {
  repairSandboxInferenceRouteWithDeps,
  type SandboxInferenceRouteProbe,
  type SandboxInferenceRouteRepairDeps,
} from "./connect";

const broken = (): SandboxInferenceRouteProbe => ({
  healthy: false,
  broken: true,
  detail: "BROKEN 503",
});
const inconclusive = (): SandboxInferenceRouteProbe => ({
  healthy: false,
  broken: false,
  detail: "openshell sandbox exec exited with status 7",
});

function sandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "demo",
    model: "nvidia/nemotron-3-super-120b-a12b",
    provider: "nvidia-prod",
    gpuEnabled: false,
    policies: [],
    ...overrides,
  };
}

function makeRepairDeps(probes: SandboxInferenceRouteProbe[]) {
  const queue = [...probes];
  const deps: SandboxInferenceRouteRepairDeps = {
    probe: vi.fn(() => queue.shift() ?? broken()),
    shouldApplyVmDnsMonkeypatch: vi.fn(() => false),
    applyVmDnsMonkeypatch: vi.fn(() => ({ ok: false })),
    log: vi.fn(),
    error: vi.fn(),
  };
  return deps;
}

describe("sandbox connect inconclusive route repair", () => {
  it("fails closed without repair when the initial probe is inconclusive (#6192)", () => {
    const deps = makeRepairDeps([inconclusive()]);

    const result = repairSandboxInferenceRouteWithDeps("demo", sandbox(), {}, deps);

    expect(result).toEqual({
      healthy: false,
      repairAttempted: false,
      detail: "openshell sandbox exec exited with status 7",
    });
  });
});
