// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../src/lib/adapters/openshell/timeouts";

const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;
const modulePaths = {
  gatewayState: require.resolve("../src/lib/actions/sandbox/gateway-state"),
  gatewayTarget: require.resolve("../src/lib/actions/sandbox/gateway-target"),
  openshellRouting: require.resolve("../src/lib/adapters/openshell/sandbox-control-routing"),
  openshellRuntime: require.resolve("../src/lib/adapters/openshell/runtime"),
  shareDeps: require.resolve("../src/lib/share-command-deps"),
};

type ExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};

function installRuntime(options?: {
  captureResult?: { status: number | null; output: string };
  exec?: () => Promise<ExecResult>;
  gatewayName?: string;
}) {
  const captureResult = options?.captureResult ?? { status: 0, output: "ssh config" };
  const captureOpenshell = vi.fn(() => captureResult);
  const execSandboxReadOnlyWithGrpcFallback = vi.fn(
    options?.exec ?? (async () => ({ status: 0, stdout: "", stderr: "" })),
  );
  const getSandboxTargetGatewayName = vi.fn(() => options?.gatewayName ?? "nemoclaw-19080");

  requireCache[modulePaths.openshellRuntime] = {
    id: modulePaths.openshellRuntime,
    filename: modulePaths.openshellRuntime,
    loaded: true,
    exports: { captureOpenshell },
  } as any;
  requireCache[modulePaths.openshellRouting] = {
    id: modulePaths.openshellRouting,
    filename: modulePaths.openshellRouting,
    loaded: true,
    exports: { execSandboxReadOnlyWithGrpcFallback },
  } as any;
  requireCache[modulePaths.gatewayTarget] = {
    id: modulePaths.gatewayTarget,
    filename: modulePaths.gatewayTarget,
    loaded: true,
    exports: { getSandboxTargetGatewayName },
  } as any;
  requireCache[modulePaths.gatewayState] = {
    id: modulePaths.gatewayState,
    filename: modulePaths.gatewayState,
    loaded: true,
    exports: { ensureLiveSandboxOrExit: vi.fn(async () => undefined) },
  } as any;
  delete require.cache[modulePaths.shareDeps];

  const { buildShareCommandDeps } =
    require("../src/lib/share-command-deps") as typeof import("../src/lib/share-command-deps.js");
  return {
    captureOpenshell,
    deps: buildShareCommandDeps(),
    execSandboxReadOnlyWithGrpcFallback,
    getSandboxTargetGatewayName,
  };
}

describe("buildShareCommandDeps transport routing", () => {
  afterEach(() => {
    for (const modulePath of Object.values(modulePaths)) delete require.cache[modulePath];
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("captures SSH config from the sandbox's exact gateway", () => {
    const capturedResult = { status: 23, output: "ssh config failed" };
    const test = installRuntime({
      captureResult: capturedResult,
      gatewayName: "nemoclaw-19443",
    });

    expect(test.deps.getSshConfig("alpha")).toBe(capturedResult);
    expect(test.getSandboxTargetGatewayName).toHaveBeenCalledWith("alpha");
    expect(test.captureOpenshell).toHaveBeenCalledWith(
      ["--gateway", "nemoclaw-19443", "sandbox", "ssh-config", "alpha"],
      { ignoreError: true, timeout: OPENSHELL_PROBE_TIMEOUT_MS },
    );
  });

  it("rejects an ambient gateway endpoint before either share transport", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://payload.example.test");
    const test = installRuntime();

    expect(() => test.deps.getSshConfig("alpha")).toThrow(/OPENSHELL_GATEWAY_ENDPOINT is set/);
    expect(test.getSandboxTargetGatewayName).not.toHaveBeenCalled();
    expect(test.captureOpenshell).not.toHaveBeenCalled();
    await expect(test.deps.checkSandboxPathExists("alpha", "/sandbox")).resolves.toBe(false);
    expect(test.execSandboxReadOnlyWithGrpcFallback).not.toHaveBeenCalled();
  });

  it("routes the replay-safe path probe through gRPC for the exact gateway", async () => {
    const test = installRuntime({ gatewayName: "nemoclaw-19443" });

    await expect(test.deps.checkSandboxPathExists("alpha", "/sandbox")).resolves.toBe(true);
    expect(test.execSandboxReadOnlyWithGrpcFallback).toHaveBeenCalledWith("nemoclaw-19443", {
      sandboxName: "alpha",
      command: ["test", "-e", "/sandbox"],
      maxOutputBytes: 4096,
      timeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    expect(test.captureOpenshell).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing path", async () => ({ status: 1, stdout: "", stderr: "" })],
    [
      "a transport result",
      async () => ({ status: null, stdout: "", stderr: "", error: new Error("unavailable") }),
    ],
    [
      "a thrown configuration failure",
      async () => {
        throw new Error("configuration failed");
      },
    ],
  ])("reports false for %s", async (_label, exec) => {
    const test = installRuntime({ exec });

    await expect(test.deps.checkSandboxPathExists("alpha", "/sandbox/missing")).resolves.toBe(
      false,
    );
    expect(test.captureOpenshell).not.toHaveBeenCalled();
  });
});
