// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  type HostCliClient,
  resultText,
  type SandboxClient,
  trustedSandboxShellScript,
} from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

interface HermesGpuStartupProofOptions {
  env: NodeJS.ProcessEnv;
  host: HostCliClient;
  install: Pick<ShellProbeResult, "stdout" | "stderr">;
  sandbox: SandboxClient;
  sandboxName: string;
  status: Pick<ShellProbeResult, "stdout" | "stderr">;
}

export function hermesGpuStartupE2eEnabled(): boolean {
  return process.env.NEMOCLAW_SANDBOX_GPU === "1" && process.env.NEMOCLAW_DOCKER_GPU_PATCH === "1";
}

export function hermesGpuStartupEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.NEMOCLAW_SANDBOX_GPU) {
    env.NEMOCLAW_SANDBOX_GPU = process.env.NEMOCLAW_SANDBOX_GPU;
  }
  if (process.env.NEMOCLAW_DOCKER_GPU_PATCH) {
    env.NEMOCLAW_DOCKER_GPU_PATCH = process.env.NEMOCLAW_DOCKER_GPU_PATCH;
  }
  return env;
}

export async function assertHermesGpuStartupProofIfEnabled({
  env,
  host,
  install,
  sandbox,
  sandboxName,
  status,
}: HermesGpuStartupProofOptions): Promise<void> {
  if (!hermesGpuStartupE2eEnabled()) return;

  expect(resultText(install)).toContain(
    "Recreating OpenShell Docker sandbox container with NVIDIA GPU access",
  );
  expect(resultText(install)).toContain("Docker GPU mode selected:");
  expect(resultText(status)).toMatch(/Phase:\s*Ready/i);
  expect(resultText(status)).toContain("Sandbox GPU: enabled");
  expect(resultText(status)).toContain("CUDA verified");
  expect(resultText(status)).not.toMatch(/last CUDA proof failed|CUDA unverified/i);

  const openshellState = await sandbox.openshell(["sandbox", "get", sandboxName], {
    artifactName: "phase-4-openshell-sandbox-ready-gpu-startup",
    env,
    timeoutMs: 30_000,
  });
  expect(openshellState.exitCode, resultText(openshellState)).toBe(0);
  expect(resultText(openshellState)).toMatch(/Phase:\s*Ready/i);

  const pid1Topology = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      String.raw`python3 -c 'import json; from pathlib import Path; argv=[item.decode("utf-8", "strict") for item in Path("/proc/1/cmdline").read_bytes().split(b"\0") if item]; print(json.dumps({"argv0": argv[0] if argv else "", "has_nemoclaw_start": any(item in ("nemoclaw-start", "/usr/local/bin/nemoclaw-start") for item in argv)}))'`,
    ),
    {
      artifactName: "phase-4-gpu-startup-pid1-topology",
      env,
      timeoutMs: 30_000,
    },
  );
  expect(pid1Topology.exitCode, resultText(pid1Topology)).toBe(0);
  expect(JSON.parse(pid1Topology.stdout)).toEqual({
    argv0: "/opt/openshell/bin/openshell-sandbox",
    has_nemoclaw_start: true,
  });

  const startupConfig = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      String.raw`set -eu; python3 -c 'import re; from pathlib import Path; lines=Path("/sandbox/.hermes/.env").read_text(encoding="utf-8").splitlines(); matches=[line for line in lines if re.fullmatch(r"API_SERVER_KEY=[0-9a-f]{64}", line)]; raise SystemExit(0 if len(matches) == 1 else 1)'; sha256sum -c /etc/nemoclaw/hermes.config-hash --status; sha256sum -c /sandbox/.hermes/.config-hash --status; if grep -Fq 'ensure-api-key is restricted to the Hermes PID 1 startup transaction' /tmp/nemoclaw-start.log || grep -Fq 'Hermes runtime config guard refuses mutation under a foreign PID 1' /tmp/nemoclaw-start.log; then echo 'Hermes startup guard refusal found' >&2; exit 1; fi; echo OK`,
    ),
    {
      artifactName: "phase-4-gpu-startup-config-and-guard",
      env,
      timeoutMs: 30_000,
    },
  );
  expect(startupConfig.exitCode, resultText(startupConfig)).toBe(0);
  expect(startupConfig.stdout.trim()).toBe("OK");

  const runningContainers = await host.command(
    "docker",
    [
      "ps",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--format",
      "{{.ID}} {{.Names}}",
    ],
    {
      artifactName: "phase-4-gpu-startup-running-containers",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(runningContainers.exitCode, resultText(runningContainers)).toBe(0);
  const containerRows = runningContainers.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  expect(
    containerRows,
    `expected one running container, got ${runningContainers.stdout}`,
  ).toHaveLength(1);
  const [containerId = ""] = containerRows[0].split(/\s+/, 1);
  expect(containerId).not.toBe("");

  const containerState = await host.command(
    "docker",
    ["inspect", "--format", "{{.State.Status}} {{.RestartCount}}", containerId],
    {
      artifactName: "phase-4-gpu-startup-container-state",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(containerState.exitCode, resultText(containerState)).toBe(0);
  expect(containerState.stdout.trim()).toBe("running 0");

  const allContainers = await host.command(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--format",
      "{{.Names}}",
    ],
    {
      artifactName: "phase-4-gpu-startup-all-containers",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(allContainers.exitCode, resultText(allContainers)).toBe(0);
  expect(
    allContainers.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ).toHaveLength(1);
}
