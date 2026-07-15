// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectSandboxCreateFailureDiagnostics,
  printSandboxCreateFailureDiagnostics,
} from "../src/lib/onboard/sandbox-create-failure.js";

function permissionMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

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
    const rawSecrets = ["secret-token", "nvapi-secret", "session-secret"];
    fs.writeFileSync(
      consolePath,
      [
        "vm console detail",
        "Authorization: Bearer secret-token",
        "NVIDIA_API_KEY=nvapi-secret",
      ].join("\n"),
    );
    fs.writeFileSync(
      gatewayLogPath,
      [
        "old unrelated line",
        `2026-05-12T20:30:56Z INFO vm driver: create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant`,
        `2026-05-12T20:30:56Z INFO vm driver: resolved image ref, preparing rootfs sandbox_id=${sandboxId} state_dir=${stateDir}`,
        `2026-05-12T20:34:28Z INFO vm driver: spawning VM launcher sandbox_id=${sandboxId} console_output=${consolePath}`,
        `2026-05-12T20:34:28Z ERROR supervisor sandbox_id=${sandboxId} Authorization: Bearer secret-token`,
        `2026-05-12T20:34:28Z ERROR supervisor sandbox_id=${sandboxId} Cookie: session=session-secret`,
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
    const copiedConsolePath = path.join(diagnostics!.dir, "rootfs-console.log");
    const relevantPath = path.join(diagnostics!.dir, "openshell-gateway-relevant.log");
    const summaryPath = path.join(diagnostics!.dir, "summary.txt");
    const copiedConsole = fs.readFileSync(copiedConsolePath, "utf-8");
    expect(copiedConsole).toContain("vm console detail");
    expect(copiedConsole).toContain("Bearer <REDACTED>");
    expect(copiedConsole).not.toContain("secret-token");
    const relevant = fs.readFileSync(relevantPath, "utf-8");
    expect(relevant).toContain("VmCreate");
    expect(relevant).toContain("sandbox_name=my-assistant");
    expect(relevant).toContain("Bearer <REDACTED>");
    const summary = fs.readFileSync(summaryPath, "utf-8");
    expect(summary).toContain("backup_path=/tmp/pre-upgrade-backup");
    for (const secret of rawSecrets) {
      expect(copiedConsole).not.toContain(secret);
      expect(relevant).not.toContain(secret);
      expect(summary).not.toContain(secret);
      expect(diagnostics?.summaryLines.join("\n")).not.toContain(secret);
    }
    expect(permissionMode(diagnostics!.dir)).toBe(0o700);
    for (const artifactPath of [copiedConsolePath, relevantPath, summaryPath]) {
      expect(permissionMode(artifactPath), artifactPath).toBe(0o600);
    }
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
    expect(permissionMode(diagnostics!.gatewayTailPath!)).toBe(0o600);
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "gateway_tail=",
    );
  });
});
