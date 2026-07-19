// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../core/json-types";
import type { BaselineExclusionEntry, SandboxEntry } from "./registry";

/**
 * Coerce a persisted `baselineExclusions` value into well-formed entries,
 * dropping malformed records and collapsing duplicate keys (last wins). A
 * legacy registry without the field yields `undefined`, so old state loads
 * unchanged.
 */
export function normalizeBaselineExclusions(value: unknown): BaselineExclusionEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byKey = new Map<string, BaselineExclusionEntry>();
  for (const item of value) {
    if (!isObjectRecord(item)) continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    const digest = typeof item.digest === "string" ? item.digest.trim() : "";
    if (!key || !digest) continue;
    const entry: BaselineExclusionEntry = { key, digest };
    if (typeof item.acknowledgedAt === "string") entry.acknowledgedAt = item.acknowledgedAt;
    if (item.appliedAgentVersion === null) {
      entry.appliedAgentVersion = null;
    } else if (typeof item.appliedAgentVersion === "string") {
      entry.appliedAgentVersion = item.appliedAgentVersion;
    }
    byKey.set(key, entry);
  }
  return byKey.size > 0 ? [...byKey.values()] : undefined;
}

export function parseSandboxRegistryEntries(value: unknown): Array<[string, SandboxEntry]> {
  const sandboxes = isObjectRecord(value) ? value : {};
  return Object.entries(sandboxes).filter((entry): entry is [string, SandboxEntry] =>
    isSandboxEntryLike(entry[0], entry[1]),
  );
}

function isSandboxEntryLike(name: string, entry: unknown): entry is SandboxEntry {
  return (
    isObjectRecord(entry) &&
    typeof entry.name === "string" &&
    entry.name === name &&
    entry.name.trim().length > 0
  );
}

export function retainedDefaultSandbox(
  defaultSandbox: string | null,
  sandboxes: Record<string, SandboxEntry>,
): string | null {
  if (defaultSandbox === null) return null;
  if (!Object.prototype.hasOwnProperty.call(sandboxes, defaultSandbox)) return null;
  const entry = sandboxes[defaultSandbox];
  if (!entry || entry.pendingRouteReservation === true) return null;
  return defaultSandbox;
}
