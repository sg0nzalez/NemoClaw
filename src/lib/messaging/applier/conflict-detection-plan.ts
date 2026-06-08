// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../manifest";
import type { ConflictRequest } from "./conflict-detection-types";

/**
 * Return the channel IDs that are active (not disabled) in a compiled plan.
 * Aligns with `enabledPlanChannels()` in plan-filter.ts: a channel is active
 * only when `channel.active && !channel.disabled` and it is not in
 * `plan.disabledChannels`.
 */
export function getActiveChannelIdsFromPlan(plan: SandboxMessagingPlan): string[] {
  const disabled = new Set(plan.disabledChannels);
  return plan.channels
    .filter((c) => c.active && !c.disabled && !disabled.has(c.channelId))
    .map((c) => c.channelId);
}

/**
 * Return credential hashes keyed by providerEnvKey from a compiled plan,
 * optionally scoped to a single channel.
 */
export function getCredentialHashesFromPlan(
  plan: SandboxMessagingPlan,
  channelId?: string,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const b of plan.credentialBindings) {
    if (channelId !== undefined && b.channelId !== channelId) continue;
    if (b.credentialHash) hashes[b.providerEnvKey] = b.credentialHash;
  }
  return hashes;
}

/**
 * Build conflict requests from plan credential bindings.
 *
 * Bindings are grouped by channelId, disabled channels are skipped, and
 * credentialAvailable=false bindings are omitted. A binding with no
 * credentialHash still produces a channel request so later comparison can use
 * conservative unknown-token behavior instead of dropping the channel.
 */
export function planToConflictChannelRequests(plan: SandboxMessagingPlan): ConflictRequest[] {
  const activeChannelIds = new Set(getActiveChannelIdsFromPlan(plan));
  const byChannel = new Map<string, Record<string, string>>();

  for (const binding of plan.credentialBindings) {
    if (!activeChannelIds.has(binding.channelId) || !binding.credentialAvailable) continue;
    const hashes = byChannel.get(binding.channelId) ?? {};
    if (binding.credentialHash) hashes[binding.providerEnvKey] = binding.credentialHash;
    byChannel.set(binding.channelId, hashes);
  }

  return Array.from(byChannel.entries()).map(([channel, credentialHashes]) => ({
    channel,
    credentialHashes,
  }));
}
