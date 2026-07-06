// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "vitest";

import { assembleToolDisclosureRun } from "../../scripts/bench/tool-disclosure/assemble-run";
import {
  canonicalJson,
  generateSyntheticCatalog,
  type SyntheticCatalog,
  sha256Hex,
} from "../../scripts/bench/tool-disclosure/catalog";
import type { SanitizedRunEvidence } from "../../scripts/bench/tool-disclosure/execute";
import type { RecordedSyntheticCall } from "../../scripts/bench/tool-disclosure/grading";
import type { ToolDisclosureRecordingEvent } from "../../scripts/bench/tool-disclosure/recorder";
import {
  buildToolDisclosureSchedule,
  type ScheduledToolDisclosureRun,
  STATIC_CATALOG_SIZES,
  TOOL_DISCLOSURE_AGENTS,
  TOOL_DISCLOSURE_MODES,
} from "../../scripts/bench/tool-disclosure/schedule";
import {
  generatePrimaryTaskSet,
  generateStressTaskSet,
  type SyntheticBenchmarkTask,
  type SyntheticTaskSet,
} from "../../scripts/bench/tool-disclosure/tasks";
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_NONINFERIORITY_MARGIN_PP,
  TOOL_DISCLOSURE_SCHEMA_VERSION,
  type ToolDisclosureManifest,
  type ToolDisclosureRun,
} from "../../scripts/bench/tool-disclosure/types";
import {
  validateCompleteEvidence,
  validateFrozenManifest,
} from "../../scripts/bench/tool-disclosure/validation";

interface CompleteEvidenceFixture {
  catalog: SyntheticCatalog;
  manifest: ToolDisclosureManifest;
  primaryTasks: SyntheticTaskSet;
  rawEvidence: SanitizedRunEvidence[];
  runs: ToolDisclosureRun[];
  schedule: ScheduledToolDisclosureRun[];
  stressTasks: SyntheticTaskSet;
}

function buildManifest(
  primaryTasks: SyntheticTaskSet,
  stressTasks: SyntheticTaskSet,
): ToolDisclosureManifest {
  const allTasks = [...primaryTasks.tasks, ...stressTasks.tasks];
  const sandboxImageDigests = Object.fromEntries(
    TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
      TOOL_DISCLOSURE_MODES.flatMap((mode) =>
        STATIC_CATALOG_SIZES.map((size) => [
          `${agent}:${mode}:${size}`,
          `sha256:${"a".repeat(64)}`,
        ]),
      ),
    ),
  );
  return {
    schema_version: TOOL_DISCLOSURE_SCHEMA_VERSION,
    benchmark_id: "tool-disclosure-complete-evidence-fixture",
    created_at: "2026-07-06T12:00:00.000Z",
    sut: { git_sha: "1".repeat(40), git_ref: "fixture-sut", worktree_clean: true },
    harness: { git_sha: "2".repeat(40), git_ref: "fixture-harness", worktree_clean: true },
    campaigns: [
      {
        campaign_id: "campaign-1",
        ordinal: 1,
        fresh_inference_process: true,
        fresh_sandboxes: true,
      },
      {
        campaign_id: "campaign-2",
        ordinal: 2,
        fresh_inference_process: true,
        fresh_sandboxes: true,
      },
    ],
    protocol: {
      agents: TOOL_DISCLOSURE_AGENTS,
      modes: TOOL_DISCLOSURE_MODES,
      catalog_sizes: STATIC_CATALOG_SIZES,
      primary_catalog_size: 512,
      tasks: allTasks.map((task) => ({ task_id: task.id, kind: task.kind })),
      repetitions: { "small-control": 1, primary: 5, "large-stress": 1 },
      execution_seed: DEFAULT_BOOTSTRAP_SEED,
      bootstrap_samples: DEFAULT_BOOTSTRAP_SAMPLES,
      bootstrap_seed: DEFAULT_BOOTSTRAP_SEED,
      noninferiority_margin_percentage_points: DEFAULT_NONINFERIORITY_MARGIN_PP,
      retry_setup_failures: 1,
    },
    environment: {
      operating_system: "fixture-os",
      architecture: "x86_64",
      cpu_model: "fixture-cpu",
      cpu_count: 1,
      ram_gib: 1,
      gpu_model: "fixture-gpu",
      gpu_architecture: "fixture-architecture",
      gpu_count: 1,
      gpu_driver_version: "fixture-driver",
      cuda_version: "fixture-cuda",
      power_state: "fixture-power-state",
      openshell_version: "fixture-openshell",
      agent_versions: {
        openclaw: "fixture-openclaw",
        hermes: "fixture-hermes",
        "langchain-deepagents-code": "fixture-deepagents",
      },
      sandbox_image_digests: sandboxImageDigests,
    },
    inference: {
      api: "chat-completions",
      model_id: "fixture-model",
      model_revision: "fixture-model-revision",
      container_image: "fixture-inference-image",
      container_digest: `sha256:${"b".repeat(64)}`,
      vllm_version: "fixture-vllm",
      tool_call_parser: "fixture-tool-parser",
      reasoning_parser: "fixture-reasoning-parser",
      temperature: 0,
      concurrency: 1,
      prefix_caching_enabled: false,
      public_vllm_flags: [],
    },
  };
}

