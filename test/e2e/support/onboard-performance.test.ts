// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateColdOnboardPerformance,
  maximumOutputSilenceMs,
  readColdOnboardPerformanceBudget,
  readOnboardTraceWindow,
} from "../fixtures/onboard-performance.ts";
import { extractOpenClawAgentPayloadText } from "../live/agent-turn-latency-helpers.ts";

const PHASE_SPANS: Array<Record<string, unknown>> = [
  { name: "nemoclaw.onboard.phase.preflight", duration_ms: 250 },
  { name: "nemoclaw.onboard.phase.gateway", duration_ms: 500 },
  { name: "nemoclaw.onboard.phase.provider_selection", duration_ms: 750 },
  { name: "nemoclaw.onboard.phase.inference", duration_ms: 1_000 },
  { name: "nemoclaw.onboard.phase.sandbox", duration_ms: 1_250 },
];

function traceArtifact(
  overrides: Partial<Record<string, unknown>> = {},
  phaseSpans = PHASE_SPANS,
): Record<string, unknown> {
  return {
    resource_spans: [
      {
        scope_spans: [
          {
            scope: { name: "nemoclaw.onboard" },
            spans: [
              {
                name: "nemoclaw.onboard",
                start_time_unix_nano: "1000000000",
                end_time_unix_nano: "4750000000",
                status: { code: "OK" },
                ...overrides,
              },
              ...phaseSpans,
            ],
          },
        ],
      },
    ],
  };
}

describe("onboard performance evidence", () => {
  it("reads the successful onboard root span using integer nanosecond timestamps", () => {
    expect(readOnboardTraceWindow(traceArtifact())).toEqual({
      durationMs: 3_750,
      finishedAtMs: 4_750,
      phaseDurationsMs: {
        "nemoclaw.onboard.phase.preflight": 250,
        "nemoclaw.onboard.phase.gateway": 500,
        "nemoclaw.onboard.phase.provider_selection": 750,
        "nemoclaw.onboard.phase.inference": 1_000,
        "nemoclaw.onboard.phase.sandbox": 1_250,
      },
      startedAtMs: 1_000,
    });
  });

  it.each([
    ["missing root", { name: "nemoclaw.onboard.phase.gateway" }],
    ["failed root", { status: { code: "ERROR" } }],
    ["malformed timestamp", { start_time_unix_nano: "yesterday" }],
    ["reversed timestamps", { end_time_unix_nano: "999999999" }],
  ])("rejects a %s trace", (_label, overrides) => {
    expect(() => readOnboardTraceWindow(traceArtifact(overrides))).toThrow();
  });

  it("requires every stable onboarding phase exactly once", () => {
    expect(() => readOnboardTraceWindow(traceArtifact({}, PHASE_SPANS.slice(0, -1)))).toThrow(
      "phase.sandbox",
    );

    const duplicatePhase = traceArtifact({}, [
      ...PHASE_SPANS,
      { name: "nemoclaw.onboard.phase.sandbox", duration_ms: 1 },
    ]);
    expect(() => readOnboardTraceWindow(duplicatePhase)).toThrow("exactly one");
  });

  it("evaluates total, response, and configured trace-phase budgets separately", () => {
    const trace = readOnboardTraceWindow(traceArtifact());
    const budget = readColdOnboardPerformanceBudget({
      fullE2eColdPath: {
        totalBudgetMs: 5_000,
        postOnboardBudgetMs: 1_000,
        phaseBudgetsMs: { "nemoclaw.onboard.phase.sandbox": 1_500 },
      },
    });

    expect(evaluateColdOnboardPerformance(trace, 4_750, budget)).toEqual({
      passed: true,
      postOnboardMs: 1_000,
      violations: [],
    });
    expect(evaluateColdOnboardPerformance(trace, 5_250, budget)).toEqual({
      passed: false,
      postOnboardMs: 1_500,
      violations: [
        "total 5250ms exceeds 5000ms",
        "post-onboard first response 1500ms exceeds 1000ms",
      ],
    });

    trace.phaseDurationsMs["nemoclaw.onboard.phase.sandbox"] = 1_501;
    expect(evaluateColdOnboardPerformance(trace, 4_750, budget).violations).toEqual([
      "nemoclaw.onboard.phase.sandbox 1501ms exceeds 1500ms",
    ]);
  });

  it("rejects malformed cold-path budget configuration", () => {
    expect(() => readColdOnboardPerformanceBudget({})).toThrow("fullE2eColdPath");
    expect(() =>
      readColdOnboardPerformanceBudget({
        fullE2eColdPath: {
          totalBudgetMs: 1_000,
          postOnboardBudgetMs: 1_001,
          phaseBudgetsMs: {},
        },
      }),
    ).toThrow("fullE2eColdPath");
    expect(() =>
      readColdOnboardPerformanceBudget({
        fullE2eColdPath: {
          totalBudgetMs: 1_000,
          postOnboardBudgetMs: 1_000,
          phaseBudgetsMs: {},
        },
      }),
    ).toThrow("fullE2eColdPath");
  });

  it("measures the largest in-window gap after ordering and filtering output events", () => {
    expect(
      maximumOutputSilenceMs({ startedAtMs: 1_000, finishedAtMs: 5_000 }, [
        { atMs: 4_900 },
        { atMs: 1_100 },
        { atMs: 3_000 },
        { atMs: 999 },
        { atMs: 6_000 },
      ]),
    ).toBe(1_900);
  });

  it("treats the entire onboard window as silent when no output arrives", () => {
    expect(maximumOutputSilenceMs({ startedAtMs: 1_000, finishedAtMs: 5_000 }, [])).toBe(4_000);
  });

  it("rejects an output window that ends before it starts", () => {
    expect(() => maximumOutputSilenceMs({ startedAtMs: 5_000, finishedAtMs: 1_000 }, [])).toThrow(
      "onboard output window is invalid",
    );
  });

  it("rejects echoed user messages as first-agent-response evidence", () => {
    expect(
      extractOpenClawAgentPayloadText(
        JSON.stringify({
          messages: [{ role: "user", content: "Reply with exactly: NEMOCLAW_E2E_READY_6002" }],
        }),
      ),
    ).toBe("");
  });

  it("accepts a framed OpenClaw agent-output payload", () => {
    expect(
      extractOpenClawAgentPayloadText(
        `progress\n${JSON.stringify({ result: { payloads: [{ text: "NEMOCLAW_E2E_READY_6002" }] } })}`,
      ),
    ).toBe("NEMOCLAW_E2E_READY_6002");
  });

  it("joins top-level agent-output payload fragments", () => {
    expect(
      extractOpenClawAgentPayloadText(
        JSON.stringify({
          payloads: [{ text: "NEMOCLAW_" }, { text: "E2E_READY_6002" }],
        }),
      ),
    ).toBe("NEMOCLAW_\nE2E_READY_6002");
  });
});
