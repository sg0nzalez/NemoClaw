// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  OnboardDashboardDeps,
  OnboardDashboardHelpers,
} from "../src/lib/onboard/dashboard";

const { getPortConflictServiceHints } = require("../dist/lib/onboard") as {
  getPortConflictServiceHints: (platform?: string) => string[];
};
const { createOnboardDashboardHelpers } = require("../dist/lib/onboard/dashboard") as {
  createOnboardDashboardHelpers: (deps: OnboardDashboardDeps) => OnboardDashboardHelpers;
};
const { listForwardStates, writeForwardState } = require("../dist/lib/adapters/openshell/forward-bridge-state") as {
  listForwardStates: () => Array<{
    sandboxName: string;
    bind: string;
    port: number;
    targetHost: string;
    targetPort: number;
    pid: number;
    startedAt: string;
  }>;
  writeForwardState: (state: {
    sandboxName: string;
    bind: string;
    port: number;
    targetHost: string;
    targetPort: number;
    pid: number;
    startedAt: string;
  }) => void;
};

describe("onboard dashboard helpers", () => {
  it("prints platform-appropriate service hints for port conflicts", () => {
    expect(getPortConflictServiceHints("darwin").join("\n")).toMatch(/launchctl unload/);
    expect(getPortConflictServiceHints("darwin").join("\n")).not.toMatch(/systemctl --user/);
    expect(getPortConflictServiceHints("linux").join("\n")).toMatch(
      /systemctl --user stop openclaw-gateway.service/,
    );
  });

  it("uses sandbox-scoped forward stops for same-sandbox dashboard cleanup", () => {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dashboard-forward-state-"));
    process.env.HOME = home;
    writeForwardState({
      sandboxName: "my-sandbox",
      bind: "127.0.0.1",
      port: 18789,
      targetHost: "127.0.0.1",
      targetPort: 18789,
      pid: 0,
      startedAt: new Date().toISOString(),
    });
    writeForwardState({
      sandboxName: "my-sandbox",
      bind: "127.0.0.1",
      port: 19000,
      targetHost: "127.0.0.1",
      targetPort: 19000,
      pid: 0,
      startedAt: new Date().toISOString(),
    });
    const runOpenshell = vi.fn((_args: string[], _opts?: Record<string, unknown>) => ({
      status: 0,
    }));
    const runCaptureOpenshell = vi.fn(() => "");
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell,
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
    });

    try {
      expect(helpers.ensureDashboardForward("my-sandbox", "http://127.0.0.1:18789")).toBe(18789);
      expect(runOpenshell).not.toHaveBeenCalledWith(
        expect.arrayContaining(["forward", "stop"]),
        expect.anything(),
      );
      expect(listForwardStates()).toMatchObject([
        {
          sandboxName: "my-sandbox",
          port: 18789,
          targetPort: 18789,
        },
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("keeps the sandbox dashboard target port separate from the reallocated host port", () => {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dashboard-target-port-"));
    process.env.HOME = home;
    const helpers = createOnboardDashboardHelpers({
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => ""),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      resolveSandboxDashboardTargetPort: vi.fn(() => 18789),
      printAgentDashboardUi: vi.fn(),
    });

    try {
      const hostPort = helpers.ensureDashboardForward("my-sandbox", "http://127.0.0.1:18790");
      const state = listForwardStates().find((entry) => entry.sandboxName === "my-sandbox");
      expect(state).toMatchObject({
        port: hostPort,
        targetPort: 18789,
      });
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("prints the dashboard-url command instead of raw gateway-token guidance", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const nimStatus = vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" }));
    const shouldShowNimLine = vi.fn(() => false);
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => ""),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus,
      shouldShowNimLine,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      fetchGatewayAuthTokenFromSandbox: vi.fn(() => "secret-token"),
      printAgentDashboardUi: vi.fn(),
    });

    let output = "";
    try {
      helpers.printDashboard("my-gpt-claw", "gpt-oss:20b", "ollama");
      output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toContain("NemoClaw is ready");
    expect(output.indexOf("Start chatting")).toBeLessThan(output.indexOf("Manage later"));
    expect(output).toMatch(/Browser:\n\s+https?:\/\/\S+/);
    expect(output).toContain("Authenticated dashboard URL, if needed:");
    expect(output).toContain("nemoclaw my-gpt-claw dashboard-url --quiet");
    expect(output).not.toContain("#token=");
    expect(output).not.toContain("gateway-token --quiet");
    expect(output).not.toContain("append  #token=<token>");
    expect(output).not.toMatch(/secret[-_]?token/);
    expect(nimStatus).toHaveBeenCalledWith("my-gpt-claw");
  });

  it("prints a token-free browser URL when the dashboard token is unavailable", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const note = vi.fn();
    const helpers = createOnboardDashboardHelpers({
      runOpenshell: vi.fn(() => ({ status: 1 })),
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => ""),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
      shouldShowNimLine: vi.fn(() => false),
      note,
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
    });

    let output = "";
    try {
      helpers.printDashboard("my-gpt-claw", "gpt-oss:20b", "ollama");
      output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(note).toHaveBeenCalledWith("  Could not read gateway token from the sandbox (download failed).");
    expect(output).toMatch(/Browser:\n\s+https?:\/\/\S+/);
    expect(output).not.toContain("#token=");
    expect(output).not.toContain("dashboard-url --quiet");
    expect(output).toContain("then run: openclaw tui");
  });
});
