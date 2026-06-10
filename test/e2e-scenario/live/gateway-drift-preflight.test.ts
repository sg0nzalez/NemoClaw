// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { HostCliClient } from "../framework/clients/index.ts";
import { expect, test } from "../framework/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../framework/live-project-gate.ts";
import type { ShellProbeResult } from "../framework/shell-probe.ts";

// Migrated from test/e2e/test-gateway-drift-preflight.sh. This hermetic
// regression guard for #3399 / #3423 drives the real NemoClaw CLI with fake
// OpenShell and Docker binaries so gateway schema drift fails closed before
// sandbox state can be trusted or mutated.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const BUILD_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 60_000;
const runGatewayDriftPreflightTest = shouldRunLiveE2EScenarios() ? test : test.skip;

type CasePaths = {
  name: string;
  dir: string;
  home: string;
  bin: string;
  commandOut: string;
  openshellCalls: string;
  dockerCalls: string;
};

type GatewayDockerOptions = {
  gatewayRunning?: string;
  gatewayPorts?: string;
  gatewayImage?: string;
};

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function writeRegistry(home: string): void {
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "sandboxes.json"),
    `${JSON.stringify(
      {
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
            agent: "openclaw",
            agentVersion: "test-version",
          },
        },
        defaultSandbox: "alpha",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function writeFakeOpenshell(binDir: string): void {
  writeExecutable(
    path.join(binDir, "openshell"),
    `#!/usr/bin/env bash
set -uo pipefail
: "\${NEMOCLAW_FAKE_CASE_DIR:?}"
printf '%s\\n' "$*" >> "$NEMOCLAW_FAKE_CASE_DIR/openshell-calls.log"
case "\${1:-}" in
  --version|-V)
    printf 'openshell 0.0.37\\n'
    exit 0
    ;;
  status)
    printf 'Server Status\\n\\n  Gateway: nemoclaw\\n  Gateway endpoint: http://127.0.0.1:8080\\n  Status: Connected\\n'
    exit 0
    ;;
  gateway)
    if [ "\${2:-}" = "info" ]; then
      printf 'Gateway Info\\n\\n  Gateway: nemoclaw\\n  Gateway endpoint: http://127.0.0.1:8080\\n'
      exit 0
    fi
    ;;
  sandbox)
    if [ "\${2:-}" = "list" ]; then
      printf '%s\\n' 'Error: status: Internal, message: "failed to decode Protobuf message: Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6"' >&2
      exit "\${NEMOCLAW_FAKE_SANDBOX_LIST_EXIT:-1}"
    fi
    ;;
esac
printf 'unexpected openshell args: %s\\n' "$*" >&2
exit 9
`,
  );
}

function writeFakeDocker(binDir: string, options: GatewayDockerOptions = {}): void {
  const gatewayRunning = options.gatewayRunning ?? "true";
  const gatewayPorts =
    options.gatewayPorts ?? '{"30051/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}';
  const gatewayImage = options.gatewayImage ?? "ghcr.io/nvidia/openshell/cluster:0.0.37";

  writeExecutable(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
set -uo pipefail
case_dir="\${NEMOCLAW_FAKE_CASE_DIR:-\${TMPDIR:-/tmp}/nemoclaw-gateway-drift-preflight-current}"
printf '%s\\n' "$*" >> "$case_dir/docker-calls.log"
format=""
if [ "\${1:-}" = "inspect" ] || { [ "\${1:-}" = "container" ] && [ "\${2:-}" = "inspect" ]; }; then
  while [ "$#" -gt 0 ]; do
    if [ "\${1:-}" = "--format" ]; then
      shift
      format="\${1:-}"
      break
    fi
    shift
  done
  case "$format" in
    '{{.State.Running}}'|"'{{.State.Running}}'")
      printf '%s\\n' ${JSON.stringify(gatewayRunning)}
      exit 0
      ;;
    '{{json .NetworkSettings.Ports}}'|"'{{json .NetworkSettings.Ports}}'")
      printf '%s\\n' ${JSON.stringify(gatewayPorts)}
      exit 0
      ;;
    '{{.Config.Image}}'|"'{{.Config.Image}}'")
      printf '%s\\n' ${JSON.stringify(gatewayImage)}
      exit 0
      ;;
  esac
fi
printf 'unexpected docker args: %s\\n' "$*" >&2
exit 9
`,
  );
}

