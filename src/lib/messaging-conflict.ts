// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Cross-sandbox messaging-channel conflict detection.
//
// Telegram (getUpdates long-polling), Discord (gateway connection), and Slack
// (Socket Mode) all enforce one active consumer per channel credential. Two
// sandboxes sharing the same token silently break both bridges; see issue #1953.
//
// The registry persists which channels each sandbox uses plus a non-secret hash
// of the provider credential when available. This module is a thin public
// adapter over `src/lib/messaging/applier/conflict-detection.ts`, which holds
// all core detection logic and the probe factory.

import type { SandboxEntry } from "./state/registry";
import type { SandboxMessagingPlan } from "./messaging/manifest";
import {
  backfillLegacyEntryChannels,
  detectAllOverlapsInEntries,
  findConflictsInEntries,
  planToConflictChannelRequests,
  type ConflictMatch,
  type ConflictReason,
  type MessagingConflictProbe,
} from "./messaging/applier";

export { createMessagingConflictProbe } from "./messaging/applier";

interface ConflictRegistry {
  listSandboxes: () => { sandboxes: SandboxEntry[]; defaultSandbox?: string | null };
  updateSandbox: (name: string, updates: Partial<SandboxEntry>) => boolean;
}

type ChannelRequest = string | { channel: string; credentialHashes?: Record<string, string | null | undefined> };

function normalizeRequest(request: ChannelRequest) {
  if (typeof request === "string") {
    return request ? { channel: request, credentialHashes: {} } : null;
  }
  if (!request || typeof request.channel !== "string" || request.channel.length === 0) return null;
  return request;
}

/**
 * For registry entries missing `messagingChannels`, probe OpenShell to infer
 * which channels the sandbox was onboarded with, and write the result back to
 * the registry. Safe to call repeatedly — entries with the field set are left
 * alone. Failures to probe any one sandbox are swallowed so that a flaky
 * gateway does not block status or onboarding.
 */
export function backfillMessagingChannels(
  registry: ConflictRegistry,
  probe: MessagingConflictProbe,
): void {
  const { sandboxes } = registry.listSandboxes();
  backfillLegacyEntryChannels(sandboxes, probe, (name, channels) => {
    registry.updateSandbox(name, { messagingChannels: channels });
  });
}

/**
 * Return every (channel, other-sandbox) pair where another sandbox in the
 * registry already has one of the requested channels in use with either a
 * matching credential hash or insufficient hash metadata to prove it differs.
 */
export function findChannelConflicts(
  currentSandbox: string | null,
  enabledChannels: ChannelRequest[],
  registry: ConflictRegistry,
): ConflictMatch[] {
  if (!Array.isArray(enabledChannels) || enabledChannels.length === 0) return [];
  const requests = enabledChannels.map(normalizeRequest).filter(
    (r): r is NonNullable<ReturnType<typeof normalizeRequest>> => !!r,
  );
  if (requests.length === 0) return [];
  const { sandboxes } = registry.listSandboxes();
  return findConflictsInEntries(currentSandbox, requests, sandboxes);
}

/**
 * Detect overlaps across every sandbox in the registry, returning each pair at
 * most once. Used by `nemoclaw status` to warn users whose sandboxes already
 * share a messaging token or whose legacy metadata is too old to verify.
 */
export function findAllOverlaps(registry: ConflictRegistry): Array<{
  channel: string;
  sandboxes: [string, string];
  reason: ConflictReason;
}> {
  const { sandboxes } = registry.listSandboxes();
  return detectAllOverlapsInEntries(sandboxes);
}

/**
 * Plan-driven variant of `findChannelConflicts`. Derives the channel request
 * list from a compiled `SandboxMessagingPlan` instead of requiring the caller
 * to build credential hashes from raw channel constants.
 *
 * Disabled channels and bindings without a credential hash are excluded
 * automatically by `planToConflictChannelRequests`.
 */
export function findChannelConflictsFromPlan(
  currentSandbox: string | null,
  plan: SandboxMessagingPlan,
  registry: ConflictRegistry,
): ConflictMatch[] {
  return findChannelConflicts(currentSandbox, planToConflictChannelRequests(plan), registry);
}
