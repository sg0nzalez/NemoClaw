// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const TOOL_DISCLOSURE_AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;

export const TOOL_DISCLOSURE_MODES = ["progressive", "direct"] as const;
export const STATIC_CATALOG_SIZES = [16, 64, 256, 512, 2_209] as const;

export type ToolDisclosureAgent = (typeof TOOL_DISCLOSURE_AGENTS)[number];
export type ToolDisclosureMode = (typeof TOOL_DISCLOSURE_MODES)[number];
export type ToolDisclosurePhase =
  | "static-visibility"
  | "small-control"
  | "primary"
  | "large-stress";

export interface ScheduledToolDisclosureRun {
  run_id: string;
  campaign: 1 | 2;
  phase: ToolDisclosurePhase;
  agent: ToolDisclosureAgent;
  mode: ToolDisclosureMode;
  catalog_size: number;
  repetition: number;
  task_id?: string;
  pair_id: string;
  scored: boolean;
}

export interface ToolDisclosureScheduleOptions {
  primaryTaskIds: readonly string[];
  stressTaskIds: readonly string[];
  seed: number;
  campaigns?: readonly (1 | 2)[];
}

interface PairBlock {
  sortKey: number;
  runs: [ScheduledToolDisclosureRun, ScheduledToolDisclosureRun];
}

function xorshift32(value: number): number {
  let state = value | 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function stableHash(text: string, seed: number): number {
  let state = seed >>> 0;
  for (const char of text) {
    state = xorshift32(state ^ (char.codePointAt(0) ?? 0));
  }
  return state;
}

function runId(
  campaign: number,
  phase: ToolDisclosurePhase,
  agent: ToolDisclosureAgent,
  mode: ToolDisclosureMode,
  catalogSize: number,
  taskId: string | undefined,
  repetition: number,
): string {
  return [
    `c${campaign}`,
    phase,
    agent,
    mode,
    `n${catalogSize}`,
    taskId ?? "capture",
    `r${repetition}`,
  ].join("--");
}

function makePair(
  campaign: 1 | 2,
  phase: ToolDisclosurePhase,
  agent: ToolDisclosureAgent,
  catalogSize: number,
  taskId: string | undefined,
  repetition: number,
  seed: number,
): PairBlock {
  const pairId = [
    `c${campaign}`,
    phase,
    agent,
    `n${catalogSize}`,
    taskId ?? "capture",
    `r${repetition}`,
  ].join("--");
  const modes: [ToolDisclosureMode, ToolDisclosureMode] =
    stableHash(pairId, seed) % 2 === 0 ? ["progressive", "direct"] : ["direct", "progressive"];
  const scored = phase !== "static-visibility";
  return {
    sortKey: stableHash(`sort:${pairId}`, seed),
    runs: modes.map((mode) => ({
      run_id: runId(campaign, phase, agent, mode, catalogSize, taskId, repetition),
      campaign,
      phase,
      agent,
      mode,
      catalog_size: catalogSize,
      repetition,
      ...(taskId ? { task_id: taskId } : {}),
      pair_id: pairId,
      scored,
    })) as [ScheduledToolDisclosureRun, ScheduledToolDisclosureRun],
  };
}

function assertUniqueNonEmpty(values: readonly string[], label: string): void {
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) throw new Error(`${label} contains an empty id`);
  if (new Set(normalized).size !== normalized.length)
    throw new Error(`${label} contains duplicate ids`);
}

export function buildToolDisclosureSchedule(
  options: ToolDisclosureScheduleOptions,
): ScheduledToolDisclosureRun[] {
  assertUniqueNonEmpty(options.primaryTaskIds, "primaryTaskIds");
  assertUniqueNonEmpty(options.stressTaskIds, "stressTaskIds");
  if (options.primaryTaskIds.length !== 24) {
    throw new Error(
      `primaryTaskIds must contain exactly 24 tasks, got ${options.primaryTaskIds.length}`,
    );
  }
  if (options.stressTaskIds.length !== 8) {
    throw new Error(
      `stressTaskIds must contain exactly 8 tasks, got ${options.stressTaskIds.length}`,
    );
  }
  if (!Number.isSafeInteger(options.seed)) throw new Error("seed must be a safe integer");

  const campaigns = options.campaigns ?? [1, 2];
  if (campaigns.length === 0 || campaigns.some((value) => value !== 1 && value !== 2)) {
    throw new Error("campaigns must contain campaign 1, campaign 2, or both");
  }

  const scheduled: ScheduledToolDisclosureRun[] = [];
  for (const campaign of campaigns) {
    const staticBlocks: PairBlock[] = [];
    const liveBlocks: PairBlock[] = [];
    for (const agent of TOOL_DISCLOSURE_AGENTS) {
      for (const catalogSize of STATIC_CATALOG_SIZES) {
        staticBlocks.push(
          makePair(campaign, "static-visibility", agent, catalogSize, undefined, 1, options.seed),
        );
      }
      for (const taskId of options.primaryTaskIds) {
        liveBlocks.push(makePair(campaign, "small-control", agent, 64, taskId, 1, options.seed));
        for (let repetition = 1; repetition <= 5; repetition += 1) {
          liveBlocks.push(
            makePair(campaign, "primary", agent, 512, taskId, repetition, options.seed),
          );
        }
      }
      for (const taskId of options.stressTaskIds) {
        liveBlocks.push(makePair(campaign, "large-stress", agent, 2_209, taskId, 1, options.seed));
      }
    }
    staticBlocks.sort(
      (a, b) => a.sortKey - b.sortKey || a.runs[0].pair_id.localeCompare(b.runs[0].pair_id),
    );
    liveBlocks.sort(
      (a, b) => a.sortKey - b.sortKey || a.runs[0].pair_id.localeCompare(b.runs[0].pair_id),
    );
    scheduled.push(...staticBlocks.flatMap((block) => block.runs));
    scheduled.push(...liveBlocks.flatMap((block) => block.runs));
  }

  const ids = scheduled.map((run) => run.run_id);
  if (new Set(ids).size !== ids.length)
    throw new Error("generated schedule contains duplicate run ids");
  return scheduled;
}

export function countScheduledRunsByCampaign(
  schedule: readonly ScheduledToolDisclosureRun[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const run of schedule) {
    const key = `campaign-${run.campaign}:${run.phase}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
