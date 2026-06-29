// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../adapters/openshell/runtime";
import { getCredential } from "../credentials/store";
import { createBuiltInChannelManifestRegistry, tryGetMessagingAgentId } from "../messaging";
import {
  collectMessagingSecretFiles,
  deliverMessagingSecretFiles,
} from "../messaging/applier/secret-file-delivery";
import type { MessagingAgentId, SandboxMessagingPlan } from "../messaging/manifest";
import { getActiveChannelsFromPlan } from "./messaging-plan-session";

interface MessagingAgentDescriptor {
  readonly name?: string;
}

function logDeliveryError(error: unknown): void {
  console.error(
    `  ⚠ Messaging secret-file delivery failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function deliverForAgentId(
  sandboxName: string,
  activeChannelIds: readonly string[],
  agentId: MessagingAgentId | null,
): void {
  if (!agentId || activeChannelIds.length === 0) return;
  const manifests = createBuiltInChannelManifestRegistry().list();
  const targets = collectMessagingSecretFiles(manifests, activeChannelIds, agentId);
  if (targets.length === 0) return;

  deliverMessagingSecretFiles(sandboxName, targets, {
    readSecret: (key) => process.env[key] ?? getCredential(key),
    uploadToSandbox: (sandbox, localPath, target) =>
      runOpenshell(["sandbox", "upload", sandbox, localPath, target], { ignoreError: true })
        .status === 0,
    execInSandbox: (sandbox, argv) =>
      runOpenshell(["sandbox", "exec", "--name", sandbox, "--", ...argv], { ignoreError: true })
        .status === 0,
    restartGateway: (sandbox) => {
      // Lazy require avoids pulling tunnel/services (and its process-level
      // color/TTY probes) into this module's import graph at load time.
      const { stopSandboxChannels } = require("../tunnel/services");
      stopSandboxChannels(sandbox);
    },
    log: (message) => console.log(message),
    warn: (message) => console.log(message),
  });
}

/**
 * Onboard entry: deliver in-process secret files (e.g. the Google Chat
 * service-account JSON) for the selected agent, then restart the gateway.
 * Best-effort — never throws, so it cannot fail onboarding.
 */
export function deliverSandboxMessagingSecretFiles(
  sandboxName: string,
  activeChannelIds: readonly string[],
  agent: MessagingAgentDescriptor | null,
): void {
  try {
    const agentId = agent
      ? tryGetMessagingAgentId(agent, createBuiltInChannelManifestRegistry().list())
      : "openclaw";
    deliverForAgentId(sandboxName, activeChannelIds, agentId);
  } catch (error) {
    logDeliveryError(error);
  }
}

/**
 * Rebuild entry: derive the active channels + agent from the compiled plan and
 * re-deliver secret files (the rebuilt image points at the file path, so it must
 * be re-uploaded). Best-effort — never throws.
 */
export function deliverSandboxMessagingSecretFilesForPlan(
  sandboxName: string,
  plan: SandboxMessagingPlan | null | undefined,
): void {
  try {
    if (!plan) return;
    deliverForAgentId(sandboxName, getActiveChannelsFromPlan(plan), plan.agent);
  } catch (error) {
    logDeliveryError(error);
  }
}
