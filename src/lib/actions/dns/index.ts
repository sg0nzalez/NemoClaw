// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import {
  buildCoreDnsPatchJson,
  type ContainerRuntime,
  dockerHostRuntime,
  isSafeDnsUpstream,
  resolveCoreDnsUpstream,
  selectOpenshellClusterContainer,
} from "../../domain/dns/coredns";

export type CommandResult = Pick<SpawnSyncReturns<string>, "stderr" | "stdout" | "status">;

export interface FixCoreDnsDeps {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSocket?: (socketPath: string) => boolean;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
  readFile?: (filePath: string) => string;
  run?: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => CommandResult;
  runDocker?: (args: string[], options?: { env?: NodeJS.ProcessEnv }) => CommandResult;
  uid?: () => string;
}

export interface FixCoreDnsOptions {
  gatewayName?: string;
}

export interface FixCoreDnsResult {
  cluster?: string;
  exitCode: number;
  message?: string;
  runtime?: ContainerRuntime;
  skipped?: boolean;
  upstreamDns?: string;
}

function defaultRun(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): CommandResult {
  return spawnSync(command, args, {
    encoding: "utf-8",
    env: options.env,
  });
}

function defaultCommandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
  return result.status === 0;
}

function socketExists(socketPath: string, env: NodeJS.ProcessEnv): boolean {
  const testSocketPaths = env.NEMOCLAW_TEST_SOCKET_PATHS;
  if (testSocketPaths) return testSocketPaths.split(path.delimiter).includes(socketPath);
  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function findFirstSocket(
  candidates: string[],
  deps: Required<Pick<FixCoreDnsDeps, "existsSocket">>,
): string | null {
  return candidates.find((candidate) => deps.existsSocket(candidate)) ?? null;
}

function detectDockerHost(
  env: NodeJS.ProcessEnv,
  deps: FixCoreDnsDeps,
): { dockerHost?: string; runtime: ContainerRuntime } {
  if (env.DOCKER_HOST)
    return { dockerHost: env.DOCKER_HOST, runtime: dockerHostRuntime(env.DOCKER_HOST) ?? "custom" };

  const home = env.HOME || os.tmpdir();
  const existsSocket = deps.existsSocket ?? ((socketPath: string) => socketExists(socketPath, env));
  const colimaSocket = findFirstSocket(
    [
      path.join(home, ".colima/default/docker.sock"),
      path.join(home, ".config/colima/default/docker.sock"),
    ],
    { existsSocket },
  );
  if (colimaSocket) return { dockerHost: `unix://${colimaSocket}`, runtime: "colima" };

  const podmanCandidates =
    (deps.platform ?? process.platform) === "darwin"
      ? [path.join(home, ".local/share/containers/podman/machine/podman.sock")]
      : [
          path.join(
            env.XDG_RUNTIME_DIR || `/run/user/${deps.uid?.() ?? "1000"}`,
            "podman/podman.sock",
          ),
          `/run/user/${deps.uid?.() ?? "1000"}/podman/podman.sock`,
          "/run/podman/podman.sock",
        ];
  const podmanSocket = findFirstSocket(podmanCandidates, { existsSocket });
  if (podmanSocket) return { dockerHost: `unix://${podmanSocket}`, runtime: "podman" };

  return { runtime: "unknown" };
}

function commandOutput(result: CommandResult): string {
  return result.status === 0 ? result.stdout : "";
}

function defaultRunDocker(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): CommandResult {
  const result = dockerSpawnSync(args, { encoding: "utf-8", env: options.env });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function getColimaVmResolvConf(deps: FixCoreDnsDeps, env: NodeJS.ProcessEnv): string {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  if (!commandExists("colima")) return "";
  const run = deps.run ?? defaultRun;
  return commandOutput(
    run(
      "colima",
      ["ssh", "--profile", env.COLIMA_PROFILE || "default", "--", "cat", "/etc/resolv.conf"],
      {
        env,
      },
    ),
  );
}

export function runFixCoreDns(
  options: FixCoreDnsOptions = {},
  deps: FixCoreDnsDeps = {},
): FixCoreDnsResult {
  const env = { ...process.env, ...(deps.env ?? {}) };
  const log = deps.log ?? console.log;
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf-8"));
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const detected = detectDockerHost(env, deps);

  if (!detected.dockerHost || (detected.runtime !== "colima" && detected.runtime !== "podman")) {
    log("Skipping CoreDNS patch: no supported Colima or Podman Docker socket found.");
    return { exitCode: 0, runtime: detected.runtime, skipped: true };
  }

  const dockerEnv = { ...env, DOCKER_HOST: detected.dockerHost };
  const clustersOutput = commandOutput(
    runDocker(["ps", "--filter", "name=openshell-cluster", "--format", "{{.Names}}"], {
      env: dockerEnv,
    }),
  );
  const cluster = selectOpenshellClusterContainer(options.gatewayName, clustersOutput);
  if (!cluster) {
    const target = options.gatewayName ? ` for gateway '${options.gatewayName}'` : "";
    return {
      exitCode: 1,
      message: `ERROR: Could not uniquely determine the openshell cluster container${target}.`,
      runtime: detected.runtime,
    };
  }

  const containerResolvConf = commandOutput(
    runDocker(["exec", cluster, "cat", "/etc/resolv.conf"], { env: dockerEnv }),
  );
  const hostResolvConf = readFile("/etc/resolv.conf");
  const colimaVmResolvConf =
    detected.runtime === "colima" ? getColimaVmResolvConf(deps, dockerEnv) : undefined;
  const upstreamDns = resolveCoreDnsUpstream({
    colimaVmResolvConf,
    containerResolvConf,
    hostResolvConf,
    runtime: detected.runtime,
  });

  if (!upstreamDns) {
    return {
      cluster,
      exitCode: 1,
      message: `ERROR: Could not determine a non-loopback DNS upstream for ${detected.runtime}.`,
      runtime: detected.runtime,
    };
  }

  if (!isSafeDnsUpstream(upstreamDns)) {
    return {
      cluster,
      exitCode: 1,
      message: `ERROR: UPSTREAM_DNS='${upstreamDns}' contains invalid characters. Aborting.`,
      runtime: detected.runtime,
      upstreamDns,
    };
  }

  log(`Patching CoreDNS to forward to ${upstreamDns}...`);
  const patchJson = buildCoreDnsPatchJson(upstreamDns);
  for (const args of [
    [
      "exec",
      cluster,
      "kubectl",
      "patch",
      "configmap",
      "coredns",
      "-n",
      "kube-system",
      "--type",
      "merge",
      "-p",
      patchJson,
    ],
    ["exec", cluster, "kubectl", "rollout", "restart", "deploy/coredns", "-n", "kube-system"],
  ]) {
    const result = runDocker(args, { env: dockerEnv });
    if (result.status !== 0) {
      return {
        cluster,
        exitCode: result.status ?? 1,
        message: result.stderr.trim(),
        runtime: detected.runtime,
        upstreamDns,
      };
    }
  }

  log("CoreDNS patched. Waiting for rollout...");
  const rollout = runDocker(
    [
      "exec",
      cluster,
      "kubectl",
      "rollout",
      "status",
      "deploy/coredns",
      "-n",
      "kube-system",
      "--timeout=30s",
    ],
    { env: dockerEnv },
  );
  if (rollout.status !== 0) {
    return {
      cluster,
      exitCode: rollout.status ?? 1,
      message: rollout.stderr.trim(),
      runtime: detected.runtime,
      upstreamDns,
    };
  }

  log("Done. DNS should resolve in ~10 seconds.");
  return { cluster, exitCode: 0, runtime: detected.runtime, upstreamDns };
}
