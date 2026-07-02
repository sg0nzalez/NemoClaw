// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
  readSandboxBaseImageResolutionMetadata,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";

type StagedAgentBuild = {
  buildCtx: string;
  stagedDockerfile: string;
  baseImageResolutionMetadata: SandboxBaseImageResolutionMetadata | null;
};

type CreateAgentSandbox = (
  agent: AgentDefinition,
  options: {
    resolutionHint?: SandboxBaseImageResolutionMetadata | null;
    forceBaseImageRefresh?: boolean;
  },
) => StagedAgentBuild;

let resolutionHint: SandboxBaseImageResolutionMetadata | null = null;
let preResolvedMetadata: SandboxBaseImageResolutionMetadata | null = null;
let pendingRebuildHint: SandboxBaseImageResolutionMetadata | null = null;
let forceRefresh = false;

function envForcesRefresh(env: NodeJS.ProcessEnv): boolean {
  const value = String(env.NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

export function beginBaseImageResolutionFlow(options: {
  fresh: boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  resolutionHint = pendingRebuildHint;
  pendingRebuildHint = null;
  preResolvedMetadata = null;
  forceRefresh = options.fresh || envForcesRefresh(options.env ?? process.env);
}

export function handoffRebuildBaseImageResolutionHint(
  hint: SandboxBaseImageResolutionMetadata | null,
): void {
  pendingRebuildHint = hint;
}

export function captureBaseResolution(
  sandboxName: string,
): import("../state/registry").SandboxEntry | null {
  const registry = require("../state/registry") as typeof import("../state/registry");
  const entry = registry.getSandbox(sandboxName);
  if (!forceRefresh && !resolutionHint && entry?.imageTag) {
    resolutionHint = readSandboxBaseImageResolutionMetadata(entry.imageTag);
  }
  return entry;
}

export function createAgentSandboxWithResolution(agent: AgentDefinition): StagedAgentBuild {
  const { createAgentSandbox } = require("../agent/onboard") as {
    createAgentSandbox: CreateAgentSandbox;
  };
  const staged = createAgentSandbox(agent, {
    resolutionHint,
    forceBaseImageRefresh: forceRefresh,
  });
  preResolvedMetadata = staged.baseImageResolutionMetadata;
  return staged;
}

export function getBaseImageResolutionPatchOptions(): {
  resolutionHint: SandboxBaseImageResolutionMetadata | null;
  preResolvedBaseImageMetadata: SandboxBaseImageResolutionMetadata | null;
  forceBaseImageRefresh: boolean;
} {
  return {
    resolutionHint,
    preResolvedBaseImageMetadata: preResolvedMetadata,
    forceBaseImageRefresh: forceRefresh,
  };
}
