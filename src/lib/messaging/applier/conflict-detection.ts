// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../manifest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProbeResult = "present" | "absent" | "error";
export type ConflictReason = "matching-token" | "unknown-token";

export interface MessagingConflictProbe {
  // Tri-state — "error" is distinct from "absent" so a transient gateway
  // failure does not get collapsed into "provider not attached" and then
  // persisted as a bogus empty messagingChannels.
  providerExists: (name: string) => ProbeResult;
}

export interface MessagingConflictProbeGatewayDeps {
  /** Run `openshell sandbox list`; return true if the gateway answered. */
  checkGatewayLiveness: () => boolean;
  /** Check if the named OpenShell provider exists; assumes gateway is alive. */
  providerExists: (name: string) => boolean;
}

export interface ConflictRequest {
  readonly channel: string;
  readonly credentialHashes?: Record<string, string | null | undefined>;
}

export interface ConflictMatch {
  readonly channel: string;
  readonly sandbox: string;
  readonly reason: ConflictReason;
}

/**
 * Minimal shape of a registry entry that conflict detection needs.
 * Satisfied by `SandboxEntry` from `./state/registry`.
 */
export interface ConflictRegistryEntry {
  readonly name: string;
  readonly messaging?: { readonly plan: SandboxMessagingPlan } | null;
  readonly messagingChannels?: readonly string[] | null;
  readonly disabledChannels?: readonly string[] | null;
  readonly providerCredentialHashes?: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// Probe factory
// ---------------------------------------------------------------------------

/**
 * Build a tri-state `MessagingConflictProbe` from plain openshell runner deps.
 *
 * The liveness result is cached so the `sandbox list` call is issued at most
 * once per probe instance. A transient gateway failure (`checkGatewayLiveness`
 * returns false) causes all subsequent `providerExists` calls to return "error"
 * rather than "absent", preventing a flaky gateway from being mis-recorded as
 * "no providers" and permanently suppressing future backfill retries.
 */
export function createMessagingConflictProbe(
  deps: MessagingConflictProbeGatewayDeps,
): MessagingConflictProbe {
  let alive: boolean | null = null;
  return {
    providerExists: (name) => {
      if (alive === null) alive = deps.checkGatewayLiveness();
      if (!alive) return "error";
      return deps.providerExists(name) ? "present" : "absent";
    },
  };
}

// ---------------------------------------------------------------------------
// Plan-to-request helpers
// ---------------------------------------------------------------------------

/**
 * Return the channel IDs that are active (not disabled) in a compiled plan.
 * Aligns with `enabledPlanChannels()` in plan-filter.ts: a channel is active
 * only when `channel.active && !channel.disabled` AND it is not in
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
 *
 * Only bindings that carry a `credentialHash` are included. When `channelId`
 * is provided only that channel's bindings are returned, which prevents
 * hashes from other channels in the same sandbox from contaminating
 * single-channel conflict comparisons.
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
 * Build a `ConflictRequest[]` from a compiled plan's credential bindings.
 *
 * Groups bindings by channelId (e.g. Slack has SLACK_BOT_TOKEN and
 * SLACK_APP_TOKEN) and excludes:
 *   - channels in `plan.disabledChannels` (bridge is paused, not in use)
 *   - bindings where the credential is not available (`credentialAvailable`
 *     false) — e.g. WhatsApp, which has no host-side token provider
 *
 * When a binding has no `credentialHash` yet (the compiler populates this
 * field once the credential-binding engine is updated), the channel is still
 * included with an empty `credentialHashes` map, which falls through to
 * `"unknown-token"` conservative detection. This preserves the safety
 * behaviour while the compiler migration is in flight.
 */
export function planToConflictChannelRequests(plan: SandboxMessagingPlan): ConflictRequest[] {
  const disabledSet = new Set(plan.disabledChannels);
  const byChannel = new Map<string, Record<string, string>>();

  for (const binding of plan.credentialBindings) {
    if (disabledSet.has(binding.channelId) || !binding.credentialAvailable) continue;
    const hashes = byChannel.get(binding.channelId) ?? {};
    if (binding.credentialHash) hashes[binding.providerEnvKey] = binding.credentialHash;
    byChannel.set(binding.channelId, hashes);
  }

  return Array.from(byChannel.entries()).map(([channel, credentialHashes]) => ({
    channel,
    credentialHashes,
  }));
}

// ---------------------------------------------------------------------------
// Entry resolution — plan-preferred, legacy-fallback
// ---------------------------------------------------------------------------

/**
 * Return the active (non-disabled) channel IDs for a registry entry.
 * Prefers `entry.messaging.plan` data; falls back to the legacy
 * `messagingChannels`/`disabledChannels` flat fields for entries that predate
 * the plan architecture. Returns `null` when the entry has neither.
 */
export function resolveActiveChannelsFromEntry(
  entry: ConflictRegistryEntry,
): string[] | null {
  if (entry.messaging?.plan) {
    return getActiveChannelIdsFromPlan(entry.messaging.plan);
  }
  if (!Array.isArray(entry.messagingChannels)) return null;
  const disabled = new Set(Array.isArray(entry.disabledChannels) ? entry.disabledChannels : []);
  return (entry.messagingChannels as string[]).filter((c) => !disabled.has(c));
}

/**
 * Return credential hashes scoped to `channelId` for a registry entry.
 *
 * For plan-backed entries the lookup is channel-scoped: only bindings for the
 * requested channel are considered. When the plan exists but carries no hashes
 * for the channel (compiler migration in flight), the function falls back to
 * the legacy `providerCredentialHashes` flat field so no safety coverage is
 * lost during the transition.
 *
 * For legacy entries without a plan the entire `providerCredentialHashes`
 * object is returned unchanged (same behavior as before this architecture).
 */
function resolveChannelHashesFromEntry(
  entry: ConflictRegistryEntry,
  channelId: string,
): Record<string, string> {
  if (entry.messaging?.plan) {
    const planHashes = getCredentialHashesFromPlan(entry.messaging.plan, channelId);
    if (Object.keys(planHashes).length > 0) return planHashes;
    // Plan exists but no hashes yet for this channel — fall back to legacy
    // field so matching-token detection is not silently downgraded.
  }
  return (entry.providerCredentialHashes as Record<string, string>) ?? {};
}

// ---------------------------------------------------------------------------
// Detection — pure functions operating on ConflictRegistryEntry
// ---------------------------------------------------------------------------

/**
 * True when `channel` is active (present and not disabled) in `entry`.
 * Disabled channels must not block another sandbox from claiming the same
 * token — the bridge is paused so the credential is not in use.
 */
export function hasStoredChannelInEntry(
  entry: ConflictRegistryEntry,
  channel: string,
): boolean {
  return resolveActiveChannelsFromEntry(entry)?.includes(channel) ?? false;
}

/**
 * Determine the conflict reason between `entry`'s stored state and a new
 * channel request, or `null` if there is no conflict.
 *
 * Hash comparison is scoped to the requested channel so that credentials
 * from other channels on the same sandbox do not produce false positives.
 * When no hashes are available the comparison falls back to "unknown-token"
 * (conservative: warn even without definitive proof of sharing).
 */
export function conflictReasonForRequest(
  entry: ConflictRegistryEntry,
  request: ConflictRequest,
): ConflictReason | null {
  if (!hasStoredChannelInEntry(entry, request.channel)) return null;
  const requestedHashes = request.credentialHashes ?? {};
  const storedHashes = resolveChannelHashesFromEntry(entry, request.channel);
  const keys =
    Object.keys(storedHashes).length > 0
      ? Object.keys(storedHashes)
      : Object.keys(requestedHashes);
  if (keys.length === 0) return "unknown-token";

  let sawUnknown = false;
  for (const key of keys) {
    const rh = (requestedHashes[key] as string | null | undefined) ?? null;
    const sh = storedHashes[key] ?? null;
    if (rh && sh) {
      if (rh === sh) return "matching-token";
      continue;
    }
    sawUnknown = true;
  }
  return sawUnknown ? "unknown-token" : null;
}

/**
 * Determine the conflict reason between two registry entries sharing `channel`,
 * or `null` if there is no conflict. Returns each pair at most once (the
 * caller is responsible for ordered iteration).
 *
 * Hash comparison is scoped to `channel` for plan-backed entries.
 */
export function conflictReasonForPair(
  channel: string,
  left: ConflictRegistryEntry,
  right: ConflictRegistryEntry,
): ConflictReason | null {
  if (!hasStoredChannelInEntry(left, channel) || !hasStoredChannelInEntry(right, channel)) {
    return null;
  }
  const lh = resolveChannelHashesFromEntry(left, channel);
  const rh = resolveChannelHashesFromEntry(right, channel);
  const keys = [...new Set([...Object.keys(lh), ...Object.keys(rh)])];
  if (keys.length === 0) return "unknown-token";

  let sawUnknown = false;
  for (const key of keys) {
    const l = lh[key] ?? null;
    const r = rh[key] ?? null;
    if (l && r) {
      if (l === r) return "matching-token";
      continue;
    }
    sawUnknown = true;
  }
  return sawUnknown ? "unknown-token" : null;
}

/**
 * Return every (channel, other-sandbox) pair where another entry already has
 * one of the requested channels in use with either a matching credential hash
 * or insufficient hash metadata to prove it differs.
 */
export function findConflictsInEntries(
  currentSandbox: string | null,
  requests: readonly ConflictRequest[],
  entries: readonly ConflictRegistryEntry[],
): ConflictMatch[] {
  const others = entries.filter(
    (e) =>
      e.name !== currentSandbox &&
      (Array.isArray(e.messagingChannels) || e.messaging?.plan != null),
  );
  return requests.flatMap((request) =>
    others.flatMap((entry) => {
      const reason = conflictReasonForRequest(entry, request);
      return reason ? [{ channel: request.channel, sandbox: entry.name, reason }] : [];
    }),
  );
}

/**
 * Detect overlaps across all entries, returning each pair at most once.
 * Used by `nemoclaw status` to surface sandboxes that already share a token.
 */
export function detectAllOverlapsInEntries(
  entries: readonly ConflictRegistryEntry[],
): Array<{ channel: string; sandboxes: [string, string]; reason: ConflictReason }> {
  const byChannel = new Map<string, ConflictRegistryEntry[]>();
  for (const entry of entries) {
    const activeChannels = resolveActiveChannelsFromEntry(entry);
    if (!activeChannels) continue;
    for (const channel of activeChannels) {
      const list = byChannel.get(channel) ?? [];
      list.push(entry);
      byChannel.set(channel, list);
    }
  }

  const overlaps: Array<{
    channel: string;
    sandboxes: [string, string];
    reason: ConflictReason;
  }> = [];
  for (const [channel, channelEntries] of byChannel) {
    if (channelEntries.length < 2) continue;
    for (let i = 0; i < channelEntries.length; i += 1) {
      for (let j = i + 1; j < channelEntries.length; j += 1) {
        const reason = conflictReasonForPair(channel, channelEntries[i], channelEntries[j]);
        if (reason) {
          overlaps.push({
            channel,
            sandboxes: [channelEntries[i].name, channelEntries[j].name],
            reason,
          });
        }
      }
    }
  }
  return overlaps;
}

/**
 * For entries missing `messagingChannels`, probe OpenShell to infer which
 * channels the sandbox was onboarded with, and call `updateEntry` for each
 * resolved sandbox. Safe to call repeatedly — entries with `messagingChannels`
 * already set are skipped. Probe errors abort the write for that sandbox so a
 * flaky gateway does not permanently hide real overlaps.
 */
export function backfillLegacyEntryChannels(
  entries: readonly ConflictRegistryEntry[],
  probe: MessagingConflictProbe,
  updateEntry: (name: string, channels: string[]) => void,
  providerSuffixes: Record<string, string>,
): void {
  for (const entry of entries) {
    if (Array.isArray(entry.messagingChannels)) continue;
    const discovered: string[] = [];
    let probeFailed = false;
    for (const channel of Object.keys(providerSuffixes)) {
      const providerName = `${entry.name}${providerSuffixes[channel]}`;
      let state: ProbeResult;
      try {
        state = probe.providerExists(providerName);
      } catch {
        state = "error";
      }
      if (state === "present") {
        discovered.push(channel);
      } else if (state === "error") {
        probeFailed = true;
        break;
      }
    }
    if (!probeFailed) {
      updateEntry(entry.name, discovered);
    }
  }
}
