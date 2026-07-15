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
import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

describe("uninstall OpenShell gateway user service", () => {
  it("removes the NemoClaw-managed user service even when OpenShell binaries are kept", () => {
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

  it("preserves a foreign service file at the NemoClaw service path", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-foreign-service-"));
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(tmpHome);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, "[Service]\nExecStart=/tmp/openshell-gateway\n");

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => false,
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
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
