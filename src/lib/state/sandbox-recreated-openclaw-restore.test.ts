// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SandboxExecRequest } from "../adapters/openshell/sandbox-control.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  getSandbox: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("../adapters/openshell/sandbox-control-routing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/sandbox-control-routing.js")>()),
  execSandboxReadOnlyWithGrpcFallback: async (
    _gateway: string,
    request: Parameters<typeof mocks.exec>[0],
  ) => mocks.exec(request),
  selectOpenShellSandboxControlForMutation: () => ({
    control: { exec: mocks.exec },
    transport: "grpc",
    close: () => {},
  }),
}));

vi.mock("../adapters/openshell/sandbox-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/sandbox-upload.js")>()),
  uploadSandboxPayloadFile: mocks.upload,
}));

vi.mock("./registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry.js")>()),
  getSandbox: mocks.getSandbox,
}));

import type { OpenClawImagePluginInstall } from "./openclaw-plugin-restore.js";
import { restoreRecreatedSandboxState } from "./sandbox.js";

const OPENCLAW_DIR = "/sandbox/.openclaw";

function imageInstall(id: string, extensionDir: string): OpenClawImagePluginInstall {
  const installPath = `${OPENCLAW_DIR}/extensions/${extensionDir}`;
  return { id, installPath, loadPaths: [installPath] };
}

function extensionDir(install: OpenClawImagePluginInstall): string | null {
  const prefix = `${OPENCLAW_DIR}/extensions/`;
  return install.installPath.startsWith(prefix) ? install.installPath.slice(prefix.length) : null;
}

