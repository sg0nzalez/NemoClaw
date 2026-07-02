// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  dockerCapture as defaultDockerCapture,
  dockerLogs as defaultDockerLogs,
} from "../adapters/docker";
import { redactFull } from "../security/redact";
import type {
  DockerContainerInspect,
  DockerGpuPatchDeps,
  DockerGpuPatchDiagnostics,
  DockerGpuPatchFailureContext,
  DockerGpuPatchResult,
} from "./docker-gpu-patch";
import {
  captureDockerGpuPatchSandboxSnapshot,
  classifyDockerGpuPatchFailure,
  collectDockerGpuPatchDiagnostics,
} from "./docker-gpu-patch";

const DOCKER_GPU_PATCH_TIMEOUT_MS = 30_000;
const PRE_ROLLBACK_DIAGNOSTICS_TOTAL_BUDGET_MS = 10_000;
const PRE_ROLLBACK_DIAGNOSTICS_CALL_TIMEOUT_MS = 2_000;
const SENSITIVE_ENV_KEY =
  /(?:api_?key|token|secret|password|credential|authorization|cookie|private_?key|proxy)/i;
const EXTRA_PLACEHOLDER_KEYS_ENV = "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS";

type PreRollbackDiagnosticsDeps = Pick<
  DockerGpuPatchDeps,
  "runCaptureOpenshell" | "dockerCapture" | "dockerLogs" | "homedir" | "now"
>;

function inspectEnv(inspect: DockerContainerInspect): Map<string, string> {
  const env = new Map<string, string>();
  for (const assignment of inspect.Config?.Env ?? []) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    env.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  }
  return env;
}

function startupCommandEnv(inspect: DockerContainerInspect): Map<string, string> {
  const assignments = new Map<string, string>();
  const command = inspectEnv(inspect).get("OPENSHELL_SANDBOX_COMMAND") ?? "";
  const tokens = command.trim().split(/\s+/u);
  if (tokens.shift() !== "env") return assignments;
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator <= 0) break;
    assignments.set(token.slice(0, separator), token.slice(separator + 1));
  }
  return assignments;
}

function rememberSensitiveInspectValues(
  inspect: DockerContainerInspect,
  sensitiveValues: Set<string>,
): void {
  const env = inspectEnv(inspect);
  const startupEnv = startupCommandEnv(inspect);
  const extraPlaceholderKeys = new Set(
    (startupEnv.get(EXTRA_PLACEHOLDER_KEYS_ENV) ?? env.get(EXTRA_PLACEHOLDER_KEYS_ENV) ?? "")
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const [key, value] of [...env, ...startupEnv]) {
    if ((SENSITIVE_ENV_KEY.test(key) || extraPlaceholderKeys.has(key)) && value.length > 0) {
      sensitiveValues.add(value);
    }
  }
}

function redactDiagnosticText(text: string, sensitiveValues: Set<string>): string {
  let redacted = redactFull(text);
  for (const value of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(value).join("<REDACTED>");
  }
  return redacted;
}

function summarizeArgv(
  value: string[] | string | null | undefined,
  sensitiveValues: Set<string>,
): string[] | string | null | undefined {
  if (!Array.isArray(value)) {
    return typeof value === "string" ? redactDiagnosticText(value, sensitiveValues) : value;
  }
  if (value.length <= 1) {
    return value.map((entry) => redactDiagnosticText(entry, sensitiveValues));
  }
  return [
    redactDiagnosticText(value[0] ?? "", sensitiveValues),
    `<${String(value.length - 1)} additional arguments omitted>`,
  ];
}

function sanitizeInspectForDiagnostics(
  inspect: DockerContainerInspect,
  sensitiveValues: Set<string>,
): DockerContainerInspect {
  const envKeys = [...inspectEnv(inspect).keys()].sort();
  const labels = Object.fromEntries(
    Object.entries(inspect.Config?.Labels ?? {})
      .filter(([key]) => key.startsWith("openshell.ai/"))
      .map(([key, value]) => [key, redactDiagnosticText(value, sensitiveValues)]),
  );
  const networks = Object.fromEntries(
    Object.entries(inspect.NetworkSettings?.Networks ?? {}).map(([name, network]) => [
      redactDiagnosticText(name, sensitiveValues),
      {
        IPAddress: network.IPAddress,
        Gateway: network.Gateway,
        Aliases: network.Aliases?.map((alias) => redactDiagnosticText(alias, sensitiveValues)),
      },
    ]),
  );
  return {
    Id: inspect.Id,
    Name: inspect.Name ? redactDiagnosticText(inspect.Name, sensitiveValues) : inspect.Name,
    Config: {
      Image: inspect.Config?.Image,
      User: inspect.Config?.User,
      Entrypoint: summarizeArgv(inspect.Config?.Entrypoint, sensitiveValues),
      Cmd: summarizeArgv(inspect.Config?.Cmd, sensitiveValues),
      Env: envKeys.map((key) => `${key}=<REDACTED>`),
      Labels: labels,
    },
    HostConfig: {
      NetworkMode: inspect.HostConfig?.NetworkMode,
      RestartPolicy: inspect.HostConfig?.RestartPolicy,
      GroupAdd: inspect.HostConfig?.GroupAdd,
    },
    NetworkSettings: { Networks: networks },
  };
}

