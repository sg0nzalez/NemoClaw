// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { expect, test } from "../framework/e2e-test.ts";

// Manual DGX Spark install smoke. The legacy bash entry point performed a real
// host install, so this Vitest replacement stays behind an explicit opt-in even
// when the broader live E2E project is enabled.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 60_000;
const runSparkInstallTest = process.env.NEMOCLAW_E2E_SPARK_INSTALL === "1" ? test : test.skip;

function requireEnv(name: string): void {
  const value = process.env[name];
  expect(value, `${name} is required`).toBe("1");
}

function installCommand(): string {
  if (process.env.NEMOCLAW_E2E_PUBLIC_INSTALL === "1") {
    return [
      "set -euo pipefail",
      'url="${NEMOCLAW_INSTALL_SCRIPT_URL:-https://www.nvidia.com/nemoclaw.sh}"',
      'curl -fsSL "$url" | NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash',
    ].join("\n");
  }

  return [
    "set -euo pipefail",
    "NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash install.sh --non-interactive",
  ].join("\n");
}

const refreshedPathProbe = [
  '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true',
  'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
  '[ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"',
  "command -v nemoclaw",
  "command -v openshell",
  "nemoclaw --help >/dev/null",
].join("\n");

runSparkInstallTest(
  "spark install smoke uses the standard non-interactive installer path",
  {
    timeout: INSTALL_TIMEOUT_MS + VERIFY_TIMEOUT_MS,
  },
  async ({ artifacts, host }) => {
    await artifacts.writeJson("scenario.json", {
      id: "spark-install",
      runner: "vitest",
      boundary: "host-installer",
      optIn: "NEMOCLAW_E2E_SPARK_INSTALL=1",
    });

    expect(process.platform, "DGX Spark install smoke runs on Linux hosts").toBe("linux");
    requireEnv("NEMOCLAW_NON_INTERACTIVE");
    requireEnv("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE");

    const docker = await host.command("docker", ["info"], {
      artifactName: "spark-install-docker-info",
      inheritEnv: true,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    expect(docker.exitCode, `docker info failed\n${docker.stderr}`).toBe(0);

    const install = await host.command("bash", ["-lc", installCommand()], {
      artifactName: "spark-install",
      cwd: REPO_ROOT,
      inheritEnv: true,
      env: {
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    expect(install.exitCode, `install failed\n${install.stderr}`).toBe(0);

    const verify = await host.command("bash", ["-lc", refreshedPathProbe], {
      artifactName: "spark-install-verify-cli",
      cwd: REPO_ROOT,
      inheritEnv: true,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    expect(verify.exitCode, `CLI verification failed\n${verify.stderr}`).toBe(0);
    expect(verify.stdout).toContain("nemoclaw");
    expect(verify.stdout).toContain("openshell");
  },
);
