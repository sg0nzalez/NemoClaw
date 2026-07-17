// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DUAL_STATION_SIMULATION_SUITES = Object.freeze([
  "src/lib/inference/vllm-models.test.ts",
  "src/lib/inference/vllm-station-cluster.test.ts",
  "src/lib/inference/vllm-station-cluster-lifecycle.test.ts",
  "src/lib/inference/vllm-dual-station.test.ts",
  "src/lib/inference/vllm-station-model-staging.test.ts",
  "src/lib/inference/vllm-station-ssh-binding.test.ts",
  "src/lib/inference/vllm-dual-station-simulator.test.ts",
  "src/lib/inference/vllm-dual-station-simulator-command.test.ts",
]);

export const DUAL_STATION_SIMULATION_POISON_EXECUTABLES = Object.freeze([
  "curl",
  "docker",
  "ibstat",
  "ibv_devinfo",
  "ip",
  "mpirun",
  "nccl-tests",
  "nvidia-smi",
  "ping",
  "python",
  "python3",
  "rdma",
  "rsync",
  "scp",
  "sftp",
  "ssh",
  "wget",
]);

export const DUAL_STATION_SIMULATION_TIMEOUT_MS = 120_000;
export const DUAL_STATION_SIMULATION_FIXTURE_PYTHON_ENV =
  "NEMOCLAW_TEST_DUAL_STATION_FIXTURE_PYTHON";

const INHERITED_ENV_KEYS = Object.freeze([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "TERM",
]);

export interface DualStationSimulationInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface SimulationPoisonBin {
  directory: string;
  cacheDirectory: string;
  homeDirectory: string;
  tempDirectory: string;
  cleanup(): void;
}

export function createSimulationPoisonBin(): SimulationPoisonBin {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dual-station-sim-"));
  fs.chmodSync(directory, 0o700);
  const cacheDirectory = path.join(directory, "cache");
  const homeDirectory = path.join(directory, "home");
  const tempDirectory = path.join(directory, "tmp");
  for (const child of [cacheDirectory, homeDirectory, tempDirectory]) {
    fs.mkdirSync(child, { mode: 0o700 });
  }
  for (const executable of DUAL_STATION_SIMULATION_POISON_EXECUTABLES) {
    const unixFile = path.join(directory, executable);
    fs.writeFileSync(
      unixFile,
      `#!/bin/sh\necho "dual-Station simulator blocked external command: ${executable}" >&2\nexit 97\n`,
      { mode: 0o700 },
    );
    fs.chmodSync(unixFile, 0o700);
    fs.writeFileSync(
      `${unixFile}.cmd`,
      `@echo off\r\necho dual-Station simulator blocked external command: ${executable} 1>&2\r\nexit /b 97\r\n`,
      { mode: 0o600 },
    );
  }
  return {
    directory,
    cacheDirectory,
    homeDirectory,
    tempDirectory,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

export function dualStationSimulationEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.NEMOCLAW_RUN_BRANCH_VALIDATION_E2E = "0";
  env.NEMOCLAW_RUN_LIVE_E2E = "0";
  return env;
}

function canonicalExecutable(candidate: string): string | null {
  try {
    const canonical = fs.realpathSync(candidate);
    if (!path.isAbsolute(canonical) || path.normalize(canonical) !== canonical) return null;
    const metadata = fs.statSync(canonical);
    if (!metadata.isFile()) return null;
    fs.accessSync(canonical, fs.constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

/**
 * Capture one absolute Python interpreter for behavioral fixtures before PATH
 * is poisoned. The simulator passes only this canonical path to its test
 * worker; production probes and every PATH-based Python invocation remain
 * guarded by the exit-97 shims.
 */
export function resolveDualStationSimulationFixturePython(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string {
  const captured = sourceEnv[DUAL_STATION_SIMULATION_FIXTURE_PYTHON_ENV];
  if (captured !== undefined) {
    if (!path.isAbsolute(captured) || path.normalize(captured) !== captured) {
      throw new Error("The dual-Station simulator fixture Python path must be absolute");
    }
    const canonical = canonicalExecutable(captured);
    if (!canonical || canonical !== captured) {
      throw new Error("The dual-Station simulator fixture Python path is not canonical executable");
    }
    return canonical;
  }

  for (const directory of (sourceEnv.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory) || path.normalize(directory) !== directory) {
      continue;
    }
    const canonical = canonicalExecutable(path.join(directory, "python3"));
    if (canonical) return canonical;
  }
  throw new Error(
    "The dual-Station simulator requires python3 for its local embedded-script fixtures",
  );
}

export function buildDualStationSimulationInvocation(
  repositoryRoot: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): DualStationSimulationInvocation {
  const vitestEntry = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
  if (!fs.existsSync(vitestEntry)) {
    throw new Error(`Repository-local Vitest entry point is missing: ${vitestEntry}`);
  }
  return {
    command: process.execPath,
    args: [
      vitestEntry,
      "run",
      "--project",
      "cli",
      ...DUAL_STATION_SIMULATION_SUITES,
      "--reporter=dot",
    ],
    env: dualStationSimulationEnvironment(sourceEnv),
  };
}

export function assertDualStationSimulationPlatform(platform = process.platform): void {
  if (platform === "win32") {
    throw new Error(
      "The dual-Station simulator requires a POSIX host because its SSH-binding fixtures validate POSIX modes and shell syntax.",
    );
  }
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function describeSimulation(): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "simulation-only",
        localProcesses: [
          "repository-local Vitest worker",
          "fixture-only shell syntax checks",
          "captured absolute Python interpreter for embedded-script fixtures",
        ],
        liveTargets: [],
        externalCommandShims: DUAL_STATION_SIMULATION_POISON_EXECUTABLES,
        suites: DUAL_STATION_SIMULATION_SUITES,
      },
      null,
      2,
    )}\n`,
  );
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.length === 1 && argv[0] === "--describe") {
    describeSimulation();
    return 0;
  }
  if (argv.length > 0) {
    throw new Error(`Unknown dual-Station simulator argument: ${argv.join(" ")}`);
  }

  assertDualStationSimulationPlatform();
  const invocation = buildDualStationSimulationInvocation(repositoryRoot());
  const fixturePython = resolveDualStationSimulationFixturePython(invocation.env);
  const poisonBin = createSimulationPoisonBin();
  invocation.env.PATH = [poisonBin.directory, invocation.env.PATH]
    .filter((entry): entry is string => Boolean(entry))
    .join(path.delimiter);
  invocation.env.HOME = poisonBin.homeDirectory;
  invocation.env.XDG_CACHE_HOME = poisonBin.cacheDirectory;
  invocation.env.TEMP = poisonBin.tempDirectory;
  invocation.env.TMP = poisonBin.tempDirectory;
  invocation.env.TMPDIR = poisonBin.tempDirectory;
  invocation.env[DUAL_STATION_SIMULATION_FIXTURE_PYTHON_ENV] = fixturePython;
  delete invocation.env.XDG_RUNTIME_DIR;
  process.stdout.write(
    "Running the guarded, fixture-backed dual-Station simulator. " +
      "The audited suites use in-memory Docker adapters and no live Station target.\n",
  );
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(invocation.command, invocation.args, {
      cwd: repositoryRoot(),
      env: invocation.env,
      stdio: "inherit",
      timeout: DUAL_STATION_SIMULATION_TIMEOUT_MS,
    });
  } finally {
    poisonBin.cleanup();
  }
  if (result.error) throw result.error;
  if (result.signal) {
    process.stderr.write(`Dual-Station simulator terminated by signal ${result.signal}.\n`);
    return 1;
  }
  return result.status ?? 1;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