async function runRestoreScenario(options: {
  backupConfig: Record<string, unknown>;
  backupExtensionDirs: string[];
  freshConfig: Record<string, unknown>;
  freshPluginInstalls: OpenClawImagePluginInstall[];
  previousPluginInstalls?: OpenClawImagePluginInstall[];
}): Promise<{
  freshMarkers: Record<string, string>;
  restore: Awaited<ReturnType<typeof restoreRecreatedSandboxState>>;
  restoredConfig: Record<string, any>;
  staleUserExtensionExists: boolean;
  userExtensionMarker: string;
}> {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recreated-restore-"));
  try {
    const sandboxRoot = path.join(fs.realpathSync(fixture), "sandbox-root");
    fs.mkdirSync(sandboxRoot);
    const openclawDir = path.join(fs.realpathSync(sandboxRoot), ".openclaw");
    const extensionsDir = path.join(openclawDir, "extensions");
    const backupPath = path.join(fixture, "backup");
    const backupExtensionsDir = path.join(backupPath, "extensions");
    const stagedRemotePaths = new Map<string, string>();
    const freshExtensionDirs = [
      "nemoclaw",
      ...options.freshPluginInstalls
        .map(extensionDir)
        .filter((entry): entry is string => entry !== null),
    ];
    fs.mkdirSync(extensionsDir, { recursive: true });

    for (const extensionName of freshExtensionDirs) {
      const target = path.join(extensionsDir, extensionName);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "marker.txt"), `fresh-${extensionName}\n`);
    }
    fs.mkdirSync(path.join(extensionsDir, "stale-user-extension"), { recursive: true });
    fs.writeFileSync(path.join(extensionsDir, "stale-user-extension", "marker.txt"), "stale\n");

    for (const extensionName of ["nemoclaw", ...options.backupExtensionDirs]) {
      const target = path.join(backupExtensionsDir, extensionName);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "marker.txt"), `old-${extensionName}\n`);
    }
    fs.mkdirSync(path.join(backupExtensionsDir, "user-extension"), { recursive: true });
    fs.writeFileSync(path.join(backupExtensionsDir, "user-extension", "marker.txt"), "restored\n");

    fs.mkdirSync(backupPath, { recursive: true });
    fs.writeFileSync(path.join(backupPath, "openclaw.json"), JSON.stringify(options.backupConfig));
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify(options.freshConfig));
    const manifest: Record<string, unknown> = {
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-07-08T12-00-00-000Z",
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: ["extensions"],
      backedUpDirs: ["extensions"],
      stateFiles: [{ path: "openclaw.json", strategy: "copy" }],
      dir: OPENCLAW_DIR,
      backupPath,
      blueprintDigest: null,
      ...(options.previousPluginInstalls !== undefined
        ? { openclawImagePluginInstalls: options.previousPluginInstalls }
        : {}),
    };
    fs.writeFileSync(path.join(backupPath, "rebuild-manifest.json"), JSON.stringify(manifest));
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
    });
    mocks.upload.mockImplementation(
      (_gateway: string, _sandbox: string, localPath: string, remotePath: string) => {
        const stagedPath = path.join(
          fs.realpathSync(path.dirname(remotePath)),
          path.basename(remotePath),
        );
        fs.copyFileSync(localPath, stagedPath);
        stagedRemotePaths.set(remotePath, stagedPath);
        return { ok: true, remotePath };
      },
    );
    mocks.exec.mockImplementation(async (request: SandboxExecRequest) => {
      const readConfig = () => ({
        status: 0,
        stdout: "",
        stdoutBytes: fs.readFileSync(path.join(openclawDir, "openclaw.json")),
        stderr: "",
      });
      const restoreState = () => {
        const command = [...request.command];
        command[3] = stagedRemotePaths.get(command[3]) ?? command[3];
        command[4] = openclawDir;
        const result = spawnSync(command[0], command.slice(1), {
          input: request.stdin,
          maxBuffer: request.maxOutputBytes,
          timeout: request.timeoutMs,
          encoding: request.stdoutEncoding === "buffer" ? undefined : "utf8",
        });
        return {
          status: result.status,
          stdout: request.stdoutEncoding === "buffer" ? "" : String(result.stdout ?? ""),
          ...(request.stdoutEncoding === "buffer"
            ? { stdoutBytes: Buffer.from(result.stdout ?? "") }
            : {}),
          stderr: String(result.stderr ?? ""),
          ...(result.error ? { error: result.error } : {}),
          ...(result.signal ? { signal: result.signal } : {}),
        };
      };
      return request.command[0] === "sh" ? readConfig() : restoreState();
    });

    const restore = await restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "openclaw",
      freshOpenClawImagePluginInstalls: options.freshPluginInstalls,
    });

    return {
      freshMarkers: Object.fromEntries(
        freshExtensionDirs.map((name) => [
          name,
          fs.readFileSync(path.join(extensionsDir, name, "marker.txt"), "utf8"),
        ]),
      ),
      restore,
      restoredConfig: JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")),
      staleUserExtensionExists: fs.existsSync(path.join(extensionsDir, "stale-user-extension")),
      userExtensionMarker: fs.existsSync(path.join(extensionsDir, "user-extension", "marker.txt"))
        ? fs.readFileSync(path.join(extensionsDir, "user-extension", "marker.txt"), "utf8")
        : "missing",
    };
  } finally {
    mocks.exec.mockReset();
    mocks.getSandbox.mockReset();
    mocks.upload.mockReset();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function expectSuccessfulRestore(result: Awaited<ReturnType<typeof runRestoreScenario>>): void {
  expect(result.restore).toEqual({
    success: true,
    restoredDirs: ["extensions"],
    failedDirs: [],
    restoredFiles: ["openclaw.json"],
    failedFiles: [],
  });
  expect(result.staleUserExtensionExists).toBe(false);
  expect(result.userExtensionMarker).toBe("restored\n");
}

describe("recreated OpenClaw state restore", () => {
  it.each([
    { provenance: "missing legacy", previousPluginInstalls: undefined },
    { provenance: "known-empty", previousPluginInstalls: [] },
  ])("restores config and extensions with $provenance previous provenance", async ({
    previousPluginInstalls,
  }) => {
    const weather = imageInstall("weather", "weather");
    const result = await runRestoreScenario({
      previousPluginInstalls,
      freshPluginInstalls: [weather],
      backupExtensionDirs: ["weather"],
      backupConfig: {
        gateway: { auth: { token: "stale-token" } },
        mcpServers: { filesystem: { command: "npx" } },
        plugins: { entries: { "user-plugin": { enabled: true } } },
      },
      freshConfig: {
        gateway: { auth: { token: "fresh-token" } },
        plugins: {
          entries: { weather: { enabled: true, config: { revision: "fresh" } } },
          load: { paths: weather.loadPaths },
        },
      },
    });

    expectSuccessfulRestore(result);
    expect(result.freshMarkers).toEqual({
      nemoclaw: "fresh-nemoclaw\n",
      weather: "fresh-weather\n",
    });
    expect(result.restoredConfig.gateway.auth.token).toBe("fresh-token");
    expect(result.restoredConfig.mcpServers.filesystem.command).toBe("npx");
    expect(result.restoredConfig.plugins.entries).toEqual({
      "user-plugin": { enabled: true },
      weather: { enabled: true, config: { revision: "fresh" } },
    });
  });

  it("reconciles populated previous and fresh image-plugin provenance during config restore", async () => {
    const previousWeather = imageInstall("weather", "weather-v1");
    const freshWeather = imageInstall("weather", "weather-v2");
    const userPluginPath = `${OPENCLAW_DIR}/extensions/user-plugin`;
    const result = await runRestoreScenario({
      previousPluginInstalls: [previousWeather],
      freshPluginInstalls: [freshWeather],
      backupExtensionDirs: ["weather-v1"],
      backupConfig: {
        gateway: { auth: { token: "stale-token" } },
        channels: {
          weather: { enabled: false, token: "stale-image-token" },
          "user-channel": { room: "keep" },
        },
        plugins: {
          entries: {
            weather: { enabled: false, config: { revision: "stale" } },
            "user-plugin": { enabled: true },
          },
          installs: { weather: { installPath: previousWeather.installPath } },
          load: { paths: [previousWeather.installPath, userPluginPath] },
          slots: { memory: "weather", contextEngine: "user-plugin" },
        },
      },
      freshConfig: {
        gateway: { auth: { token: "fresh-token" } },
        channels: { weather: { enabled: true, endpoint: "fresh" } },
        plugins: {
          entries: { weather: { enabled: true, config: { revision: "fresh" } } },
          load: { paths: freshWeather.loadPaths },
          slots: { memory: "weather" },
        },
      },
    });

    expectSuccessfulRestore(result);
    expect(result.freshMarkers).toEqual({
      nemoclaw: "fresh-nemoclaw\n",
      "weather-v2": "fresh-weather-v2\n",
    });
    expect(result.restoredConfig.gateway.auth.token).toBe("fresh-token");
    expect(result.restoredConfig.channels).toEqual({
      weather: { enabled: true, endpoint: "fresh" },
      "user-channel": { room: "keep" },
    });
    expect(result.restoredConfig.plugins.entries).toEqual({
      "user-plugin": { enabled: true },
      weather: { enabled: true, config: { revision: "fresh" } },
    });
    expect(result.restoredConfig.plugins.load.paths).toEqual([
      freshWeather.installPath,
      userPluginPath,
    ]);
    expect(result.restoredConfig.plugins.slots).toEqual({
      contextEngine: "user-plugin",
      memory: "weather",
    });
    expect(result.restoredConfig.plugins.installs).toBeUndefined();
  });
});
