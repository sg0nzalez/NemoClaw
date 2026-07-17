// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeOutputEvent } from "../fixtures/shell-probe.ts";

interface LiveResourceSnapshot {
  freeMemoryBytes: number;
  processRssBytes: number;
  totalMemoryBytes: number;
  workspaceFreeBytes: number;
  loadAverage1m: number;
}

interface TimerHandle {
  unref?: () => void;
}

export interface LiveProgressOptions {
  heartbeatIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  logLine?: (line: string) => void;
  sampleResources?: () => LiveResourceSnapshot;
}

export interface LiveProgress {
  onOutput: (event: ShellProbeOutputEvent) => void;
  phase: (label: string) => void;
  stop: () => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function defaultResourceSnapshot(): LiveResourceSnapshot {
  const workspace = fs.statfsSync(REPO_ROOT);
  return {
    freeMemoryBytes: os.freemem(),
    processRssBytes: process.memoryUsage().rss,
    totalMemoryBytes: os.totalmem(),
    workspaceFreeBytes: workspace.bavail * workspace.bsize,
    loadAverage1m: os.loadavg()[0] ?? 0,
  };
}

function formatResources(sampleResources: () => LiveResourceSnapshot): string {
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
export function startLiveProgress(
  scenario: string,
  initialPhase: string,
  options: LiveProgressOptions = {},
): LiveProgress {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const logLine = options.logLine ?? ((line) => process.stdout.write(`${line}\n`));
  const sampleResources = options.sampleResources ?? defaultResourceSnapshot;
  let phaseLabel = initialPhase;
  let phaseStartedAt = now();
  let lastOutputAt: number | null = null;
  let stopped = false;

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

  logBestEffort("started");
  const timer = setTimer(
    () => logBestEffort("running"),
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  timer.unref?.();

  return {
    onOutput(event) {
      lastOutputAt = event.atMs;
    },
    phase(label) {
      if (stopped) return;
      logBestEffort("finished");
      phaseLabel = label;
      phaseStartedAt = now();
      lastOutputAt = null;
      logBestEffort("started");
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
      logBestEffort("finished");
    },
  };
}
