// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectSandboxCreateFailureDiagnostics,
  handleNonzeroSandboxCreateResult,
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
    fs.writeFileSync(consolePath, "vm console detail\n");
    fs.writeFileSync(
      gatewayLogPath,
      [
        "old unrelated line",
        `2026-05-12T20:30:56Z INFO vm driver: create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant`,
        `2026-05-12T20:30:56Z INFO vm driver: resolved image ref, preparing rootfs sandbox_id=${sandboxId} state_dir=${stateDir}`,
        `2026-05-12T20:34:28Z INFO vm driver: spawning VM launcher sandbox_id=${sandboxId} console_output=${consolePath}`,
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
    expect(fs.readFileSync(path.join(diagnostics!.dir, "rootfs-console.log"), "utf-8")).toContain(
      "vm console detail",
    );
    const relevant = fs.readFileSync(
      path.join(diagnostics!.dir, "openshell-gateway-relevant.log"),
      "utf-8",
    );
    expect(relevant).toContain("VmCreate");
    expect(relevant).toContain("sandbox_name=my-assistant");
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
        "2026-05-12T20:30:01Z WARN gateway exited before request dispatch",
      ].join("\n"),
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      now: new Date("2026-05-12T20:35:00.000Z"),
    });

    expect(diagnostics?.gatewayTailPath).toBe(
      path.join(diagnostics!.dir, "openshell-gateway-tail.log"),
    );
    expect(fs.readFileSync(diagnostics!.gatewayTailPath!, "utf-8")).toContain(
      "gateway exited before request dispatch",
    );
    expect(diagnostics?.summaryLines).toContain(
      "2026-05-12T20:30:01Z WARN gateway exited before request dispatch",
    );
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "gateway_tail=",
    );
  });
});

describe("sandbox create failure handling", () => {
  it("does not delete an existing sandbox when hard-required Landlock fails before gateway upload", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-handle-"));
    const messages: string[] = [];
    const deleteCalls: string[][] = [];
    const originalError = console.error;
    const originalHome = process.env.HOME;
    console.error = (message?: unknown) => {
      messages.push(String(message ?? ""));
    };
    process.env.HOME = tmp;

    try {
      expect(() =>
        handleNonzeroSandboxCreateResult({
          createResult: {
            status: 1,
            output:
              "Landlock unavailable in hard_requirement mode: not enabled in the active LSM set",
          },
          sandboxName: "dcode-landlock-precreate",
          runOpenshell: (args) => {
            deleteCalls.push(args);
            return { status: 0 };
          },
          exit: (code) => {
            throw new Error(`exit:${String(code)}`);
          },
        }),
      ).toThrow("exit:1");

      expect(deleteCalls).toEqual([]);
      expect(messages).not.toContain(
        "  The failed sandbox has been removed; retry will recreate it.",
      );
    } finally {
      console.error = originalError;
      originalHome === undefined ? delete process.env.HOME : (process.env.HOME = originalHome);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes a failed sandbox when hard-required Landlock output proves gateway creation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-created-"));
    const messages: string[] = [];
    const deleteCalls: string[][] = [];
    const originalError = console.error;
    const originalHome = process.env.HOME;
    console.error = (message?: unknown) => {
      messages.push(String(message ?? ""));
    };
    process.env.HOME = tmp;

    try {
      expect(() =>
        handleNonzeroSandboxCreateResult({
          createResult: {
            status: 1,
            output:
              "Created sandbox: dcode-landlock-created\n" +
              "Landlock unavailable in hard_requirement mode: not enabled in the active LSM set",
          },
          sandboxName: "dcode-landlock-created",
          runOpenshell: (args) => {
            deleteCalls.push(args);
            return { status: 0 };
          },
          exit: (code) => {
            throw new Error(`exit:${String(code)}`);
          },
        }),
      ).toThrow("exit:1");

      expect(deleteCalls).toEqual([["sandbox", "delete", "dcode-landlock-created"]]);
      expect(messages).toContain("  The failed sandbox has been removed; retry will recreate it.");
    } finally {
      console.error = originalError;
      originalHome === undefined ? delete process.env.HOME : (process.env.HOME = originalHome);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not delete the requested sandbox when Landlock output names a different created sandbox", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-other-"));
    const messages: string[] = [];
    const deleteCalls: string[][] = [];
    const originalError = console.error;
    const originalHome = process.env.HOME;
    console.error = (message?: unknown) => {
      messages.push(String(message ?? ""));
    };
    process.env.HOME = tmp;

    try {
      expect(() =>
        handleNonzeroSandboxCreateResult({
          createResult: {
            status: 1,
            output:
              "Created sandbox: other-dcode\n" +
              "Landlock unavailable in hard_requirement mode: not enabled in the active LSM set",
          },
          sandboxName: "dcode-landlock-current",
          runOpenshell: (args) => {
            deleteCalls.push(args);
            return { status: 0 };
          },
          exit: (code) => {
            throw new Error(`exit:${String(code)}`);
          },
        }),
      ).toThrow("exit:1");

      expect(deleteCalls).toEqual([]);
      expect(messages).not.toContain(
        "  The failed sandbox has been removed; retry will recreate it.",
      );
    } finally {
      console.error = originalError;
      originalHome === undefined ? delete process.env.HOME : (process.env.HOME = originalHome);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("waits for readiness after an incomplete non-Landlock create stream", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message ?? ""));
    };

    try {
      const action = handleNonzeroSandboxCreateResult({
        createResult: {
          status: 255,
          output: "Created sandbox: dcode-stream\nssh: connection closed",
        },
        sandboxName: "dcode-stream",
        runOpenshell: () => {
          throw new Error("delete should not run for incomplete create streams");
        },
        exit: (code) => {
          throw new Error(`unexpected exit:${String(code)}`);
        },
      });

      expect(action).toBe("wait_for_ready");
      expect(warnings).toContain("  Checking whether the sandbox reaches Ready state...");
    } finally {
      console.warn = originalWarn;
    }
  });
});
