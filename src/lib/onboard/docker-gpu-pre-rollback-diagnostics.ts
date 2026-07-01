// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { dockerCapture as defaultDockerCapture } from "../adapters/docker";
import type {
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

type PreRollbackDiagnosticsDeps = Pick<
  DockerGpuPatchDeps,
  "runCaptureOpenshell" | "dockerCapture" | "dockerLogs" | "homedir" | "now"
>;

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
  const snapshot = captureDockerGpuPatchSandboxSnapshot(
    sandboxName,
    { patchedContainerId: result.newContainerId },
    deps,
  );
  const classification = classifyDockerGpuPatchFailure(snapshot, result.mode);
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    { context, selectedMode: result.mode, snapshot, classification },
    deps,
  );
  if (!diagnostics) return null;

  try {
    const dockerCapture = deps.dockerCapture ?? defaultDockerCapture;
    const top = dockerCapture(["top", result.newContainerId, "-eo", "user,pid,ppid,stat,args"], {
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
