// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxExecRequest } from "../src/lib/adapters/openshell/sandbox-control.js";
import { restoreEnv } from "./helpers/env-test-helpers";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("../src/lib/adapters/openshell/sandbox-control-routing.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/adapters/openshell/sandbox-control-routing.js")
  >()),
  execSandboxReadOnlyWithGrpcFallback: async (_gatewayName: string, request: SandboxExecRequest) =>
    mocks.exec(request),
  selectOpenShellSandboxControlForMutation: () => ({
    control: { exec: mocks.exec },
    transport: "grpc",
    close: () => {},
  }),
}));

vi.mock("../src/lib/adapters/openshell/sandbox-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/adapters/openshell/sandbox-upload.js")>()),
  uploadSandboxPayloadFile: mocks.upload,
}));

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-managed-extensions-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "..");
type SandboxStateModule = typeof import("../src/lib/state/sandbox.js");
const loadedSandboxState = await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
);
assert.equal(
  typeof loadedSandboxState.restoreRecreatedSandboxState,
  "function",
  "Expected recreated-sandbox state restore export to be available",
);
const sandboxState = loadedSandboxState as SandboxStateModule;
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

function writeBackup(
  sandboxName: string,
  dirName: string,
  openclawImagePluginInstalls?: Array<{
    id: string;
    installPath: string;
    loadPaths: string[];
  }>,
): { backupPath: string } {
  const backupPath = path.join(BACKUPS_ROOT, sandboxName, dirName);
  fs.mkdirSync(backupPath, { recursive: true });
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify({
      version: 1,
      sandboxName,
      timestamp: dirName,
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      openclawImagePluginInstalls,
      stateDirs: ["extensions"],
      backedUpDirs: ["extensions"],
      dir: "/sandbox/.openclaw",
      backupPath,
      blueprintDigest: null,
    }),
  );
  return { backupPath };
}

function writeOpenClawRegistry(sandboxName: string): void {
  const registryDir = path.join(TMP_HOME, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          policies: [],
          agent: null,
        },
      },
    }),
  );
}

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

