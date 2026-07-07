// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, sha256Hex } from "./catalog";
import type { SyntheticPerformanceTask } from "./tasks";
import type { PerformanceTestRunOutcome, RunCorrectness } from "./types";

export interface RecordedSyntheticCall {
  tool_name: string;
  arguments_sha256: string;
  result_nonce: string | null;
  success: boolean;
}

export interface GradedTaskRun {
  outcome: Extract<PerformanceTestRunOutcome, "success" | "incorrect">;
  correctness: RunCorrectness;
}

/** Grade a run only from deterministic call metadata and the final model output. */
export function gradeTaskRun(
  task: SyntheticPerformanceTask,
  calls: readonly RecordedSyntheticCall[],
  finalOutput: string,
): GradedTaskRun {
  const expectedNames = task.expected_calls.map((call) => call.tool_name);
  const actualNames = calls.map((call) => call.tool_name);
  const expectedHashes = task.expected_calls.map((call) =>
    sha256Hex(canonicalJson(call.arguments)),
  );
  const expectedNonces = task.expected_calls.map((call) => call.result_nonce);
  const expectedCallCount = calls.length === task.expected_calls.length;
  const expectedToolOrder =
    expectedCallCount && actualNames.every((name, index) => name === expectedNames[index]);
  const expectedArguments =
    expectedCallCount &&
    calls.every(
      (call, index) =>
        call.success &&
        call.arguments_sha256 === expectedHashes[index] &&
        call.result_nonce === expectedNonces[index],
    );
  const expectedToolNames =
    expectedNames.length === actualNames.length &&
    [...expectedNames].sort().every((name, index) => name === [...actualNames].sort()[index]);
  const oraclePresent =
    task.expected_final_includes.length > 0 &&
    task.expected_final_includes.every((oracle) => finalOutput.includes(oracle));
  const unnecessaryToolCalls = calls.filter(
    (call, index) => call.tool_name !== expectedNames[index],
  ).length;
  const taskSuccess =
    expectedToolNames &&
    expectedToolOrder &&
    expectedArguments &&
    expectedCallCount &&
    oraclePresent &&
    unnecessaryToolCalls === 0;

  return {
    outcome: taskSuccess ? "success" : "incorrect",
    correctness: {
      task_success: taskSuccess,
      expected_tool_names: expectedToolNames,
      expected_tool_order: expectedToolOrder,
      expected_arguments: expectedArguments,
      expected_call_count: expectedCallCount,
      nonce_present: oraclePresent,
      unnecessary_tool_calls: unnecessaryToolCalls,
    },
  };
}
