// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { installSandbox } from "../live/agent-turn-latency-helpers.ts";
import { type LiveProgressOptions, startLiveProgress } from "../live/live-progress.ts";

function progressHarness() {
  const state = {
    clearCalls: 0,
    clockMs: 1_000,
    lines: [] as string[],
    timerCallback: null as (() => void) | null,
  };
  const options: LiveProgressOptions = {
    heartbeatIntervalMs: 60_000,
    now: () => state.clockMs,
    setTimer: (callback) => {
      state.timerCallback = callback;
      return { unref() {} };
    },
    clearTimer: () => {
      state.clearCalls += 1;
    },
    logLine: (line) => state.lines.push(line),
    sampleResources: () => ({
      freeMemoryBytes: 8 * 1024 ** 3,
      processRssBytes: 0.5 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
      workspaceFreeBytes: 6 * 1024 ** 3,
      loadAverage1m: 2.5,
    }),
  };
  return { options, state };
}

function successfulProbe(): ShellProbeResult {
  return {
    command: ["bash", "install.sh"],
    durationMs: 10,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "stdout", stderr: "stderr", result: "result" },
  };
}

describe("agent turn latency live progress", () => {
  it("reports the active phase and timestamp-only child-output age", () => {
    const { options, state } = progressHarness();
    const progress = startLiveProgress("agent-turn-latency", "OpenClaw install attempt 1", options);

    progress.onOutput({ stream: "stderr", atMs: 21_000 });
    state.clockMs = 61_000;
    state.timerCallback?.();
    progress.phase("Hermes install attempt 1");
    progress.stop();

    expect(state.clearCalls).toBe(1);
    expect(state.lines).toEqual([
      "[agent-turn-latency] OpenClaw install attempt 1 started (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] OpenClaw install attempt 1 running (60s elapsed; last child output 40s ago; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] OpenClaw install attempt 1 finished (60s elapsed; last child output 40s ago; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] Hermes install attempt 1 started (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] Hermes install attempt 1 finished (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
    ]);
  });

  it("connects each install attempt to the phase and timestamp-only observer", async () => {
    const command = vi.fn<HostCliClient["command"]>(async () => successfulProbe());
    const host = { command } as unknown as HostCliClient;
    const progress = { onOutput: vi.fn(), phase: vi.fn() };

    await installSandbox(
      host,
      "e2e-openclaw-turn-latency",
      "openclaw",
      "secret-api-key",
      undefined,
      progress,
    );

    expect(progress.phase).toHaveBeenCalledWith("OpenClaw install attempt 1");
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[2]).toMatchObject({
      artifactName: "openclaw-install-attempt-1",
      onOutput: progress.onOutput,
      redactionValues: ["secret-api-key"],
    });
  });
});
