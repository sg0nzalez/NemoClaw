// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDockerGpuMode, type DockerGpuPatchResult } from "./docker-gpu-patch";
import { captureDockerGpuPreRollbackDiagnostics } from "./docker-gpu-pre-rollback-diagnostics";

function patchResult(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "old-container-id",
    newContainerId: "new-container-id",
    originalName: "openshell-alpha",
    backupContainerName: "backup-container",
    mode: buildDockerGpuMode("cdi"),
    backupRemoved: false,
  };
}

describe("Docker GPU pre-rollback diagnostics (#6110)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("captures the failed clone state, process topology, and logs before rollback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gpu-pre-rollback-"));
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "new-container-id\n";
      if (args[0] === "top" && args[1] === "new-container-id") {
        return "USER PID PPID STAT COMMAND\nsandbox 42 1 S nemoclaw-start\n";
      }
      if (args[0] === "inspect" && args[1] === "--format") {
        return JSON.stringify({ Status: "running", Running: true, ExitCode: 0 });
      }
      if (args[0] === "inspect" && args[1] === "new-container-id") {
        return JSON.stringify([
          {
            Id: "new-container-id",
            Config: { Image: "openshell/sandbox:test", Env: [] },
            HostConfig: { NetworkMode: "openshell-docker" },
            NetworkSettings: { Networks: { "openshell-docker": {} } },
          },
        ]);
      }
      return "";
    });
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      if (args[0] === "sandbox" && args[1] === "get") return "Phase: Error\n";
      if (args[0] === "sandbox" && args[1] === "list") return "alpha  Error\n";
      return "gateway reconnect log\n";
    });

    try {
      const diagnostics = captureDockerGpuPreRollbackDiagnostics("alpha", patchResult(), {
        dockerCapture,
        dockerLogs: vi.fn((target: string) =>
          target === "new-container-id" ? "failed clone log\n" : "",
        ),
        homedir: () => tmpDir,
        now: () => new Date("2026-07-01T23:00:00Z"),
        runCaptureOpenshell,
      });

      expect(diagnostics?.dir).toBeTruthy();
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "docker-top.txt"), "utf-8"),
      ).toContain("nemoclaw-start");
      expect(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "docker-logs.txt"), "utf-8"),
      ).toContain("failed clone log");
      expect(dockerCapture).toHaveBeenCalledWith(
        ["top", "new-container-id", "-eo", "user,pid,ppid,stat,args"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Pre-rollback diagnostics saved:"),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
