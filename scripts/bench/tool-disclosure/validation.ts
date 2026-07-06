// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assembleToolDisclosureRun } from "./assemble-run";
import type { SyntheticCatalog } from "./catalog";
import type { SanitizedRunEvidence } from "./execute";
import {
  buildToolDisclosureSchedule,
  type ScheduledToolDisclosureRun,
  STATIC_CATALOG_SIZES,
  TOOL_DISCLOSURE_AGENTS,
  TOOL_DISCLOSURE_MODES,
} from "./schedule";
import type { SyntheticTaskSet } from "./tasks";
import type { ToolDisclosureManifest, ToolDisclosureRun } from "./types";
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_NONINFERIORITY_MARGIN_PP,
} from "./types";

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateFrozenManifest(manifest: ToolDisclosureManifest): void {
  const requiredEnvironmentText = [
    manifest.environment.operating_system,
    manifest.environment.architecture,
    manifest.environment.cpu_model,
    manifest.environment.gpu_model,
    manifest.environment.gpu_architecture,
    manifest.environment.gpu_driver_version,
    manifest.environment.cuda_version,
    manifest.environment.power_state,
    manifest.environment.openshell_version,
    ...TOOL_DISCLOSURE_AGENTS.map((agent) => manifest.environment.agent_versions[agent]),
  ];
  const requiredInferenceText = [
    manifest.inference.model_id,
    manifest.inference.model_revision,
    manifest.inference.container_image,
    manifest.inference.vllm_version,
    manifest.inference.tool_call_parser,
    manifest.inference.reasoning_parser,
  ];
  if (
    manifest.schema_version !== "nemoclaw.tool_disclosure_bench.v1" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(manifest.benchmark_id) ||
    !Number.isFinite(Date.parse(manifest.created_at)) ||
    !/^[a-f0-9]{40}$/u.test(manifest.sut.git_sha) ||
    !/^[a-f0-9]{40}$/u.test(manifest.harness.git_sha) ||
    !manifest.sut.git_ref.trim() ||
    !manifest.harness.git_ref.trim() ||
    requiredEnvironmentText.some((value) => typeof value !== "string" || !value.trim()) ||
    requiredInferenceText.some((value) => typeof value !== "string" || !value.trim()) ||
    !Number.isSafeInteger(manifest.environment.cpu_count) ||
    manifest.environment.cpu_count <= 0 ||
    !Number.isFinite(manifest.environment.ram_gib) ||
    manifest.environment.ram_gib <= 0 ||
    !Number.isSafeInteger(manifest.environment.gpu_count) ||
    manifest.environment.gpu_count <= 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.inference.container_digest) ||
    manifest.inference.api !== "chat-completions" ||
    manifest.inference.public_vllm_flags.some(
      (flag) => typeof flag !== "string" || !flag.trim() || /[\r\n]/u.test(flag),
    ) ||
    new Set(manifest.inference.public_vllm_flags).size !==
      manifest.inference.public_vllm_flags.length ||
    JSON.stringify(manifest).includes("RECORD_ON_DGX")
  ) {
    throw new Error("manifest is missing immutable claim-grade environment metadata");
  }
  if (
    !sameJson(manifest.protocol.agents, TOOL_DISCLOSURE_AGENTS) ||
    !sameJson(manifest.protocol.modes, TOOL_DISCLOSURE_MODES) ||
    !sameJson(manifest.protocol.catalog_sizes, STATIC_CATALOG_SIZES) ||
    manifest.protocol.primary_catalog_size !== 512 ||
    !sameJson(manifest.protocol.repetitions, {
      "small-control": 1,
      primary: 5,
      "large-stress": 1,
    }) ||
    manifest.protocol.bootstrap_samples !== DEFAULT_BOOTSTRAP_SAMPLES ||
    manifest.protocol.bootstrap_seed !== DEFAULT_BOOTSTRAP_SEED ||
    manifest.protocol.noninferiority_margin_percentage_points !==
      DEFAULT_NONINFERIORITY_MARGIN_PP ||
    manifest.protocol.retry_setup_failures !== 1
  ) {
    throw new Error("manifest does not match the frozen benchmark protocol");
  }
  if (
    manifest.inference.temperature !== 0 ||
    manifest.inference.concurrency !== 1 ||
    manifest.inference.prefix_caching_enabled ||
    !manifest.sut.worktree_clean ||
    !manifest.harness.worktree_clean
  ) {
    throw new Error("manifest does not record clean frozen execution controls");
  }
  if (
    !sameJson(
      manifest.campaigns.map((campaign) => campaign.campaign_id),
      ["campaign-1", "campaign-2"],
    ) ||
    !sameJson(
      manifest.campaigns.map((campaign) => campaign.ordinal),
      [1, 2],
    ) ||
    manifest.campaigns.some(
      (campaign) => !campaign.fresh_inference_process || !campaign.fresh_sandboxes,
    )
  ) {
    throw new Error("manifest must record two ordered fresh campaigns");
  }
  const imageKeys = TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
    TOOL_DISCLOSURE_MODES.flatMap((mode) =>
      STATIC_CATALOG_SIZES.map((size) => `${agent}:${mode}:${size}`),
    ),
  ).sort();
  const images = manifest.environment.sandbox_image_digests ?? {};
  if (
    !sameJson(Object.keys(images).sort(), imageKeys) ||
    Object.values(images).some((digest) => !/^sha256:[a-f0-9]{64}$/u.test(digest))
  ) {
    throw new Error("manifest must record an immutable image digest for every sandbox cell");
  }
}

