// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  cleanupLandlockSandboxAfterCreateFailure,
  collectSandboxCreateFailureDiagnostics,
  printSandboxCreateFailureDiagnostics,
} from "../src/lib/onboard/sandbox-create-failure.js";

describe("sandbox create failure diagnostics", () => {
  it("preserves gateway failure lines and VM console output before cleanup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const sandboxId = "691344ae-f514-41c1-b29e-db7f2f7ef257";
    const stateDir = path.join(logDir, "vm-driver", "sandboxes", sandboxId);
    const consolePath = path.join(stateDir, "rootfs-console.log");
    const gatewayLogPath = path.join(logDir, "openshell-gateway.log");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(consolePath, "vm console detail\nAuthorization: Bearer secret-token\n");
    fs.writeFileSync(
      gatewayLogPath,
      [
        "old unrelated line",
        `2026-05-12T20:30:56Z INFO vm driver: create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant`,
        `2026-05-12T20:30:56Z INFO vm driver: resolved image ref, preparing rootfs sandbox_id=${sandboxId} state_dir=${stateDir}`,
        `2026-05-12T20:34:28Z INFO vm driver: spawning VM launcher sandbox_id=${sandboxId} console_output=${consolePath}`,
        `2026-05-12T20:34:28Z ERROR supervisor sandbox_id=${sandboxId} Authorization: Bearer secret-token`,
        "[2026-05-12T20:34:29Z ERROR krun] Building the microVM failed: Internal(Vm(VmSetup(VmCreate)))",
        `2026-05-12T20:34:29Z WARN Sandbox failed to become ready sandbox_id=${sandboxId} sandbox_name=my-assistant reason=ProcessExited`,
      ].join("\n"),
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      backupPath: "/tmp/pre-upgrade-backup",
      now: new Date("2026-05-12T20:35:00.000Z"),
    });

    expect(diagnostics?.sandboxId).toBe(sandboxId);
    expect(diagnostics?.copiedConsoleOutput).toBe(
      path.join(diagnostics!.dir, "rootfs-console.log"),
    );
    const copiedConsole = fs.readFileSync(
      path.join(diagnostics!.dir, "rootfs-console.log"),
      "utf-8",
    );
    expect(copiedConsole).toContain("vm console detail");
    expect(copiedConsole).toContain("Bearer <REDACTED>");
    expect(copiedConsole).not.toContain("secret-token");
    const relevant = fs.readFileSync(
      path.join(diagnostics!.dir, "openshell-gateway-relevant.log"),
      "utf-8",
    );
    expect(relevant).toContain("VmCreate");
    expect(relevant).toContain("sandbox_name=my-assistant");
    expect(relevant).toContain("Bearer <REDACTED>");
    expect(relevant).not.toContain("secret-token");
    expect(diagnostics?.summaryLines.join("\n")).not.toContain("secret-token");
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "backup_path=/tmp/pre-upgrade-backup",
    );
  });

  it("prints saved diagnostics and retained backup details", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-print-"));
    const homeDir = path.join(tmp, "home");
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      messages.push(String(message ?? ""));
    };

    try {
      const diagnostics = printSandboxCreateFailureDiagnostics("my-assistant", {
        homeDir,
        backupPath: "/tmp/pre-upgrade-backup",
        now: new Date("2026-05-12T20:35:00.000Z"),
      });

      expect(diagnostics?.dir).toContain(path.join(homeDir, ".nemoclaw", "onboard-failures"));
      expect(messages).toContain(`  Diagnostics saved: ${diagnostics!.dir}`);
      expect(messages).toContain("  State backup retained: /tmp/pre-upgrade-backup");
    } finally {
      console.error = originalError;
    }
  });

  it("preserves a bounded gateway tail when sandbox-specific lines are absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-tail-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const gatewayLogPath = path.join(logDir, "openshell-gateway.log");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      gatewayLogPath,
      [
        "2026-05-12T20:30:00Z INFO gateway starting",
        "2026-05-12T20:30:01Z WARN gateway exited before request dispatch Authorization: Bearer secret-token",
      ].join("\n"),
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      now: new Date("2026-05-12T20:35:00.000Z"),
    });

    expect(diagnostics?.gatewayTailPath).toBe(
      path.join(diagnostics!.dir, "openshell-gateway-tail.log"),
    );
    const gatewayTail = fs.readFileSync(diagnostics!.gatewayTailPath!, "utf-8");
    expect(gatewayTail).toContain("gateway exited before request dispatch");
    expect(gatewayTail).toContain("Bearer <REDACTED>");
    expect(gatewayTail).not.toContain("secret-token");
    expect(
      diagnostics?.summaryLines.some((line) =>
        line.includes("gateway exited before request dispatch"),
      ),
    ).toBe(true);
    expect(diagnostics?.summaryLines.join("\n")).not.toContain("secret-token");
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "gateway_tail=",
    );
  });
});

describe("sandbox create failure handling", () => {
  it("does not delete an existing sandbox when hard-required Landlock fails before gateway upload", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    cleanupLandlockSandboxAfterCreateFailure({
      failureKind: "landlock_enforcement_failed",
      createOutput:
        "Landlock unavailable in hard_requirement mode: not enabled in the active LSM set",
      sandboxName: "dcode-landlock-precreate",
      runOpenshell,
    });

    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("removes a failed sandbox when hard-required Landlock output proves gateway creation", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    cleanupLandlockSandboxAfterCreateFailure({
      failureKind: "landlock_enforcement_failed",
      createOutput:
        "Created sandbox: dcode-landlock-created\n" +
        "Landlock unavailable in hard_requirement mode: not enabled in the active LSM set",
      sandboxName: "dcode-landlock-created",
      runOpenshell,
    });

    expect(runOpenshell).toHaveBeenCalledWith(["sandbox", "delete", "dcode-landlock-created"], {
      ignoreError: true,
    });
  });

  it("does not delete the requested sandbox when Landlock output names a different created sandbox", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    cleanupLandlockSandboxAfterCreateFailure({
      failureKind: "landlock_enforcement_failed",
      createOutput:
        "Created sandbox: other-dcode\n" +
        "Landlock unavailable in hard_requirement mode: not enabled in the active LSM set",
      sandboxName: "dcode-landlock-current",
      runOpenshell,
    });

    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("does not delete for a non-Landlock failure even with exact create evidence", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    cleanupLandlockSandboxAfterCreateFailure({
      failureKind: "unknown",
      createOutput: "Created sandbox: dcode-landlock-current\nprovider setup failed",
      sandboxName: "dcode-landlock-current",
      runOpenshell,
    });

    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("keeps a throwing delete runner on the manual-cleanup path", () => {
    const runOpenshell = vi.fn(() => {
      throw new Error("gateway unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    cleanupLandlockSandboxAfterCreateFailure({
      failureKind: "landlock_enforcement_failed",
      createOutput:
        "Created sandbox: dcode-landlock-current\n" +
        "Landlock unavailable in hard_requirement mode: not enabled in the active LSM set",
      sandboxName: "dcode-landlock-current",
      runOpenshell,
    });

    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("  Could not remove the failed sandbox. Manual cleanup:");
    expect(error).toHaveBeenCalledWith('    openshell sandbox delete "dcode-landlock-current"');
    error.mockRestore();
  });
});
