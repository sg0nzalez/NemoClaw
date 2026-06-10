// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { HostCliClient } from "../framework/clients/index.ts";
import { expect, test } from "../framework/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../framework/live-project-gate.ts";
import type { ShellProbeResult } from "../framework/shell-probe.ts";

// Migrated from test/e2e/test-gateway-health-honest.sh. This hermetic
// regression guard for #3111 drives startGateway() in a child Node process with
// fake OpenShell metadata and a sabotaged openshell-gateway binary. The test
// proves NemoClaw does not report the Docker-driver gateway healthy when the
// process exits before serving a TCP listener.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BUILD_TIMEOUT_MS = 120_000;
const START_GATEWAY_TIMEOUT_MS = 60_000;
const runGatewayHealthHonestTest = shouldRunLiveE2EScenarios() ? test : test.skip;

type ScenarioPaths = {
  dir: string;
  home: string;
  fakeBin: string;
  stateDir: string;
  startScript: string;
  startLog: string;
  gatewayLog: string;
  openshellTrace: string;
  sabotageBin: string;
};

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function prepareScenario(rootDir: string, gatewayPort: number): Promise<ScenarioPaths> {
  const dir = path.join(rootDir, "gateway-health-honest");
  const home = path.join(dir, "home");
  const fakeBin = path.join(dir, "bin");
  const stateDir = path.join(dir, "state");
  const paths = {
    dir,
    home,
    fakeBin,
    stateDir,
    startScript: path.join(dir, "start-gateway.cjs"),
    startLog: path.join(dir, "start-gateway.out"),
    gatewayLog: path.join(stateDir, "openshell-gateway.log"),
    openshellTrace: path.join(dir, "openshell.trace"),
    sabotageBin: path.join(fakeBin, "openshell-gateway-sabotage"),
  };

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(fakeBin, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(paths.openshellTrace, "");

  writeFakeOpenshell(fakeBin, paths.openshellTrace, gatewayPort);
  writeExecutable(
    path.join(fakeBin, "openshell-sandbox"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  writeExecutable(
    path.join(fakeBin, "lsof"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  writeExecutable(
    path.join(fakeBin, "sudo"),
    `#!/usr/bin/env bash
exit 1
`,
  );
  writeExecutable(
    paths.sabotageBin,
    `#!/usr/bin/env bash
printf '%s\\n' "openshell-gateway-sabotage: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.38' not found" >&2
printf '%s\\n' "openshell-gateway-sabotage: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.39' not found" >&2
exit 127
`,
  );
  await fsp.writeFile(paths.startScript, childStartGatewayScript());

  return paths;
}

function writeFakeOpenshell(fakeBin: string, tracePath: string, gatewayPort: number): void {
  writeExecutable(
    path.join(fakeBin, "openshell"),
    `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tracePath)}

case "$*" in
  "--version")
    printf 'openshell 0.0.44\\n'
    exit 0
    ;;
  "gateway --help")
    printf 'Commands: add info remove select start\\n'
    exit 0
    ;;
esac

if [ "\${1:-}" = "status" ]; then
  printf 'Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n'
  exit 0
fi

if [ "\${1:-}" = "gateway" ]; then
  case "\${2:-}" in
    add|destroy|remove|select)
      exit 0
      ;;
    info)
      printf 'Gateway Info\\n\\n  Gateway: nemoclaw\\n  Gateway endpoint: http://127.0.0.1:${gatewayPort}\\n'
      exit 0
      ;;
  esac
fi

if [ "\${1:-}" = "doctor" ] && [ "\${2:-}" = "logs" ]; then
  printf 'DOCTOR LOGS REACHED\\n'
  exit 0
fi

exit 0
`,
  );
}

function childStartGatewayScript(): string {
  const onboardPath = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "onboard.js"));
  return `\
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./docker-driver-gateway-service" || request.endsWith("/docker-driver-gateway-service")) {
    return {
      OPENSHELL_GATEWAY_USER_SERVICE: "openshell-gateway",
      getOpenShellGatewayUserServicePaths: () => [],
      getOpenShellGatewayUserServiceBinaryPaths: () => [],
      hasOpenShellGatewayUserService: () => false,
      startOpenShellGatewayUserService: () => ({
        attempted: false,
        fallbackAllowed: true,
        reason: "disabled by gateway-health-honest scenario",
        started: false,
      }),
      startPackageManagedDockerDriverGateway: async () => false,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { startGateway } = require(${onboardPath});

startGateway(null)
  .then(() => {
    console.log("__onboard_startGateway_returned_successfully__");
    process.exit(0);
  })
  .catch((error) => {
    console.error("__onboard_startGateway_threw__");
    console.error(error && error.stack ? error.stack : error);
    process.exit(3);
  });
`;
}

async function runStartGateway(
  host: HostCliClient,
  paths: ScenarioPaths,
  gatewayPort: number,
): Promise<{ result: ShellProbeResult; output: string; gatewayLog: string; trace: string }> {
  const result = await host.command(process.execPath, [paths.startScript], {
    artifactName: "gateway-health-honest-start-gateway",
    cwd: REPO_ROOT,
    inheritEnv: true,
    env: {
      HOME: paths.home,
      PATH: `${paths.fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      NEMOCLAW_GATEWAY_PORT: String(gatewayPort),
      NEMOCLAW_OPENSHELL_BIN: path.join(paths.fakeBin, "openshell"),
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: paths.stateDir,
      NEMOCLAW_OPENSHELL_GATEWAY_BIN: paths.sabotageBin,
      NEMOCLAW_OPENSHELL_SANDBOX_BIN: path.join(paths.fakeBin, "openshell-sandbox"),
      NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "0",
      NEMOCLAW_HEALTH_POLL_COUNT: "3",
      NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_FAKE_OPENSHELL_TRACE: paths.openshellTrace,
    },
    timeoutMs: START_GATEWAY_TIMEOUT_MS,
  });
  const output = `${result.stdout}${result.stderr}`;
  await fsp.writeFile(paths.startLog, output);

  return {
    result,
    output,
    gatewayLog: await readFileIfPresent(paths.gatewayLog),
    trace: await readFileIfPresent(paths.openshellTrace),
  };
}

async function readFileIfPresent(filePath: string): Promise<string> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopRecordedGateway(paths: ScenarioPaths): Promise<void> {
  const pidText = (
    await readFileIfPresent(path.join(paths.stateDir, "openshell-gateway.pid"))
  ).trim();
  if (!pidText) return;
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await wait(500);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

runGatewayHealthHonestTest(
  "gateway health check refuses to bless a crashed Docker-driver gateway",
  { timeout: BUILD_TIMEOUT_MS + START_GATEWAY_TIMEOUT_MS },
  async ({ artifacts, cleanup, host }) => {
    await artifacts.writeJson("scenario.json", {
      id: "gateway-health-honest",
      runner: "vitest",
      boundary: "startGateway-child-process-with-fake-openshell",
      migratedFrom: "test/e2e/test-gateway-health-honest.sh",
      regressionTarget: "#3111",
    });

    const build = await host.command("npm", ["run", "build:cli"], {
      artifactName: "gateway-health-honest-build-cli",
      cwd: REPO_ROOT,
      inheritEnv: true,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    expect(build.exitCode, `CLI build failed\n${build.stdout}${build.stderr}`).toBe(0);

    const gatewayPort = await findAvailablePort();
    await artifacts.writeJson("ports.json", { gatewayPort });
    const paths = await prepareScenario(artifacts.rootDir, gatewayPort);
    cleanup.add("stop gateway-health-honest fake gateway", () => stopRecordedGateway(paths));
    const start = await runStartGateway(host, paths, gatewayPort);

    expect(
      start.gatewayLog,
      `sabotage markers missing from gateway log ${paths.gatewayLog}`,
    ).toMatch(/GLIBC_2\.3[89]|openshell-gateway-sabotage/);
    expect(
      start.output,
      "onboard must not log a healthy Docker-driver gateway after the binary crashed",
    ).not.toMatch(/Docker-driver gateway is healthy/);
    expect(
      start.result.exitCode,
      `startGateway should exit non-zero after a crashed binary\n${start.output}`,
    ).not.toBe(0);
    expect(start.output).not.toContain("__onboard_startGateway_returned_successfully__");
    expect(start.output, "onboard should surface a user-visible gateway failure").toMatch(
      /failed to start|gateway.*(?:crash|exit|error)|__onboard_startGateway_threw__/i,
    );

    const pidFile = path.join(paths.stateDir, "openshell-gateway.pid");
    const pidText = (await readFileIfPresent(pidFile)).trim();
    if (pidText) {
      const ps = await host.command("ps", ["-p", pidText, "-o", "state="], {
        artifactName: "gateway-health-honest-ps",
        inheritEnv: true,
        timeoutMs: 10_000,
      });
      const state = ps.stdout.trim();
      expect(
        state,
        `a non-zombie gateway pid (${pidText}) is still alive after the simulated crash`,
      ).not.toMatch(/^[^Z\s]/);
    }

    expect(start.trace, "fake openshell should be used for gateway metadata").toContain("status");
    expect(start.trace, "generic diagnostics should not be needed for this failure").not.toContain(
      "doctor logs",
    );
  },
);
