// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  getNemoclawOpenShellGatewayUserServicePath,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  OPENSHELL_GATEWAY_USER_SERVICE,
} from "../../onboard/docker-driver-gateway-service";
import { HOST_GATEWAY_PGREP_PATTERN } from "../../onboard/host-gateway-process";
import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

describe("uninstall OpenShell gateway user service", () => {
  it("keeps the NemoClaw-managed user service when OpenShell binaries are kept", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(tmpHome);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      [
        "# NemoClaw-managed OpenShell gateway user service",
        `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
        "[Service]",
        "ExecStart=/home/test/.local/bin/openshell-gateway",
        "",
      ].join("\n"),
    );
    const logs: string[] = [];
    const runCalls: string[][] = [];

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: (command) => command === "systemctl",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: (line) => logs.push(line),
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn((command: string, args: string[]) => {
            runCalls.push([command, ...args]);
            return ok();
          }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(runCalls).toEqual([]);
      expect(logs).not.toContain(`Removed ${servicePath}`);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps the host OpenShell gateway process when OpenShell is kept", () => {
    const gatewayPid = 9999887;
    const killed: number[] = [];
    const run = vi.fn((_command: string, _args: string[]) => ok());

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-uninstall-test-keep-openshell" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: (pid) => {
          killed.push(pid);
          return true;
        },
        rmSync: vi.fn(),
        run,
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(killed).not.toContain(gatewayPid);
    expect(run.mock.calls.map(([command, args]) => [command, ...args].join("\0"))).not.toContain(
      ["pgrep", "-f", HOST_GATEWAY_PGREP_PATTERN].join("\0"),
    );
  });

  it("removes the NemoClaw-managed user service when OpenShell is removed", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(tmpHome);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      [
        "# NemoClaw-managed OpenShell gateway user service",
        `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
        "[Service]",
        "ExecStart=/home/test/.local/bin/openshell-gateway",
        "",
      ].join("\n"),
    );
    const logs: string[] = [];
    const runCalls: string[][] = [];

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: (line) => logs.push(line),
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn((command: string, args: string[]) => {
            runCalls.push([command, ...args]);
            return ok();
          }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(false);
      expect(runCalls).toContainEqual([
        "systemctl",
        "--user",
        "disable",
        "--now",
        OPENSHELL_GATEWAY_USER_SERVICE,
      ]);
      expect(runCalls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
      expect(logs).toContain(`Removed ${servicePath}`);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("removes the NemoClaw-managed user service from XDG_CONFIG_HOME", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const xdgConfigHome = path.join(tmpHome, "xdg-config");
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(tmpHome, xdgConfigHome);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      [
        "# NemoClaw-managed OpenShell gateway user service",
        `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
        "[Service]",
        "ExecStart=/home/test/.local/bin/openshell-gateway",
        "",
      ].join("\n"),
    );

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env: { HOME: tmpHome, XDG_CONFIG_HOME: xdgConfigHome } as NodeJS.ProcessEnv,
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("reports an incomplete uninstall when the service cannot be disabled", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(tmpHome);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      [
        "# NemoClaw-managed OpenShell gateway user service",
        `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
        "[Service]",
        "ExecStart=/home/test/.local/bin/openshell-gateway",
        "",
      ].join("\n"),
    );
    const warnings: string[] = [];
    const errors: string[] = [];
    const runResults = new Map<string, RunResult>([
      [
        ["systemctl", "--user", "disable", "--now", OPENSHELL_GATEWAY_USER_SERVICE].join("\0"),
        { status: 1, stdout: "", stderr: "failed\n" },
      ],
    ]);

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          error: (line) => {
            warnings.push(line);
            errors.push(line);
          },
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn((command: string, args: string[]) => {
            return runResults.get([command, ...args].join("\0")) ?? ok();
          }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(servicePath)).toBe(false);
      expect(warnings).toContain(`Failed to disable ${OPENSHELL_GATEWAY_USER_SERVICE}.service`);
      expect(errors).toContain(
        "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("preserves a foreign service file at the NemoClaw service path", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-foreign-service-"));
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(tmpHome);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      [
        "# not NemoClaw-owned",
        `# not ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
        "[Service]",
        "ExecStart=/tmp/openshell-gateway",
        "",
      ].join("\n"),
    );

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => false,
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not remove Linux user service units on macOS", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-macos-service-"));
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(tmpHome);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      [
        "# NemoClaw-managed OpenShell gateway user service",
        `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
        "",
      ].join("\n"),
    );
    const run = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => true,
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "darwin",
          rmSync: fs.rmSync,
          run,
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(run).not.toHaveBeenCalledWith(
        "systemctl",
        expect.arrayContaining(["disable"]),
        expect.anything(),
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