describe("OpenClaw managed extension snapshot restore", () => {
  const pluginTransitions = [
    { name: "same-id update", previousPlugin: "weather", freshPlugin: "weather" },
    { name: "removal", previousPlugin: "weather", freshPlugin: null },
    { name: "rename", previousPlugin: "weather", freshPlugin: "forecast" },
  ] as const;
  const installIndexCases = (["sqlite", "legacy"] as const).flatMap((installIndexSource) =>
    pluginTransitions.map((transition) => ({ installIndexSource, ...transition })),
  );

  it.each(
    installIndexCases,
  )("preserves fresh extensions and handles image-plugin $name from the $installIndexSource install index", async ({
    installIndexSource,
    previousPlugin,
    freshPlugin,
  }) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-extension-restore-"));
    try {
      const sandboxRoot = path.join(fs.realpathSync(fixture), "sandbox-root");
      fs.mkdirSync(sandboxRoot);
      const openclawDir = path.join(fs.realpathSync(sandboxRoot), ".openclaw");
      const freshRegistryPath = path.join(fixture, "fresh-installs.json");
      const extensionsDir = path.join(openclawDir, "extensions");
      const requests: SandboxExecRequest[] = [];
      const stagedRemotePaths = new Map<string, string>();
      const builtInManagedExtensions =
        "nemoclaw,diagnostics-otel,brave,discord,openclaw-weixin,slack,whatsapp,msteams".split(",");
      const freshImagePlugins = freshPlugin ? [freshPlugin] : [];
      const managedExtensions = [...builtInManagedExtensions, ...freshImagePlugins];
      for (const extensionName of managedExtensions) {
        const extensionDir = path.join(extensionsDir, extensionName);
        fs.mkdirSync(extensionDir, { recursive: true });
        const marker = `fresh-${extensionName}\n`;
        fs.writeFileSync(path.join(extensionDir, "marker.txt"), marker);
      }
      fs.mkdirSync(path.join(extensionsDir, "stale-user-extension"), { recursive: true });
      fs.writeFileSync(path.join(extensionsDir, "stale-user-extension", "marker.txt"), "stale\n");
      fs.writeFileSync(
        freshRegistryPath,
        JSON.stringify({
          version: 1,
          loadPaths: [],
          installRecords: Object.fromEntries(
            freshImagePlugins.map((id) => [
              id,
              {
                source: "path",
                sourcePath: `/sandbox/.openclaw/extensions/${id}`,
                installPath: `/sandbox/.openclaw/extensions/${id}`,
              },
            ]),
          ),
        }),
      );

      const manifest = writeBackup("alpha", "2026-05-19T12-00-00-000Z", [
        {
          id: previousPlugin,
          installPath: `/sandbox/.openclaw/extensions/${previousPlugin}`,
          loadPaths: [],
        },
      ]);
      const backupExtensionsDir = path.join(manifest.backupPath, "extensions");
      for (const extensionName of [...builtInManagedExtensions, previousPlugin]) {
        const extensionDir = path.join(backupExtensionsDir, extensionName);
        fs.mkdirSync(extensionDir, { recursive: true });
        const marker = `old-${extensionName}\n`;
        fs.writeFileSync(path.join(extensionDir, "marker.txt"), marker);
      }
      fs.mkdirSync(path.join(backupExtensionsDir, "user-extension"), { recursive: true });
      fs.writeFileSync(
        path.join(backupExtensionsDir, "user-extension", "marker.txt"),
        "restored\n",
      );

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
        requests.push(request);
        const shellCommand = String(request.command[2] ?? "");
        const registryRead =
          (installIndexSource === "sqlite" && shellCommand.includes("state/openclaw.sqlite")) ||
          (installIndexSource === "legacy" && shellCommand.includes("plugins/installs.json"));
        const readRegistry = () => ({
          status: registryRead ? 0 : 2,
          stdout: registryRead ? fs.readFileSync(freshRegistryPath, "utf8") : "",
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
            encoding: "utf8",
          });
          return {
            status: result.status,
            stdout: String(result.stdout ?? ""),
            stderr: String(result.stderr ?? ""),
            ...(result.error ? { error: result.error } : {}),
            ...(result.signal ? { signal: result.signal } : {}),
          };
        };
        return request.command[0] === "sh" ? readRegistry() : restoreState();
      });

      writeOpenClawRegistry("alpha");

      const restore = await sandboxState.restoreRecreatedSandboxState(
        "alpha",
        manifest.backupPath,
        {
          targetAgentType: "openclaw",
        },
      );
      expect(restore.success).toBe(true);
      expect(restore.restoredDirs).toEqual(["extensions"]);
      for (const extensionName of managedExtensions) {
        expect(
          fs.readFileSync(path.join(extensionsDir, extensionName, "marker.txt"), "utf-8"),
        ).toBe(`fresh-${extensionName}\n`);
      }
      expect(fs.existsSync(path.join(extensionsDir, previousPlugin))).toBe(
        previousPlugin === freshPlugin,
      );
      expect(fs.existsSync(path.join(extensionsDir, "stale-user-extension"))).toBe(false);
      expect(
        fs.readFileSync(path.join(extensionsDir, "user-extension", "marker.txt"), "utf-8"),
      ).toBe("restored\n");

      expect(requests.filter((request) => request.command[0] === "python3")).toHaveLength(1);
      expect(
        requests.some((request) => request.command[2]?.includes("state/openclaw.sqlite")),
      ).toBe(true);
      expect(
        requests.some((request) => request.command[2]?.includes("plugins/installs.json")),
      ).toBe(installIndexSource === "legacy");

      fs.writeFileSync(
        freshRegistryPath,
        JSON.stringify({
          version: 1,
          loadPaths: [],
          installRecords: {
            "\u001b[31m../weather": {
              source: "path",
              sourcePath: "/sandbox/.openclaw/extensions/../weather",
              installPath: "/sandbox/.openclaw/extensions/../weather",
            },
          },
        }),
      );
      const rejected = await sandboxState.restoreRecreatedSandboxState(
        "alpha",
        manifest.backupPath,
        {
          targetAgentType: "openclaw",
        },
      );
      expect(rejected.success).toBe(false);
      expect(rejected.error).toBe("fresh OpenClaw plugin install registry failed validation");
      expect(fs.existsSync(path.join(extensionsDir, previousPlugin))).toBe(
        previousPlugin === freshPlugin,
      );
      for (const extensionName of managedExtensions) {
        expect(
          fs.readFileSync(path.join(extensionsDir, extensionName, "marker.txt"), "utf-8"),
        ).toBe(`fresh-${extensionName}\n`);
      }
      expect(requests.filter((request) => request.command[0] === "python3")).toHaveLength(1);
    } finally {
      mocks.exec.mockReset();
      mocks.upload.mockReset();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