function recordedCalls(task: SyntheticBenchmarkTask | undefined): RecordedSyntheticCall[] {
  return (
    task?.expected_calls.map((call) => ({
      tool_name: call.tool_name,
      arguments_sha256: sha256Hex(canonicalJson(call.arguments)),
      result_nonce: call.result_nonce,
      success: true,
    })) ?? []
  );
}

function recordingEvent(options: {
  run: ScheduledToolDisclosureRun;
  toolNames: readonly string[];
}): ToolDisclosureRecordingEvent {
  return {
    run_id: options.run.run_id,
    request_sequence: 1,
    model_call_sequence: 1,
    endpoint: "chat-completions",
    method: "POST",
    visible_tool_count: options.toolNames.length,
    canonical_tools_json_bytes: Math.max(1, options.toolNames.length * 64),
    tools_sha256: sha256Hex(options.toolNames.join("\0")),
    tool_names: options.toolNames,
    streaming: true,
    status_code: 200,
    started_monotonic_ms: 1,
    first_byte_monotonic_ms: 2,
    ended_monotonic_ms: 3,
    duration_ms: 2,
    time_to_first_byte_ms: 1,
    outcome: "completed",
    error_reason: null,
  };
}

function buildCompleteEvidenceFixture(): CompleteEvidenceFixture {
  const catalog = generateSyntheticCatalog();
  const primaryTasks = generatePrimaryTaskSet(catalog);
  const stressTasks = generateStressTaskSet(catalog);
  const manifest = buildManifest(primaryTasks, stressTasks);
  const schedule = buildToolDisclosureSchedule({
    primaryTaskIds: primaryTasks.tasks.map((task) => task.id),
    stressTaskIds: stressTasks.tasks.map((task) => task.id),
    seed: manifest.protocol.execution_seed,
  });
  const tasksById = new Map(
    [...primaryTasks.tasks, ...stressTasks.tasks].map((task) => [task.id, task] as const),
  );
  const directToolNamesBySize: ReadonlyMap<number, string[]> = new Map(
    STATIC_CATALOG_SIZES.map((size) => [
      size,
      catalog.tools.slice(0, size).map((tool) => tool.definition.function.name),
    ]),
  );
  const progressiveToolNames = ["search_tools"] as const;
  const rawEvidence: SanitizedRunEvidence[] = [];
  const runs: ToolDisclosureRun[] = [];

  for (const scheduled of schedule) {
    const task = scheduled.task_id ? tasksById.get(scheduled.task_id) : undefined;
    const calls = recordedCalls(task);
    const toolNames =
      scheduled.mode === "direct"
        ? directToolNamesBySize.get(scheduled.catalog_size)
        : progressiveToolNames;
    expect(toolNames).toBeDefined();
    const requiredToolNames = toolNames as NonNullable<typeof toolNames>;
    const recorderEvents = [recordingEvent({ run: scheduled, toolNames: requiredToolNames })];
    const initialSchemaTokens = scheduled.mode === "direct" ? scheduled.catalog_size * 8 : 8;
    const promptTokens = initialSchemaTokens + 100;
    const completionTokens = 16;
    const invocation = { exit_code: 0, timed_out: false, elapsed_ms: 10 };
    rawEvidence.push({
      run_id: scheduled.run_id,
      recorder_events: recorderEvents,
      calls,
      invocation,
      initial_schema_tokens: initialSchemaTokens,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      final_oracles_present: Boolean(task),
    });
    runs.push(
      assembleToolDisclosureRun({
        manifest,
        scheduled,
        task,
        calls,
        recorderEvents,
        invocation: {
          ...invocation,
          final_output: task?.expected_final_includes.join(" ") ?? "",
        },
        initialSchemaTokens,
        promptTokens,
        completionTokens,
      }),
    );
  }

  return { catalog, manifest, primaryTasks, rawEvidence, runs, schedule, stressTasks };
}