function writeFakeDockerNoCluster(binDir: string): void {
  writeExecutable(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$*" >> "$NEMOCLAW_FAKE_CASE_DIR/docker-calls.log"
if [ "\${1:-}" = "inspect" ] || { [ "\${1:-}" = "container" ] && [ "\${2:-}" = "inspect" ]; }; then
  printf 'Error: No such object\\n' >&2
  exit 1
fi
exit 0
`,
  );
}

function writeFakeGatewayBinary(binDir: string, version = "0.0.43"): string {
  const gatewayBin = path.join(binDir, "openshell-gateway");
  writeExecutable(
    gatewayBin,
    `#!/usr/bin/env bash
case "\${1:-}" in --version|-V) printf 'openshell-gateway %s\\n' ${JSON.stringify(version)}; exit 0 ;; esac
exec -a "$0" sleep 600
`,
  );
  return gatewayBin;
}

function writeHostProcessMarker(home: string, gatewayBin: string, pid: number): void {
  const stateDir = path.join(home, ".local", "state", "nemoclaw", "openshell-docker-gateway");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "runtime.json"),
    `${JSON.stringify(
      {
        version: 1,
        pid,
        driver: "docker",
        platform: "linux",
        arch: process.arch,
        endpoint: "http://127.0.0.1:8080",
        desiredEnvHash: "deadbeef",
        gatewayBin,
        openshellVersion: "0.0.44",
        dockerHost: "unix:///run/docker.sock",
        createdAt: "2026-05-25T10:27:03.702Z",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function prepareCase(rootDir: string, name: string): Promise<CasePaths> {
  const dir = path.join(rootDir, "cases", name);
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  const paths = {
    name,
    dir,
    home,
    bin,
    commandOut: path.join(dir, "command.out"),
    openshellCalls: path.join(dir, "openshell-calls.log"),
    dockerCalls: path.join(dir, "docker-calls.log"),
  };

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(bin, { recursive: true });
  await fsp.writeFile(paths.openshellCalls, "");
  await fsp.writeFile(paths.dockerCalls, "");
  writeRegistry(home);
  writeFakeOpenshell(bin);
  return paths;
}

async function prepareBackupCase(
  rootDir: string,
  name: string,
  dockerOptions: GatewayDockerOptions = {},
): Promise<CasePaths> {
  const paths = await prepareCase(rootDir, name);
  writeFakeDocker(paths.bin, dockerOptions);
  return paths;
}

async function prepareHostProcessCase(
  rootDir: string,
  name: string,
  options: { marker: "live" | "stale" | "none"; gatewayVersion?: string },
): Promise<{ paths: CasePaths; child?: ChildProcess }> {
  const paths = await prepareCase(rootDir, name);
  writeFakeDockerNoCluster(paths.bin);
  const gatewayBin = writeFakeGatewayBinary(paths.bin, options.gatewayVersion ?? "0.0.43");

  if (options.marker === "live") {
    const child = spawn(gatewayBin, ["serve"], { stdio: "ignore" });
    if (!child.pid) {
      throw new Error("fake gateway did not start with a pid");
    }
    writeHostProcessMarker(paths.home, gatewayBin, child.pid);
    return { paths, child };
  }

  if (options.marker === "stale") {
    writeHostProcessMarker(paths.home, gatewayBin, await createDeadPid());
  }

  return { paths };
}

async function createDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  if (!child.pid) {
    throw new Error("short-lived process did not start with a pid");
  }
  const pid = child.pid;
  await waitForExit(child, 5000);
  return pid;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`process ${String(child.pid)} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 1500);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 1500);
  }
}

async function runNemoclawCase(
  host: HostCliClient,
  paths: CasePaths,
  args: string[],
): Promise<{ result: ShellProbeResult; output: string }> {
  const result = await host.command(process.execPath, [CLI, ...args], {
    artifactName: `gateway-drift-preflight-${paths.name}`,
    cwd: REPO_ROOT,
    inheritEnv: true,
    env: {
      HOME: paths.home,
      PATH: `${paths.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: paths.dir,
      NEMOCLAW_FAKE_CASE_DIR: paths.dir,
      NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "0",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const output = `${result.stdout}${result.stderr}`;
  await fsp.writeFile(paths.commandOut, output);
  return { result, output };
}

async function readText(file: string): Promise<string> {
  return fsp.readFile(file, "utf8");
}

async function expectOpenshellCall(paths: CasePaths, call: string): Promise<void> {
  const calls = (await readText(paths.openshellCalls)).split(/\r?\n/).filter(Boolean);
  expect(calls, `${paths.name} should call openshell ${call}`).toContain(call);
}

async function expectNoOpenshellCall(paths: CasePaths, call: string): Promise<void> {
  const calls = (await readText(paths.openshellCalls)).split(/\r?\n/).filter(Boolean);
  expect(calls, `${paths.name} should not call openshell ${call}`).not.toContain(call);
}

function expectContains(output: string, pattern: RegExp, description: string): void {
  expect(output, description).toMatch(pattern);
}

function expectNotContains(output: string, pattern: RegExp, description: string): void {
  expect(output, description).not.toMatch(pattern);
}

runGatewayDriftPreflightTest(
  "gateway drift preflight fails closed before trusting stale sandbox state",
  { timeout: BUILD_TIMEOUT_MS + COMMAND_TIMEOUT_MS * 6 },
  async ({ artifacts, cleanup, host }) => {
    await artifacts.writeJson("scenario.json", {
      id: "gateway-drift-preflight",
      runner: "vitest",
      boundary: "repo-cli-with-fake-openshell-and-docker",
      migratedFrom: "test/e2e/test-gateway-drift-preflight.sh",
      regressionTargets: ["#3399", "#3423"],
    });

    const build = await host.command("npm", ["run", "build:cli"], {
      artifactName: "gateway-drift-preflight-build-cli",
      cwd: REPO_ROOT,
      inheritEnv: true,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    expect(build.exitCode, `CLI build failed\n${build.stdout}${build.stderr}`).toBe(0);

    const protobuf = await prepareBackupCase(artifacts.rootDir, "protobuf-mismatch", {
      gatewayRunning: "false",
      gatewayImage: "ghcr.io/nvidia/openshell/cluster:0.0.37",
    });
    const protobufRun = await runNemoclawCase(host, protobuf, ["backup-all"]);
    expectContains(
      protobufRun.output,
      /protobuf|schema mismatch|invalid wire type|Skipping '?alpha'? \(not running\)/i,
      "protobuf failure is surfaced",
    );
    expectContains(
      protobufRun.output,
      /No sandbox data was changed|Refusing to trust OpenShell sandbox state/i,
      "fail-closed no-mutation guidance is printed",
    );
    expectNotContains(
      protobufRun.output,
      /Skipping '?alpha'? \(not running\)/i,
      "running sandbox is not misclassified as stopped",
    );
    expectNotContains(
      protobufRun.output,
      /Backup complete/i,
      "backup does not proceed after unsafe state RPC",
    );

    const patchedImage = await prepareBackupCase(artifacts.rootDir, "patched-image-drift", {
      gatewayImage: "nemoclaw-cluster:0.0.36-fuse-overlayfs-aa8b8487",
    });
    const patchedImageRun = await runNemoclawCase(host, patchedImage, ["backup-all"]);
    expect(
      patchedImageRun.result.exitCode,
      "backup-all should fail with stale gateway image",
    ).not.toBe(0);
    expectContains(
      patchedImageRun.output,
      /schema preflight failed|gateway schema preflight failed|image.*does not match|Running gateway image/i,
      "gateway image drift preflight is surfaced",
    );
    expectContains(patchedImageRun.output, /0\.0\.37/i, "installed OpenShell version is reported");
    expectContains(
      patchedImageRun.output,
      /nemoclaw-cluster:0\.0\.36-fuse-overlayfs-aa8b8487|0\.0\.36/i,
      "patched stale gateway image/version is reported",
    );
    await expectNoOpenshellCall(patchedImage, "sandbox list");

    const liveMarker = await prepareHostProcessCase(artifacts.rootDir, "host-process-backup", {
      marker: "live",
    });
    if (liveMarker.child) {
      cleanup.add("stop live-marker fake gateway", () =>
        stopProcess(liveMarker.child as ChildProcess),
      );
    }
    const liveMarkerRun = await runNemoclawCase(host, liveMarker.paths, ["backup-all"]);
    expect(
      liveMarkerRun.result.exitCode,
      "backup-all should fail with host-process drift",
    ).not.toBe(0);
    expectContains(
      liveMarkerRun.output,
      /schema preflight failed|gateway schema preflight failed|Running gateway binary/i,
      "host-process gateway drift preflight is surfaced",
    );
    expectContains(liveMarkerRun.output, /0\.0\.37/i, "installed OpenShell version is reported");
    expectContains(
      liveMarkerRun.output,
      /Running gateway binary.*0\.0\.43/is,
      "running host-process gateway binary/version is reported",
    );
    expectContains(
      liveMarkerRun.output,
      /No sandbox data was changed|Refusing to trust OpenShell sandbox state/i,
      "host-process fail-closed no-mutation guidance is printed",
    );
    expectNotContains(
      liveMarkerRun.output,
      /Running gateway image/i,
      "host-process drift does not claim a cluster image",
    );
    await expectNoOpenshellCall(liveMarker.paths, "sandbox list");

    const upgrade = await prepareHostProcessCase(artifacts.rootDir, "host-process-upgrade", {
      marker: "stale",
    });
    const upgradeRun = await runNemoclawCase(host, upgrade.paths, ["upgrade-sandboxes", "--check"]);
    expect(
      upgradeRun.result.exitCode,
      "upgrade-sandboxes should fail with host-process gateway binary drift",
    ).not.toBe(0);
    expectContains(
      upgradeRun.output,
      /schema preflight failed|gateway schema preflight failed|Running gateway binary/i,
      "host-process drift preflight is surfaced for upgrade-sandboxes",
    );
    expectContains(
      upgradeRun.output,
      /Running gateway binary.*0\.0\.43/is,
      "running host-process gateway binary/version is reported for upgrade-sandboxes",
    );
    await expectNoOpenshellCall(upgrade.paths, "sandbox list");

    const noMarker = await prepareHostProcessCase(artifacts.rootDir, "host-process-no-marker", {
      marker: "none",
    });
    const noMarkerRun = await runNemoclawCase(host, noMarker.paths, ["backup-all"]);
    expect(noMarkerRun.result.exitCode, "backup-all should fail with no-marker drift").not.toBe(0);
    expectContains(
      noMarkerRun.output,
      /schema preflight failed|gateway schema preflight failed|Running gateway binary/i,
      "host-process drift preflight is surfaced without a marker",
    );
    expectContains(
      noMarkerRun.output,
      /Running gateway binary.*0\.0\.43/is,
      "fallback-resolved gateway binary/version is reported",
    );
    await expectNoOpenshellCall(noMarker.paths, "sandbox list");

    const staleMarker = await prepareCase(artifacts.rootDir, "host-process-stale-marker");
    const staleOld = path.join(staleMarker.dir, "old-install");
    fs.mkdirSync(staleOld, { recursive: true });
    writeFakeDockerNoCluster(staleMarker.bin);
    writeFakeGatewayBinary(staleMarker.bin, "0.0.37");
    const oldGatewayBin = writeFakeGatewayBinary(staleOld, "0.0.43");
    writeHostProcessMarker(staleMarker.home, oldGatewayBin, await createDeadPid());
    const staleMarkerRun = await runNemoclawCase(host, staleMarker, ["backup-all"]);
    expectNotContains(
      staleMarkerRun.output,
      /Running gateway binary.*0\.0\.43/is,
      "stale marker binary is not used to fabricate drift",
    );
    await expectOpenshellCall(staleMarker, "sandbox list");
  },
);