function expectedCampaignId(run: ScheduledToolDisclosureRun): string {
  return `campaign-${run.campaign}`;
}

function assertRunMatchesSchedule(
  run: ToolDisclosureRun,
  expected: ScheduledToolDisclosureRun,
  taskKinds: ReadonlyMap<string, ToolDisclosureRun["task_kind"]>,
): void {
  const expectedTaskId = expected.task_id ?? "static-capture";
  const fields = [
    ["campaign_id", run.campaign_id, expectedCampaignId(expected)],
    ["phase", run.phase, expected.phase],
    ["agent", run.agent, expected.agent],
    ["mode", run.mode, expected.mode],
    ["catalog_size", run.catalog_size, expected.catalog_size],
    ["task_id", run.task_id, expectedTaskId],
    ["repetition", run.repetition, expected.repetition],
  ] as const;
  for (const [field, actual, wanted] of fields) {
    if (actual !== wanted) throw new Error(`run ${run.run_id} has off-schedule ${field}`);
  }
  const expectedKind = expected.task_id ? taskKinds.get(expected.task_id) : undefined;
  if (run.task_kind !== expectedKind) {
    throw new Error(`run ${run.run_id} has an off-schedule task kind`);
  }
}

function assertTerminalMeasurements(run: ToolDisclosureRun): void {
  const measurements = run.measurements;
  const required = [
    ["initial schema bytes", measurements.initial_tool_schema.serialized_bytes],
    ["initial schema tokens", measurements.initial_tool_schema.tokenizer_tokens],
    ["prompt tokens", measurements.total_prompt_tokens],
    ["completion tokens", measurements.completion_tokens],
    ["inference time", measurements.inference_time_ms],
    ["end-to-end time", measurements.end_to_end_time_ms],
  ] as const;
  for (const [label, value] of required) {
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      throw new Error(`run ${run.run_id} has invalid or missing ${label}`);
    }
  }
  if (
    measurements.initial_tool_schema.serialized_bytes === 0 ||
    measurements.initial_tool_schema.tokenizer_tokens === 0 ||
    !Number.isSafeInteger(measurements.model_calls) ||
    measurements.model_calls < 1 ||
    !Number.isSafeInteger(measurements.discovery_calls) ||
    measurements.discovery_calls < 0
  ) {
    throw new Error(`run ${run.run_id} has invalid required count measurements`);
  }
}

