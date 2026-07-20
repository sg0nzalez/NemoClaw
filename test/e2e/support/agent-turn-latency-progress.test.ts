// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { startTestProgress, type TestProgressOptions } from "../fixtures/progress.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { installSandbox } from "../live/agent-turn-latency-helpers.ts";

function progressHarness() {
  const state = {
    clearCalls: 0,
    clockMs: 1_000,
    lines: [] as string[],
    timerCallback: null as (() => void) | null,
  };
  const options: TestProgressOptions = {
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

function failedProbe(stderr: string): ShellProbeResult {
  return {
    ...successfulProbe(),
    exitCode: 1,
    stderr,
  };
}

describe("live test progress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the active phase and timestamp-only child-output age", () => {
    const { options, state } = progressHarness();
    const progress = startTestProgress("agent-turn-latency", "OpenClaw install attempt 1", options);

    progress.onOutput({ stream: "stderr", atMs: 21_000 });
    state.clockMs = 61_000;
    state.timerCallback?.();
    const finishCommand = progress.activity("command: install-openclaw");
    state.clockMs = 71_000;
    state.timerCallback?.();
    finishCommand();
    progress.phase("Hermes install attempt 1");
    progress.stop();

    expect(state.clearCalls).toBe(1);
    expect(state.lines).toEqual([
      "[agent-turn-latency] OpenClaw install attempt 1 started (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] OpenClaw install attempt 1 running (60s elapsed; last child output 40s ago; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] command: install-openclaw running (10s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] OpenClaw install attempt 1 finished (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] Hermes install attempt 1 started (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[agent-turn-latency] Hermes install attempt 1 finished (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
    ]);
    expect(progress.summary()).toEqual({
      version: 1,
      scenario: "agent-turn-latency",
      startedAtMs: 1_000,
      finishedAtMs: 71_000,
      durationMs: 70_000,
      phases: [
        {
          label: "OpenClaw install attempt 1",
          startedAtMs: 1_000,
          finishedAtMs: 61_000,
          durationMs: 60_000,
          outputEvents: 1,
          lastOutputAtMs: 21_000,
        },
        {
          label: "command: install-openclaw",
          startedAtMs: 61_000,
          finishedAtMs: 71_000,
          durationMs: 10_000,
          outputEvents: 0,
          lastOutputAtMs: null,
        },
        {
          label: "OpenClaw install attempt 1",
          startedAtMs: 71_000,
          finishedAtMs: 71_000,
          durationMs: 0,
          outputEvents: 0,
          lastOutputAtMs: null,
        },
        {
          label: "Hermes install attempt 1",
          startedAtMs: 71_000,
          finishedAtMs: 71_000,
          durationMs: 0,
          outputEvents: 0,
          lastOutputAtMs: null,
        },
      ],
    });
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

  it("reports transient install retry cleanup, backoff, and both attempts", async () => {
    vi.useFakeTimers();
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(
        failedProbe("Chat Completions API validation failed: request timed out"),
      )
      .mockResolvedValueOnce(successfulProbe());
    const cleanupBeforeRetry = vi.fn(async () => undefined);
    const progress = { onOutput: vi.fn(), phase: vi.fn() };
    const host = { command } as unknown as HostCliClient;

    const resultPromise = installSandbox(
      host,
      "e2e-openclaw-turn-latency",
      "openclaw",
      "secret-api-key",
      cleanupBeforeRetry,
      progress,
    );
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
    expect(cleanupBeforeRetry).toHaveBeenCalledOnce();
    expect(progress.phase.mock.calls.map(([phase]) => phase)).toEqual([
      "OpenClaw install attempt 1",
      "OpenClaw install retry cleanup",
      "OpenClaw install retry backoff",
      "OpenClaw install attempt 2",
    ]);
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({
        artifactName: "openclaw-install-attempt-1",
        onOutput: progress.onOutput,
      }),
      expect.objectContaining({
        artifactName: "openclaw-install-attempt-2",
        onOutput: progress.onOutput,
      }),
    ]);
  });

  it("does not report retry phases for a non-transient install failure", async () => {
    const command = vi.fn<HostCliClient["command"]>(async () =>
      failedProbe("endpoint validation failed: invalid NVIDIA_INFERENCE_API_KEY credential"),
    );
    const cleanupBeforeRetry = vi.fn(async () => undefined);
    const progress = { onOutput: vi.fn(), phase: vi.fn() };
    const host = { command } as unknown as HostCliClient;

    await expect(
      installSandbox(
        host,
        "e2e-openclaw-turn-latency",
        "openclaw",
        "secret-api-key",
        cleanupBeforeRetry,
        progress,
      ),
    ).resolves.toMatchObject({ exitCode: 1 });

    expect(command).toHaveBeenCalledOnce();
    expect(cleanupBeforeRetry).not.toHaveBeenCalled();
    expect(progress.phase.mock.calls.map(([phase]) => phase)).toEqual([
      "OpenClaw install attempt 1",
    ]);
  });
});
