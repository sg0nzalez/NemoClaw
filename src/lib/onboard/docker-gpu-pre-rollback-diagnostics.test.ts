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
    const secretCanary = "pre-rollback-secret-canary-value";
    const inspectOutput = JSON.stringify([
      {
        Id: "new-container-id",
        Name: "/openshell-alpha",
        Config: {
          Image: "openshell/sandbox:test",
          Cmd: null,
          Env: [
            `OPENSHELL_SANDBOX_COMMAND=env NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=CUSTOM_PROVIDER_CREDENTIAL CUSTOM_PROVIDER_CREDENTIAL=${secretCanary} nemoclaw-start`,
          ],
          Labels: {
            "openshell.ai/sandbox-name": "alpha",
            "untrusted.secret": secretCanary,
          },
        },
        HostConfig: { NetworkMode: "openshell-docker" },
        NetworkSettings: { Networks: { "openshell-docker": {} } },
      },
    ]);
    const dockerResponses = new Map([
      ["ps -a", "new-container-id\n"],
      ["top new-container-id", "USER PID PPID STAT COMMAND\nsandbox 42 1 S nemoclaw-start\n"],
      ["inspect --format", JSON.stringify({ Status: "running", Running: true, ExitCode: 0 })],
      ["inspect new-container-id", inspectOutput],
    ]);
    const dockerCapture = vi.fn((args: readonly string[], _options?: Record<string, unknown>) => {
      return dockerResponses.get(`${args[0] ?? ""} ${args[1] ?? ""}`.trim()) ?? "";
    });
    const openshellResponses = new Map([
      ["sandbox get", "Phase: Error\n"],
      ["sandbox list", "alpha  Error\n"],
    ]);
    const runCaptureOpenshell = vi.fn(
      (args: string[]) =>
        openshellResponses.get(`${args[0] ?? ""} ${args[1] ?? ""}`.trim()) ??
        `gateway reconnect log ${secretCanary}\n`,
    );

    try {
      const diagnostics = captureDockerGpuPreRollbackDiagnostics("alpha", patchResult(), {
        dockerCapture,
        dockerLogs: vi.fn((target: string) =>
          target === "new-container-id" ? `failed clone log ${secretCanary}\n` : "",
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
      ).toContain("failed clone log <REDACTED>");
      const inspect = JSON.parse(
        fs.readFileSync(path.join(diagnostics?.dir ?? "", "docker-inspect.json"), "utf-8"),
      );
      expect(inspect[0]).toMatchObject({
        Id: "new-container-id",
        Config: {
          Image: "openshell/sandbox:test",
          Cmd: null,
          Env: ["OPENSHELL_SANDBOX_COMMAND=<REDACTED>"],
        },
        HostConfig: { NetworkMode: "openshell-docker" },
      });
      const diagnosticContents = fs
        .readdirSync(diagnostics?.dir ?? "")
        .map((name) => fs.readFileSync(path.join(diagnostics?.dir ?? "", name), "utf-8"))
        .join("\n");
      expect(diagnosticContents).not.toContain(secretCanary);
      expect(diagnosticContents).not.toContain("untrusted.secret");
      expect(dockerCapture).toHaveBeenCalledWith(
        ["top", "new-container-id", "-eo", "user,pid,ppid,stat,comm"],
        expect.objectContaining({ ignoreError: true, timeout: expect.any(Number) }),
      );
      for (const [, options] of dockerCapture.mock.calls) {
        expect(Number(options?.timeout)).toBeLessThanOrEqual(2_000);
      }
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Pre-rollback diagnostics saved:"),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
