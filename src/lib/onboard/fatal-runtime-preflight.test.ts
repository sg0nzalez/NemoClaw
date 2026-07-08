// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostAssessment } from "./preflight";
import { rejectUnsupportedContainerRuntime } from "./fatal-runtime-preflight";

const podmanHost = {
  runtime: "podman",
} as HostAssessment;

describe("fatal runtime preflight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps Podman rejected on the default Docker gateway runtime", () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });

    expect(() => rejectUnsupportedContainerRuntime(podmanHost, exitProcess)).toThrow("exit 1");
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it("allows Podman when the Podman gateway runtime is explicitly selected", () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });

    rejectUnsupportedContainerRuntime(podmanHost, exitProcess);

    expect(exitProcess).not.toHaveBeenCalled();
  });
});
