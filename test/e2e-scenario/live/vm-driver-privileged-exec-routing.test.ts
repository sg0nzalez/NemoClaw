// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "../framework/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../framework/live-project-gate.ts";

// Migrated from test/e2e/test-vm-driver-privileged-exec-routing.sh. This is a
// hermetic host-side regression guard for #4245: it builds the CLI, writes a
// fake NemoClaw sandbox registry, puts a fake docker binary first in PATH, and
// imports the built privileged-exec helper directly.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BUILD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 60_000;
const PASS_MESSAGE = "PASS: VM and Docker privileged exec routing uses direct sandbox containers";
const runVmDriverPrivilegedExecTest = shouldRunLiveE2EScenarios() ? test : test.skip;

const FAKE_DOCKER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"\${XDG_NEMOCLAW_FAKE_DOCKER_LOG:?}"
if [ "\${1:-}" = "ps" ]; then
  cat "\${XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE:?}"
  exit 0
fi
echo "unexpected fake docker invocation: $*" >&2
exit 64
`;

const PROBE_SCRIPT = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = process.cwd();
const registryPath = path.join(process.env.HOME, ".nemoclaw", "sandboxes.json");
const psFile = process.env.XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE;

function writeRegistry(entries) {
  const sandboxes = {};
  for (const entry of entries) sandboxes[entry.name] = entry;
  fs.writeFileSync(
    registryPath,
    JSON.stringify({ defaultSandbox: entries[0]?.name ?? null, sandboxes }, null, 2),
  );
}

function writeDockerPs(names) {
  fs.writeFileSync(psFile, names.join("\n") + "\n");
}

function assertDirect(args, expectedContainer, label) {
  assert.deepEqual(
    args,
    ["exec", "--user", "root", expectedContainer, "stat", "-c", "%a", "/sandbox/.openclaw/openclaw.json"],
    label + " should route to the direct sandbox container",
  );
  assert.equal(
    args.includes("openshell-gateway-nemoclaw"),
    false,
    label + " unexpectedly routed through a non-sandbox gateway container",
  );
}

writeRegistry([
  { name: "alpha", openshellDriver: "vm" },
  { name: "alpha-child", openshellDriver: "vm" },
  { name: "dockerbox", openshellDriver: "docker" },
  { name: "unknown-driver", openshellDriver: null },
]);

writeDockerPs([
  "openshell-gateway-nemoclaw",
  "openshell-alpha-child",
  "openshell-alpha-child-2026",
  "openshell-alpha-abc123",
  "openshell-dockerbox-987",
  "openshell-unknown-driver",
]);

const helper = require(path.join(repo, "dist", "lib", "sandbox", "privileged-exec.js"));
const cmd = ["stat", "-c", "%a", "/sandbox/.openclaw/openclaw.json"];

assertDirect(
  helper.privilegedSandboxExecArgv("alpha", cmd),
  "openshell-alpha-abc123",
  "VM driver with prefix collision",
);
assertDirect(
  helper.privilegedSandboxExecArgv("alpha-child", cmd),
  "openshell-alpha-child",
  "VM driver with exact container",
);
assertDirect(
  helper.privilegedSandboxExecArgv("dockerbox", cmd),
  "openshell-dockerbox-987",
  "Docker driver",
);
assertDirect(
  helper.privilegedSandboxExecArgv("unknown-driver", cmd),
  "openshell-unknown-driver",
  "registry entry without a recorded driver",
);

writeDockerPs(["openshell-gateway-nemoclaw", "openshell-other"]);
assert.throws(
  () => helper.privilegedSandboxExecArgv("alpha", ["id"]),
  /No running direct OpenShell sandbox container found for 'alpha'.*driver: vm/,
  "missing VM direct container should fail clearly",
);

console.log("PASS: VM and Docker privileged exec routing uses direct sandbox containers");
`;

async function writeExecutable(target: string, contents: string): Promise<void> {
  await fs.writeFile(target, contents, { mode: 0o755 });
}

async function readTextIfPresent(target: string): Promise<string> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

runVmDriverPrivilegedExecTest(
  "VM and Docker privileged exec routing uses direct sandbox containers",
  {
    timeout: BUILD_TIMEOUT_MS + PROBE_TIMEOUT_MS,
  },
  async ({ artifacts, host }) => {
    await artifacts.writeJson("scenario.json", {
      id: "vm-driver-privileged-exec-routing",
      runner: "vitest",
      boundary: "host-privileged-exec-helper",
      migratedFrom: "test/e2e/test-vm-driver-privileged-exec-routing.sh",
    });

    const build = await host.command("npm", ["run", "build:cli"], {
      artifactName: "vm-driver-privileged-exec-routing-build-cli",
      cwd: REPO_ROOT,
      inheritEnv: true,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    expect(build.exitCode, `build failed\n${build.stderr}`).toBe(0);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-vm-driver-privexec-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const fakeHome = path.join(tmp, "home");
      const fakeNemoclawDir = path.join(fakeHome, ".nemoclaw");
      const fakeDockerPsFile = path.join(tmp, "docker-ps.txt");
      const fakeDockerLog = path.join(tmp, "docker.log");
      const probePath = path.join(tmp, "probe.js");

      await fs.mkdir(fakeBin, { recursive: true });
      await fs.mkdir(fakeNemoclawDir, { recursive: true });
      await fs.writeFile(fakeDockerPsFile, "");
      await fs.writeFile(fakeDockerLog, "");
      await writeExecutable(path.join(fakeBin, "docker"), FAKE_DOCKER_SCRIPT);
      await fs.writeFile(probePath, PROBE_SCRIPT);

      const probe = await host.command("node", [probePath], {
        artifactName: "vm-driver-privileged-exec-routing-probe",
        cwd: REPO_ROOT,
        inheritEnv: true,
        env: {
          HOME: fakeHome,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          XDG_NEMOCLAW_FAKE_DOCKER_LOG: fakeDockerLog,
          XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE: fakeDockerPsFile,
        },
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      await artifacts.writeText("docker.log", await readTextIfPresent(fakeDockerLog));
      expect(
        probe.exitCode,
        `probe failed\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`,
      ).toBe(0);
      expect(probe.stdout).toContain(PASS_MESSAGE);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  },
);
