// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeOutputEvent } from "./shell-probe.ts";

const ONBOARD_SCOPE = "nemoclaw.onboard";
const ONBOARD_ROOT_SPAN = "nemoclaw.onboard";
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
export const ONBOARD_PHASE_NAMES = [
  "nemoclaw.onboard.phase.preflight",
  "nemoclaw.onboard.phase.gateway",
  "nemoclaw.onboard.phase.provider_selection",
  "nemoclaw.onboard.phase.inference",
  "nemoclaw.onboard.phase.sandbox",
] as const;

export type OnboardPhaseName = (typeof ONBOARD_PHASE_NAMES)[number];

const ONBOARD_PHASE_NAME_SET = new Set<string>(ONBOARD_PHASE_NAMES);
const SANDBOX_PHASE_NAME = "nemoclaw.onboard.phase.sandbox" as const;

export interface OnboardTraceWindow {
  durationMs: number;
  finishedAtMs: number;
  phaseDurationsMs: Record<OnboardPhaseName, number>;
  startedAtMs: number;
}

export interface ColdOnboardPerformanceBudget {
  phaseBudgetsMs: Partial<Record<OnboardPhaseName, number>>;
  postOnboardBudgetMs: number;
  totalBudgetMs: number;
}

export interface ColdOnboardPerformanceEvaluation {
  passed: boolean;
  postOnboardMs: number;
  violations: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function unixNanoseconds(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`onboard root span has an invalid ${field}`);
  }
  return BigInt(value);
}

function durationMilliseconds(value: unknown, phaseName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`onboard phase ${phaseName} has an invalid duration`);
  }
  return value;
}

function nonNegativeMilliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asColdOnboardBudget(value: unknown): ColdOnboardPerformanceBudget | null {
  const record = asRecord(value);
  if (!record) return null;
  const totalBudgetMs = nonNegativeMilliseconds(record.totalBudgetMs);
  const postOnboardBudgetMs = nonNegativeMilliseconds(record.postOnboardBudgetMs);
  const phaseBudgets = asRecord(record.phaseBudgetsMs);
  if (
    totalBudgetMs === null ||
    postOnboardBudgetMs === null ||
    postOnboardBudgetMs > totalBudgetMs ||
    !phaseBudgets
  ) {
    return null;
  }

  const phaseBudgetsMs: Partial<Record<OnboardPhaseName, number>> = {};
  for (const [name, budgetMs] of Object.entries(phaseBudgets)) {
    if (!ONBOARD_PHASE_NAME_SET.has(name)) return null;
    const validatedBudgetMs = nonNegativeMilliseconds(budgetMs);
    if (validatedBudgetMs === null) return null;
    phaseBudgetsMs[name as OnboardPhaseName] = validatedBudgetMs;
  }
  if (phaseBudgetsMs[SANDBOX_PHASE_NAME] === undefined) return null;

  return { totalBudgetMs, postOnboardBudgetMs, phaseBudgetsMs };
}

export function readColdOnboardPerformanceBudget(value: unknown): ColdOnboardPerformanceBudget {
  const budget = asColdOnboardBudget(asRecord(value)?.fullE2eColdPath);
  if (!budget) {
    throw new Error("fullE2eColdPath performance budget is invalid or missing");
  }
  return budget;
}