describe("tool-disclosure complete-evidence validation", () => {
  let fixture: CompleteEvidenceFixture;

  beforeAll(() => {
    fixture = buildCompleteEvidenceFixture();
  });

  it("rejects incomplete or mutable claim-grade manifest metadata", () => {
    expect(() => validateFrozenManifest(fixture.manifest)).not.toThrow();

    const missingModelRevision = structuredClone(fixture.manifest);
    missingModelRevision.inference.model_revision = "";
    expect(() => validateFrozenManifest(missingModelRevision)).toThrow(/claim-grade/u);

    const mutableInferenceImage = structuredClone(fixture.manifest);
    mutableInferenceImage.inference.container_digest = "fixture:latest";
    expect(() => validateFrozenManifest(mutableInferenceImage)).toThrow(/claim-grade/u);
  });

  it("accepts the exact 1,884-run frozen matrix and rejects reordered or tampered evidence", {
    timeout: 30_000,
  }, () => {
    expect(fixture.schedule).toHaveLength(1_884);
    expect(fixture.runs).toHaveLength(1_884);
    expect(() => validateCompleteEvidence(fixture)).not.toThrow();

    const reorderedRuns = [...fixture.runs];
    const reorderedRaw = [...fixture.rawEvidence];
    [reorderedRuns[0], reorderedRuns[1]] = [reorderedRuns[1], reorderedRuns[0]];
    [reorderedRaw[0], reorderedRaw[1]] = [reorderedRaw[1], reorderedRaw[0]];
    expect(() =>
      validateCompleteEvidence({
        ...fixture,
        runs: reorderedRuns,
        rawEvidence: reorderedRaw,
      }),
    ).toThrow("runs.jsonl is out of frozen schedule order");

    const rawOnlyReordered = [...fixture.rawEvidence];
    [rawOnlyReordered[0], rawOnlyReordered[1]] = [rawOnlyReordered[1], rawOnlyReordered[0]];
    expect(() => validateCompleteEvidence({ ...fixture, rawEvidence: rawOnlyReordered })).toThrow(
      "raw evidence order differs",
    );

    const tamperedRaw = [...fixture.rawEvidence];
    tamperedRaw[0] = {
      ...tamperedRaw[0],
      initial_schema_tokens: tamperedRaw[0].initial_schema_tokens + 1,
    };
    expect(() => validateCompleteEvidence({ ...fixture, rawEvidence: tamperedRaw })).toThrow(
      "does not match raw evidence",
    );
  });
});
