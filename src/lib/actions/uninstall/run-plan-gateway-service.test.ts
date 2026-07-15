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

function writeManagedService(home: string): string {
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home);
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
  return servicePath;
}

function writeGatewayEnv(home: string): string {
  const envPath = path.join(home, ".config", "openshell", "gateway.env");
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, "OPENSHELL_SERVER_PORT=8080\n");
  return envPath;
}

describe("uninstall OpenShell gateway user service", () => {
  it("keeps OpenShell service and host gateway process when OpenShell is kept", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = writeManagedService(tmpHome);
    const envPath = writeGatewayEnv(tmpHome);
    const run = vi.fn((_command: string, _args: string[]) => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run,
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(fs.existsSync(envPath)).toBe(true);
      expect(run.mock.calls.map(([command, args]) => [command, ...args].join("\0"))).not.toContain(
        ["pgrep", "-f", HOST_GATEWAY_PGREP_PATTERN].join("\0"),
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("removes the NemoClaw-managed Linux user service on full uninstall", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = writeManagedService(tmpHome);
    const envPath = writeGatewayEnv(tmpHome);
    const runCalls: string[][] = [];

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
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
      expect(fs.existsSync(envPath)).toBe(false);
      expect(runCalls).toContainEqual([
        "systemctl",
        "--user",
        "disable",
        "--now",
        OPENSHELL_GATEWAY_USER_SERVICE,
      ]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("reports incomplete uninstall when disabling the service fails", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = writeManagedService(tmpHome);
    const errors: string[] = [];

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          error: (line) => errors.push(line),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn((command: string, args: string[]) =>
            command === "systemctl" && args.includes("disable")
              ? { status: 1, stdout: "", stderr: "failed\n" }
              : ok(),
          ),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(servicePath)).toBe(false);
      expect(errors).toContain(
        "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("reports incomplete uninstall when the managed service cannot be read", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = writeManagedService(tmpHome);
    const errors: string[] = [];
    const originalReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      target: fs.PathOrFileDescriptor,
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      return String(target) === servicePath
        ? (() => {
            throw new Error("permission denied");
          })()
        : (originalReadFileSync(target, options as never) as ReturnType<typeof fs.readFileSync>);
    }) as typeof fs.readFileSync);

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => true,
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          error: (line) => errors.push(line),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(errors).toContain(
        `Failed to read ${servicePath}; leaving gateway user service in place.`,
      );
      expect(errors).toContain(
        "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
      );
    } finally {
      readSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not remove Linux user service units on macOS", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-macos-service-"));
    const servicePath = writeManagedService(tmpHome);

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
});