/** Validate the complete frozen run matrix before any public summary is emitted. */
export function validateCompleteEvidence(options: {
  manifest: ToolDisclosureManifest;
  runs: readonly ToolDisclosureRun[];
  schedule: readonly ScheduledToolDisclosureRun[];
  primaryTasks: SyntheticTaskSet;
  stressTasks: SyntheticTaskSet;
  rawEvidence: readonly SanitizedRunEvidence[];
  catalog: SyntheticCatalog;
}): void {
  const { manifest, runs, schedule, primaryTasks, stressTasks, rawEvidence, catalog } = options;
  validateFrozenManifest(manifest);
  if (!sameJson(manifest.protocol.agents, TOOL_DISCLOSURE_AGENTS)) {
    throw new Error("manifest agents do not match the frozen protocol");
  }
  if (!sameJson(manifest.protocol.modes, TOOL_DISCLOSURE_MODES)) {
    throw new Error("manifest modes do not match the frozen protocol");
  }
  if (!sameJson(manifest.protocol.catalog_sizes, STATIC_CATALOG_SIZES)) {
    throw new Error("manifest catalog sizes do not match the frozen protocol");
  }
  if (
    manifest.protocol.primary_catalog_size !== 512 ||
    !sameJson(manifest.protocol.repetitions, {
      "small-control": 1,
      primary: 5,
      "large-stress": 1,
    })
  ) {
    throw new Error("manifest repetitions do not match the frozen protocol");
  }
  if (
    manifest.protocol.bootstrap_samples !== DEFAULT_BOOTSTRAP_SAMPLES ||
    manifest.protocol.bootstrap_seed !== DEFAULT_BOOTSTRAP_SEED ||
    manifest.protocol.noninferiority_margin_percentage_points !==
      DEFAULT_NONINFERIORITY_MARGIN_PP ||
    manifest.protocol.retry_setup_failures !== 1
  ) {
    throw new Error("manifest statistics or retry settings do not match the frozen protocol");
  }
  if (
    manifest.inference.temperature !== 0 ||
    manifest.inference.concurrency !== 1 ||
    manifest.inference.prefix_caching_enabled
  ) {
    throw new Error("manifest inference controls do not match the frozen protocol");
  }
  if (!manifest.sut.worktree_clean || !manifest.harness.worktree_clean) {
    throw new Error("public benchmark evidence requires a clean SUT and harness worktree");
  }
  const imageKeys = TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
    TOOL_DISCLOSURE_MODES.flatMap((mode) =>
      STATIC_CATALOG_SIZES.map((size) => `${agent}:${mode}:${size}`),
    ),
  ).sort();
  const recordedImageKeys = Object.keys(manifest.environment.sandbox_image_digests ?? {}).sort();
  if (
    !sameJson(recordedImageKeys, imageKeys) ||
    recordedImageKeys.some(
      (key) =>
        !/^sha256:[a-f0-9]{64}$/u.test(manifest.environment.sandbox_image_digests?.[key] ?? ""),
    )
  ) {
    throw new Error("manifest must record an immutable image digest for every sandbox cell");
  }
  if (
    !sameJson(
      manifest.campaigns.map((campaign) => campaign.campaign_id),
      ["campaign-1", "campaign-2"],
    ) ||
    manifest.campaigns.some(
      (campaign) => !campaign.fresh_inference_process || !campaign.fresh_sandboxes,
    )
  ) {
    throw new Error("manifest must record two fresh frozen campaigns");
  }

  const expectedSchedule = buildToolDisclosureSchedule({
    primaryTaskIds: primaryTasks.tasks.map((task) => task.id),
    stressTaskIds: stressTasks.tasks.map((task) => task.id),
    seed: manifest.protocol.execution_seed,
  });
  if (!sameJson(schedule, expectedSchedule)) {
    throw new Error("schedule.json does not match the deterministic frozen schedule");
  }
  const allTasks = [...primaryTasks.tasks, ...stressTasks.tasks];
  const expectedProtocolTasks = allTasks.map((task) => ({ task_id: task.id, kind: task.kind }));
  if (!sameJson(manifest.protocol.tasks, expectedProtocolTasks)) {
    throw new Error("manifest tasks do not match the frozen task artifacts");
  }
  const taskKinds = new Map(allTasks.map((task) => [task.id, task.kind] as const));
  const tasksById = new Map(allTasks.map((task) => [task.id, task] as const));
  const expectedById = new Map(schedule.map((run) => [run.run_id, run] as const));
  if (expectedById.size !== schedule.length) throw new Error("schedule contains duplicate run IDs");
  const observedById = new Map<string, ToolDisclosureRun[]>();
  if (rawEvidence.length !== runs.length) {
    throw new Error("raw-events.jsonl and runs.jsonl have different record counts");
  }
  let scheduleCursor = 0;
  for (const [index, run] of runs.entries()) {
    if (schedule[scheduleCursor]?.run_id !== run.run_id) {
      throw new Error(`runs.jsonl is out of frozen schedule order at ${run.run_id}`);
    }
    const expected = expectedById.get(run.run_id);
    if (!expected) throw new Error(`runs.jsonl contains unknown run ID ${run.run_id}`);
    assertRunMatchesSchedule(run, expected, taskKinds);
    const raw = rawEvidence[index];
    if (raw.run_id !== run.run_id) throw new Error(`raw evidence order differs at ${run.run_id}`);
    const task = expected.task_id ? tasksById.get(expected.task_id) : undefined;
    const rebuilt = assembleToolDisclosureRun({
      manifest,
      scheduled: expected,
      task,
      calls: raw.calls,
      recorderEvents: raw.recorder_events,
      invocation: {
        ...raw.invocation,
        final_output:
          raw.final_oracles_present && task ? task.expected_final_includes.join(" ") : "",
      },
      initialSchemaTokens: raw.initial_schema_tokens,
      ...(raw.prompt_tokens === undefined ? {} : { promptTokens: raw.prompt_tokens }),
      ...(raw.completion_tokens === undefined ? {} : { completionTokens: raw.completion_tokens }),
      ...(raw.failure_outcome ? { failureOutcome: raw.failure_outcome } : {}),
    });
    if (!sameJson(rebuilt, run)) throw new Error(`run ${run.run_id} does not match raw evidence`);
    if (run.outcome !== "setup-error") {
      const visible = raw.recorder_events.find(
        (event) => event.model_call_sequence === 1,
      )?.tool_names;
      if (!visible) throw new Error(`run ${run.run_id} has no initial visible-tool evidence`);
      const synthetic = catalog.tools
        .slice(0, run.catalog_size)
        .map((tool) => tool.definition.function.name);
      const exposed = (name: string): boolean =>
        visible.some(
          (candidate) =>
            candidate === name || candidate.endsWith(`__${name}`) || candidate.endsWith(`_${name}`),
        );
      if (run.mode === "direct" && synthetic.some((name) => !exposed(name))) {
        throw new Error(`direct run ${run.run_id} did not expose the complete synthetic catalog`);
      }
      if (run.mode === "progressive" && synthetic.some(exposed)) {
        throw new Error(
          `progressive run ${run.run_id} exposed a deferred synthetic tool initially`,
        );
      }
    }
    if (run.execution_seed !== manifest.protocol.execution_seed) {
      throw new Error(`run ${run.run_id} has the wrong execution seed`);
    }
    const observed = observedById.get(run.run_id) ?? [];
    if (observed.some((candidate) => sameJson(candidate, run))) {
      throw new Error(`runs.jsonl contains an exact duplicate for ${run.run_id}`);
    }
    observed.push(run);
    observedById.set(run.run_id, observed);
    if (run.outcome !== "setup-error") scheduleCursor += 1;
  }
  if (scheduleCursor !== schedule.length) throw new Error("runs.jsonl ended before the schedule");

  for (const expected of schedule) {
    const observed = observedById.get(expected.run_id) ?? [];
    const setupFailures = observed.filter((run) => run.outcome === "setup-error");
    const terminal = observed.filter((run) => run.outcome !== "setup-error");
    if (terminal.length !== 1) {
      throw new Error(`run ${expected.run_id} must have exactly one terminal record`);
    }
    if (setupFailures.length > manifest.protocol.retry_setup_failures) {
      throw new Error(`run ${expected.run_id} exceeds the setup-failure retry allowance`);
    }
    assertTerminalMeasurements(terminal[0]);
  }
}
