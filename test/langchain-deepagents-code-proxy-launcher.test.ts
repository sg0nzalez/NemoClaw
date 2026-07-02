// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
const PROXY_URL_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;
const NO_PROXY_ENV_NAMES = ["NO_PROXY", "no_proxy"] as const;

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

function makeLauncherProxyProbeFixture(tempDir: string): string {
  const launcherPath = path.join(tempDir, "dcode-launcher.sh");
  const probePath = path.join(tempDir, "managed-dcode-probe.sh");
  const probe = [
    "#!/usr/bin/env bash",
    "for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do",
    '  printf \'LAUNCHER_%s=%s\\n\' "$name" "${!name-__unset__}"',
    "done",
    "",
  ].join("\n");
  const fixture = readAgentFile("dcode-launcher.sh").replace(
    'readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"',
    `readonly MANAGED_DCODE_WRAPPER="${probePath}"`,
  );
  fs.writeFileSync(probePath, probe, "utf8");
  fs.writeFileSync(launcherPath, fixture, "utf8");
  fs.chmodSync(probePath, 0o755);
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

function runLauncher(
  launcherPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync("bash", [launcherPath, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
}

describe("Deep Agents Code direct-exec proxy launcher", () => {
  it("normalizes proxy state for direct dcode launcher execution (#6191)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-direct-proxy-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const result = runLauncher(launcherPath, ["-n", "PONG"], {
      HTTP_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      HTTPS_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      NO_PROXY: "corp.internal,inference.local",
      http_proxy: "http://lower-user:lower-password@lower-proxy.example:8080",
      https_proxy: "http://lower-user:lower-password@lower-proxy.example:8080",
      no_proxy: "corp.internal,inference.local",
      NEMOCLAW_PROXY_HOST: "managed-proxy.internal",
      NEMOCLAW_PROXY_PORT: "65535",
    });

    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    const managedProxy = "http://managed-proxy.internal:65535";
    const managedNoProxy = "localhost,127.0.0.1,::1,managed-proxy.internal";
    for (const name of PROXY_URL_ENV_NAMES) {
      expect(lines).toContain(`LAUNCHER_${name}=${managedProxy}`);
    }
    for (const name of NO_PROXY_ENV_NAMES) {
      expect(lines).toContain(`LAUNCHER_${name}=${managedNoProxy}`);
    }
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("inference.local");
    expect(output).not.toContain("corp-proxy.example");
    expect(output).not.toContain("corp-user");
    expect(output).not.toContain("corp-password");
  });

  it("bakes validated proxy overrides into direct dcode execution paths (#6191)", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const launcher = readAgentFile("dcode-launcher.sh");

    expect(dockerfile).toContain("ARG NEMOCLAW_PROXY_HOST=10.200.0.1");
    expect(dockerfile).toContain("ARG NEMOCLAW_PROXY_PORT=3128");
    expect(dockerfile).toContain("NEMOCLAW_PROXY_HOST=${NEMOCLAW_PROXY_HOST}");
    expect(dockerfile).toContain("NEMOCLAW_PROXY_PORT=${NEMOCLAW_PROXY_PORT}");
    expect(launcher).toContain(
      'export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"',
    );
    expect(launcher).toContain('export HTTPS_PROXY="$_PROXY_URL"');
    expect(launcher).toContain('export no_proxy="$_NO_PROXY_VAL"');
  });

  it("rejects unsafe direct dcode proxy overrides before managed code runs (#6191)", () => {
    const rejectedOverrides = [
      { NEMOCLAW_PROXY_HOST: "corp-user:corp-password@proxy.example" },
      { NEMOCLAW_PROXY_HOST: "proxy.example/path" },
      { NEMOCLAW_PROXY_PORT: "0" },
      { NEMOCLAW_PROXY_PORT: "65536" },
    ];

    for (const overrides of rejectedOverrides) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-launch-invalid-"));
      const launcherPath = makeLauncherProxyProbeFixture(tempDir);
      const result = runLauncher(launcherPath, ["-n", "PONG"], overrides);

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("LAUNCHER_");
      for (const value of Object.values(overrides)) {
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(value);
      }
    }
  });
});