function redactedDiagnosticsDeps(deps: PreRollbackDiagnosticsDeps): PreRollbackDiagnosticsDeps {
  const capture = deps.dockerCapture ?? defaultDockerCapture;
  const logs = deps.dockerLogs ?? defaultDockerLogs;
  const sensitiveValues = new Set<string>();
  const deadline = Date.now() + PRE_ROLLBACK_DIAGNOSTICS_TOTAL_BUDGET_MS;
  const boundedOptions = (options: Record<string, unknown> | undefined) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    return {
      ...options,
      timeout: Math.min(PRE_ROLLBACK_DIAGNOSTICS_CALL_TIMEOUT_MS, remaining),
    };
  };
  return {
    ...deps,
    dockerCapture: (args, options) => {
      const bounded = boundedOptions(options);
      if (!bounded) return "";
      const output = capture(args, bounded);
      if (args[0] !== "inspect" || args[1] === "--format" || !output.trim()) {
        return redactDiagnosticText(output, sensitiveValues);
      }
      try {
        const parsed = JSON.parse(output);
        const entries = (Array.isArray(parsed) ? parsed : [parsed]) as DockerContainerInspect[];
        for (const entry of entries) rememberSensitiveInspectValues(entry, sensitiveValues);
        return JSON.stringify(
          entries.map((entry) => sanitizeInspectForDiagnostics(entry, sensitiveValues)),
        );
      } catch {
        return redactDiagnosticText(output, sensitiveValues);
      }
    },
    dockerLogs: (containerName, options) => {
      const bounded = boundedOptions(options);
      if (!bounded) return "";
      return redactDiagnosticText(logs(containerName, bounded), sensitiveValues);
    },
    runCaptureOpenshell: deps.runCaptureOpenshell
      ? (args, options) => {
          const bounded = boundedOptions(options);
          if (!bounded) return "";
          return redactDiagnosticText(
            deps.runCaptureOpenshell?.(args, bounded) ?? "",
            sensitiveValues,
          );
        }
      : undefined,
  };
}

export function captureDockerGpuPreRollbackDiagnostics(
  sandboxName: string,
  result: DockerGpuPatchResult,
  deps: PreRollbackDiagnosticsDeps = {},
): DockerGpuPatchDiagnostics | null {
  const context: DockerGpuPatchFailureContext = {
    sandboxName,
    oldContainerId: result.oldContainerId,
    newContainerId: result.newContainerId,
    backupContainerName: result.backupContainerName,
    selectedMode: result.mode,
  };
  const diagnosticDeps = redactedDiagnosticsDeps(deps);
  const snapshot = captureDockerGpuPatchSandboxSnapshot(
    sandboxName,
    { patchedContainerId: result.newContainerId },
    diagnosticDeps,
  );
  const classification = classifyDockerGpuPatchFailure(snapshot, result.mode);
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    { context, selectedMode: result.mode, snapshot, classification },
    diagnosticDeps,
  );
  if (!diagnostics) return null;

  try {
    const dockerCapture = diagnosticDeps.dockerCapture ?? defaultDockerCapture;
    const top = dockerCapture(["top", result.newContainerId, "-eo", "user,pid,ppid,stat,comm"], {
      ignoreError: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (top.trim()) {
      fs.writeFileSync(path.join(diagnostics.dir, "docker-top.txt"), `${top.trimEnd()}\n`, {
        mode: 0o600,
      });
    }
  } catch {
    // The inspect/log bundle is still useful when the short-lived clone exits
    // before docker top can observe it.
  }

  console.error(`  Pre-rollback diagnostics saved: ${diagnostics.dir}`);
  return diagnostics;
}
