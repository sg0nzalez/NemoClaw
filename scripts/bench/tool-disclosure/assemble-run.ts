// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { gradeTaskRun, type RecordedSyntheticCall } from "./grading";
import type { ToolDisclosureRecordingEvent } from "./recorder";
import type { ScheduledToolDisclosureRun } from "./schedule";
import type { SyntheticBenchmarkTask } from "./tasks";
import {
  type BenchmarkRunOutcome,
  type RunCorrectness,
  TOOL_DISCLOSURE_SCHEMA_VERSION,
  type ToolDisclosureManifest,
  type ToolDisclosureRun,
} from "./types";

export interface RunInvocationResult {
  exit_code: number | null;
  timed_out: boolean;
  elapsed_ms: number;
  final_output: string;
}

function successfulStaticCorrectness(): RunCorrectness {
  return {
    task_success: true,
    expected_tool_names: true,
    expected_tool_order: true,
    expected_arguments: true,
    expected_call_count: true,
    nonce_present: true,
    unnecessary_tool_calls: 0,
  };
}

function failedCorrectness(callCount: number): RunCorrectness {
  return {
    task_success: false,
    expected_tool_names: false,
    expected_tool_order: false,
    expected_arguments: false,
    expected_call_count: false,
    nonce_present: false,
    unnecessary_tool_calls: callCount,
  };
}

/**
 * Convert transient model output plus content-free call/recorder events into a
 * public-safe run record. Raw output and tool arguments never cross this API.
 */
export function assembleToolDisclosureRun(options: {
  manifest: ToolDisclosureManifest;
  scheduled: ScheduledToolDisclosureRun;
  task?: SyntheticBenchmarkTask;
  calls: readonly RecordedSyntheticCall[];
  recorderEvents: readonly ToolDisclosureRecordingEvent[];
  invocation: RunInvocationResult;
  initialSchemaTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  failureOutcome?: Exclude<BenchmarkRunOutcome, "success" | "incorrect">;
}): ToolDisclosureRun {
  if (!Number.isSafeInteger(options.initialSchemaTokens) || options.initialSchemaTokens < 0) {
    throw new Error("initial schema token count must be a non-negative integer");
  }
  const scheduledCampaign = `campaign-${options.scheduled.campaign}`;
  if (!options.manifest.campaigns.some((item) => item.campaign_id === scheduledCampaign)) {
    throw new Error(`scheduled campaign ${scheduledCampaign} is absent from the manifest`);
  }
  if (options.scheduled.phase !== "static-visibility" && !options.task) {
    throw new Error("task runs require their frozen task definition");
  }
  if (options.task && options.scheduled.task_id !== options.task.id) {
    throw new Error("scheduled task does not match the supplied task definition");
  }

  const modelEvents = options.recorderEvents.filter((event) => event.model_call_sequence !== null);
  const initial = modelEvents.find((event) => event.model_call_sequence === 1);
  let outcome: BenchmarkRunOutcome;
  let correctness: RunCorrectness;
  if (options.failureOutcome) {
    outcome = options.failureOutcome;
    correctness = failedCorrectness(options.calls.length);
  } else if (
    options.scheduled.phase === "static-visibility" &&
    initial &&
    options.initialSchemaTokens > 0
  ) {
    outcome = "success";
    correctness = successfulStaticCorrectness();
  } else if (options.invocation.timed_out) {
    outcome = "timeout";
    correctness = failedCorrectness(options.calls.length);
  } else if (options.invocation.exit_code !== 0 || !initial || initial.outcome !== "completed") {
    outcome = "model-error";
    correctness = failedCorrectness(options.calls.length);
  } else {
    const graded = gradeTaskRun(
      options.task as SyntheticBenchmarkTask,
      options.calls,
      options.invocation.final_output,
    );
    outcome = graded.outcome;
    correctness = graded.correctness;
  }

  return {
    schema_version: TOOL_DISCLOSURE_SCHEMA_VERSION,
    benchmark_id: options.manifest.benchmark_id,
    campaign_id: scheduledCampaign,
    run_id: options.scheduled.run_id,
    phase: options.scheduled.phase,
    agent: options.scheduled.agent,
    mode: options.scheduled.mode,
    catalog_size: options.scheduled.catalog_size,
    task_id: options.task?.id ?? "static-capture",
    ...(options.task ? { task_kind: options.task.kind } : {}),
    repetition: options.scheduled.repetition,
    execution_seed: options.manifest.protocol.execution_seed,
    outcome,
    scored: options.scheduled.phase !== "static-visibility" && outcome !== "setup-error",
    correctness,
    measurements: {
      initial_tool_schema: {
        tool_count: initial?.visible_tool_count ?? 0,
        serialized_bytes: initial?.canonical_tools_json_bytes ?? 0,
        tokenizer_tokens: options.initialSchemaTokens,
      },
      ...(options.promptTokens === undefined ? {} : { total_prompt_tokens: options.promptTokens }),
      ...(options.completionTokens === undefined
        ? {}
        : { completion_tokens: options.completionTokens }),
      ...(initial?.streaming !== true ||
      initial.time_to_first_byte_ms === null ||
      initial.time_to_first_byte_ms === undefined
        ? {}
        : { time_to_first_response_byte_ms: initial.time_to_first_byte_ms }),
      inference_time_ms: modelEvents.reduce((total, event) => total + event.duration_ms, 0),
      end_to_end_time_ms: options.invocation.elapsed_ms,
      model_calls: modelEvents.length,
      discovery_calls: Math.max(0, modelEvents.length - options.calls.length - 1),
    },
  };
}
