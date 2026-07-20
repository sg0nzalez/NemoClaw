// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import { REPO_ROOT } from "./paths.ts";
import type { ShellProbeOutputEvent } from "./shell-probe.ts";

interface ResourceSnapshot {
  freeMemoryBytes: number;
  processRssBytes: number;
  totalMemoryBytes: number;
  workspaceFreeBytes: number;
  loadAverage1m: number;
}

interface TimerHandle {
  unref?: () => void;
}

export interface ProgressPhase {
  label: string;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  outputEvents: number;
  lastOutputAtMs: number | null;
}

export interface ProgressSummary {
  version: 1;
  scenario: string;
  targetId?: string;
  shardId?: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  durationMs: number | null;
  phases: readonly ProgressPhase[];
}

export interface TestProgressOptions {
  heartbeatIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  logLine?: (line: string) => void;
  sampleResources?: () => ResourceSnapshot;
}

export interface TestProgress {
  onOutput: (event: ShellProbeOutputEvent) => void;
  activity: (label: string) => () => void;
  phase: (label: string) => void;
  stop: () => void;
  summary: () => ProgressSummary;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function defaultResourceSnapshot(): ResourceSnapshot {
  const workspace = fs.statfsSync(REPO_ROOT);
  return {
    freeMemoryBytes: os.freemem(),
    processRssBytes: process.memoryUsage().rss,
    totalMemoryBytes: os.totalmem(),
    workspaceFreeBytes: workspace.bavail * workspace.bsize,
    loadAverage1m: os.loadavg()[0] ?? 0,
  };
}

function formatResources(sampleResources: () => ResourceSnapshot): string {
  try {
    const snapshot = sampleResources();
    return [
      `memory free ${formatGiB(snapshot.freeMemoryBytes)}/${formatGiB(snapshot.totalMemoryBytes)}`,
      `test RSS ${formatGiB(snapshot.processRssBytes)}`,
      `workspace free ${formatGiB(snapshot.workspaceFreeBytes)}`,
      `load 1m ${snapshot.loadAverage1m.toFixed(2)}`,
    ].join("; ");
  } catch {
    return "host resources unavailable";
  }
}

/**
 * Keep a long live scenario visible without forwarding command output, which
 * may contain credentials. The timestamp-only observer reports child liveness
 * while phase names and resource snapshots identify where a runner stalled.
 */
export function startTestProgress(
  scenario: string,
  initialPhase = "test body",
  options: TestProgressOptions = {},
): TestProgress {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const logLine = options.logLine ?? ((line) => process.stdout.write(`${line}\n`));
  const sampleResources = options.sampleResources ?? defaultResourceSnapshot;
  const scenarioStartedAt = now();
  const phases: ProgressPhase[] = [];
  let basePhaseLabel = initialPhase;
  let phaseLabel = initialPhase;
  let phaseStartedAt = scenarioStartedAt;
  let lastOutputAt: number | null = null;
  let outputEvents = 0;
  let finishedAt: number | null = null;

  const logBestEffort = (state: "started" | "running" | "finished") => {
    try {
      const current = now();
      const elapsedSeconds = Math.max(0, Math.floor((current - phaseStartedAt) / 1_000));
      const outputAge =
        lastOutputAt === null
          ? "no child output observed"
          : `last child output ${Math.max(0, Math.floor((current - lastOutputAt) / 1_000))}s ago`;
      logLine(
        `[${scenario}] ${phaseLabel} ${state} (${elapsedSeconds}s elapsed; ${outputAge}; ${formatResources(sampleResources)})`,
      );
    } catch {
      // Diagnostics must not change the live test result.
    }
  };

  const finishPhase = (atMs: number) => {
    phases.push({
      label: phaseLabel,
      startedAtMs: phaseStartedAt,
      finishedAtMs: atMs,
      durationMs: Math.max(0, atMs - phaseStartedAt),
      outputEvents,
      lastOutputAtMs: lastOutputAt,
    });
  };

  logBestEffort("started");
  const timer = setTimer(
    () => logBestEffort("running"),
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  timer.unref?.();

  return {
    onOutput(event) {
      if (finishedAt !== null) return;
      lastOutputAt = event.atMs;
      outputEvents += 1;
    },
    activity(label) {
      if (finishedAt !== null) return () => undefined;
      const startedAt = now();
      finishPhase(startedAt);
      phaseLabel = label;
      phaseStartedAt = startedAt;
      lastOutputAt = null;
      outputEvents = 0;
      let activityFinished = false;
      return () => {
        if (activityFinished || finishedAt !== null) return;
        activityFinished = true;
        const activityFinishedAt = now();
        finishPhase(activityFinishedAt);
        phaseLabel = basePhaseLabel;
        phaseStartedAt = activityFinishedAt;
        lastOutputAt = null;
        outputEvents = 0;
      };
    },
    phase(label) {
      if (finishedAt !== null) return;
      const current = now();
      logBestEffort("finished");
      finishPhase(current);
      basePhaseLabel = label;
      phaseLabel = basePhaseLabel;
      phaseStartedAt = current;
      lastOutputAt = null;
      outputEvents = 0;
      logBestEffort("started");
    },
    stop() {
      if (finishedAt !== null) return;
      finishedAt = now();
      clearTimer(timer);
      logBestEffort("finished");
      finishPhase(finishedAt);
    },
    summary() {
      return {
        version: 1,
        scenario,
        startedAtMs: scenarioStartedAt,
        finishedAtMs: finishedAt,
        durationMs: finishedAt === null ? null : Math.max(0, finishedAt - scenarioStartedAt),
        phases: phases.map((phase) => ({ ...phase })),
      };
    },
  };
}