export function readOnboardTraceWindow(artifact: unknown): OnboardTraceWindow {
  const resourceSpans = asRecord(artifact)?.resource_spans;
  if (!Array.isArray(resourceSpans)) {
    throw new Error("trace artifact is missing resource_spans");
  }

  const roots: Record<string, unknown>[] = [];
  const phases = new Map<OnboardPhaseName, number>();
  for (const resourceSpan of resourceSpans) {
    const scopeSpans = asRecord(resourceSpan)?.scope_spans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const scopeSpan of scopeSpans) {
      const scopeSpanRecord = asRecord(scopeSpan);
      if (asRecord(scopeSpanRecord?.scope)?.name !== ONBOARD_SCOPE) continue;
      const spans = scopeSpanRecord?.spans;
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        const record = asRecord(span);
        if (record?.name === ONBOARD_ROOT_SPAN) roots.push(record);
        if (typeof record?.name === "string" && ONBOARD_PHASE_NAME_SET.has(record.name)) {
          const phaseName = record.name as OnboardPhaseName;
          if (phases.has(phaseName)) {
            throw new Error(`trace artifact must contain exactly one ${phaseName} span`);
          }
          phases.set(phaseName, durationMilliseconds(record.duration_ms, phaseName));
        }
      }
    }
  }

  if (roots.length !== 1) {
    throw new Error("trace artifact must contain exactly one onboard root span");
  }
  const root = roots[0];
  if (asRecord(root.status)?.code !== "OK") {
    throw new Error("onboard root span status is missing or not OK");
  }

  const startedAtNs = unixNanoseconds(root.start_time_unix_nano, "start time");
  const finishedAtNs = unixNanoseconds(root.end_time_unix_nano, "end time");
  if (finishedAtNs < startedAtNs) {
    throw new Error("onboard root span ends before it starts");
  }

  const phaseDurationsMs = {} as Record<OnboardPhaseName, number>;
  for (const phaseName of ONBOARD_PHASE_NAMES) {
    const durationMs = phases.get(phaseName);
    if (durationMs === undefined) {
      throw new Error(`trace artifact is missing ${phaseName} span`);
    }
    phaseDurationsMs[phaseName] = durationMs;
  }

  return {
    durationMs: Number((finishedAtNs - startedAtNs) / NANOSECONDS_PER_MILLISECOND),
    finishedAtMs: Number(finishedAtNs / NANOSECONDS_PER_MILLISECOND),
    phaseDurationsMs,
    startedAtMs: Number(startedAtNs / NANOSECONDS_PER_MILLISECOND),
  };
}

export function evaluateColdOnboardPerformance(
  trace: Pick<OnboardTraceWindow, "durationMs" | "phaseDurationsMs">,
  totalMs: number,
  budget: ColdOnboardPerformanceBudget,
): ColdOnboardPerformanceEvaluation {
  if (!Number.isFinite(totalMs) || totalMs < trace.durationMs) {
    throw new Error("cold onboard total duration is invalid");
  }

  const postOnboardMs = totalMs - trace.durationMs;
  const violations: string[] = [];
  if (totalMs > budget.totalBudgetMs) {
    violations.push(
      `total ${Math.ceil(totalMs / 1_000)}s exceeds ${Math.ceil(budget.totalBudgetMs / 1_000)}s`,
    );
  }
  if (postOnboardMs > budget.postOnboardBudgetMs) {
    violations.push(
      `post-onboard first response ${Math.ceil(postOnboardMs / 1_000)}s exceeds ${Math.ceil(budget.postOnboardBudgetMs / 1_000)}s`,
    );
  }
  for (const phaseName of ONBOARD_PHASE_NAMES) {
    const phaseBudgetMs = budget.phaseBudgetsMs[phaseName];
    const phaseDurationMs = trace.phaseDurationsMs[phaseName];
    if (phaseBudgetMs !== undefined && phaseDurationMs > phaseBudgetMs) {
      violations.push(
        `${phaseName} ${Math.ceil(phaseDurationMs / 1_000)}s exceeds ${Math.ceil(phaseBudgetMs / 1_000)}s`,
      );
    }
  }

  return { passed: violations.length === 0, postOnboardMs, violations };
}

export function maximumOutputSilenceMs(
  window: Pick<OnboardTraceWindow, "finishedAtMs" | "startedAtMs">,
  events: readonly Pick<ShellProbeOutputEvent, "atMs">[],
): number {
  const { finishedAtMs, startedAtMs } = window;
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(finishedAtMs) ||
    finishedAtMs < startedAtMs
  ) {
    throw new Error("onboard output window is invalid");
  }

  const outputTimes = events
    .map((event) => event.atMs)
    .filter((atMs) => atMs >= startedAtMs && atMs <= finishedAtMs)
    .sort((left, right) => left - right);
  const boundaries = [startedAtMs, ...outputTimes, finishedAtMs];
  return boundaries
    .slice(1)
    .reduce((maximum, atMs, index) => Math.max(maximum, atMs - boundaries[index]), 0);
}
