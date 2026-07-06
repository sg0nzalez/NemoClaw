// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type BenchmarkPhase,
  type CampaignAgentGate,
  type ClaimGateSummary,
  type ComparisonCellSummary,
  type ConfidenceInterval,
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_NONINFERIORITY_MARGIN_PP,
  type ModeAggregate,
  type SchemaReductionSummary,
  type SchemaVisibilitySnapshot,
  TOOL_DISCLOSURE_SCHEMA_VERSION,
  type ToolDisclosureAgent,
  type ToolDisclosureManifest,
  type ToolDisclosureMode,
  type ToolDisclosureRun,
  type ToolDisclosureSummary,
} from "./types";

export interface PairedObservation {
  progressive: number;
  direct: number;
}

export interface PairedBootstrapOptions {
  samples?: number;
  seed?: number;
}

export interface ComparisonOptions extends PairedBootstrapOptions {}

export interface ClaimGateOptions {
  agents: readonly ToolDisclosureAgent[];
  campaignIds: readonly string[];
  primaryCatalogSize: number;
  noninferiorityMarginPercentagePoints?: number;
}

interface TaskAggregate {
  success: number;
  initialSchemaTokens: number;
  totalPromptTokens?: number;
  timeToFirstResponseByteMs?: number;
  endToEndTimeMs?: number;
}

interface ComparisonGroup {
  campaignId: string;
  phase: Exclude<BenchmarkPhase, "static-visibility">;
  agent: ToolDisclosureAgent;
  catalogSize: number;
  runs: ToolDisclosureRun[];
}

interface StaticGroup {
  campaignId: string;
  agent: ToolDisclosureAgent;
  catalogSize: number;
  runs: ToolDisclosureRun[];
}

const PHASE_ORDER: Readonly<Record<Exclude<BenchmarkPhase, "static-visibility">, number>> = {
  "small-control": 0,
  primary: 1,
  "large-stress": 2,
};

/**
 * Percentile paired bootstrap over task-level observations. Each bootstrap
 * draw resamples whole progressive/direct task pairs, never individual runs.
 */
export function pairedBootstrapDifference(
  observations: readonly PairedObservation[],
  options: PairedBootstrapOptions = {},
): ConfidenceInterval {
  const samples = options.samples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  const seed = normalizeSeed(options.seed ?? DEFAULT_BOOTSTRAP_SEED);
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new Error(`bootstrap samples must be a positive integer, received ${samples}`);
  }
  if (observations.length === 0) {
    throw new Error("paired bootstrap requires at least one task pair");
  }
  for (const observation of observations) {
    assertFinite(observation.progressive, "progressive observation");
    assertFinite(observation.direct, "direct observation");
  }

  const differences = observations.map(({ progressive, direct }) => progressive - direct);
  const estimate = mean(differences);
  const random = mulberry32(seed);
  const bootstrapEstimates = new Array<number>(samples);
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    let total = 0;
    for (let draw = 0; draw < differences.length; draw += 1) {
      total += differences[Math.floor(random() * differences.length)];
    }
    bootstrapEstimates[sampleIndex] = total / differences.length;
  }
  bootstrapEstimates.sort((left, right) => left - right);

  return {
    estimate: round6(estimate),
    lower_95: round6(quantile(bootstrapEstimates, 0.025)),
    upper_95: round6(quantile(bootstrapEstimates, 0.975)),
    paired_tasks: observations.length,
    bootstrap_samples: samples,
    bootstrap_seed: seed,
  };
}

export function buildComparisonCells(
  runs: readonly ToolDisclosureRun[],
  options: ComparisonOptions = {},
): ComparisonCellSummary[] {
  const samples = options.samples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  const seed = normalizeSeed(options.seed ?? DEFAULT_BOOTSTRAP_SEED);
  const groups = new Map<string, ComparisonGroup>();

  for (const run of runs) {
    validateRun(run);
    if (run.phase === "static-visibility") continue;
    const key = [run.campaign_id, run.phase, run.agent, run.catalog_size].join("\u0000");
    const group = groups.get(key) ?? {
      campaignId: run.campaign_id,
      phase: run.phase,
      agent: run.agent,
      catalogSize: run.catalog_size,
      runs: [],
    };
    group.runs.push(run);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort(compareComparisonGroups)
    .map((group) => buildComparisonCell(group, samples, seed));
}

/**
 * Produces exact visibility reductions. Repeated captures are accepted only
 * when every count is identical, preventing a nondeterministic schema snapshot
 * from being rounded into a public claim.
 */
export function summarizeStaticVisibility(
  runs: readonly ToolDisclosureRun[],
): SchemaReductionSummary[] {
  const groups = new Map<string, StaticGroup>();
  for (const run of runs) {
    validateRun(run);
    if (run.phase !== "static-visibility") continue;
    const key = [run.campaign_id, run.agent, run.catalog_size].join("\u0000");
    const group = groups.get(key) ?? {
      campaignId: run.campaign_id,
      agent: run.agent,
      catalogSize: run.catalog_size,
      runs: [],
    };
    group.runs.push(run);
    groups.set(key, group);
  }

  return [...groups.values()].sort(compareStaticGroups).map((group) => {
    const direct = exactVisibilitySnapshot(group, "direct");
    const progressive = exactVisibilitySnapshot(group, "progressive");
    if (direct.tokenizer_tokens <= 0) {
      throw new Error(
        `direct static visibility must contain tokenizer tokens for ${staticGroupLabel(group)}`,
      );
    }
    return {
      campaign_id: group.campaignId,
      agent: group.agent,
      catalog_size: group.catalogSize,
      direct,
      progressive,
      reduction: {
        tool_count: direct.tool_count - progressive.tool_count,
        serialized_bytes: direct.serialized_bytes - progressive.serialized_bytes,
        tokenizer_tokens: direct.tokenizer_tokens - progressive.tokenizer_tokens,
        tokenizer_tokens_percent: round6(
          ((direct.tokenizer_tokens - progressive.tokenizer_tokens) / direct.tokenizer_tokens) *
            100,
        ),
      },
    };
  });
}

export function evaluateClaimGates(
  comparisonCells: readonly ComparisonCellSummary[],
  staticVisibility: readonly SchemaReductionSummary[],
  options: ClaimGateOptions,
): ClaimGateSummary {
  const agents = unique(options.agents);
  const campaignIds = unique(options.campaignIds);
  const margin = options.noninferiorityMarginPercentagePoints ?? DEFAULT_NONINFERIORITY_MARGIN_PP;
  assertFinite(margin, "noninferiority margin");
  const campaignCountValid = campaignIds.length === 2;
  const gates: CampaignAgentGate[] = [];

  for (const campaignId of campaignIds) {
    for (const agent of agents) {
      const matches = comparisonCells.filter(
        (cell) =>
          cell.campaign_id === campaignId &&
          cell.phase === "primary" &&
          cell.agent === agent &&
          cell.catalog_size === options.primaryCatalogSize,
      );
      const staticMatches = staticVisibility.filter(
        (cell) =>
          cell.campaign_id === campaignId &&
          cell.agent === agent &&
          cell.catalog_size === options.primaryCatalogSize,
      );
      const reasons: string[] = [];
      if (!campaignCountValid) reasons.push("claim gate requires exactly two campaigns");
      if (matches.length !== 1) {
        reasons.push(`expected one primary comparison cell, found ${matches.length}`);
      }
      if (staticMatches.length !== 1) {
        reasons.push(
          `expected one deterministic static visibility cell, found ${staticMatches.length}`,
        );
      }

      const cell = matches[0];
      const staticCell = staticMatches[0];
      const successLower = cell?.differences.success_percentage_points.lower_95;
      const schemaUpper = cell?.differences.initial_tool_schema_tokens.upper_95;
      const latencyUpper = cell?.differences.end_to_end_time_ms?.upper_95;
      const successNoninferior =
        campaignCountValid &&
        matches.length === 1 &&
        successLower !== undefined &&
        cell.differences.success_percentage_points.paired_tasks === 24 &&
        successLower >= margin;
      const schemaImproved =
        campaignCountValid &&
        successNoninferior &&
        matches.length === 1 &&
        staticMatches.length === 1 &&
        schemaUpper !== undefined &&
        cell.differences.initial_tool_schema_tokens.paired_tasks === 24 &&
        schemaUpper < 0 &&
        staticCell.reduction.tokenizer_tokens > 0;
      const latencyImproved =
        campaignCountValid &&
        successNoninferior &&
        matches.length === 1 &&
        latencyUpper !== undefined &&
        cell.differences.end_to_end_time_ms?.paired_tasks === 24 &&
        latencyUpper < 0;

      if (cell && !successNoninferior) {
        if (cell.differences.success_percentage_points.paired_tasks !== 24) {
          reasons.push("success gate requires exactly 24 paired primary tasks");
        } else {
          reasons.push(
            `success lower CI ${formatNumber(successLower)} pp is below ${formatNumber(margin)} pp`,
          );
        }
      }
      if (cell && staticCell && !schemaImproved) {
        reasons.push(
          cell.differences.initial_tool_schema_tokens.paired_tasks !== 24
            ? "schema-token gate requires exactly 24 paired primary tasks"
            : "initial schema-token improvement is not significant and repeatable",
        );
      }
      if (cell && !latencyImproved) {
        reasons.push(
          cell.differences.end_to_end_time_ms?.paired_tasks !== 24
            ? "latency gate requires exactly 24 paired primary tasks"
            : "end-to-end latency improvement requires success noninferiority and a repeatable CI below zero",
        );
      }

      gates.push({
        campaign_id: campaignId,
        agent,
        success_noninferior: successNoninferior,
        initial_schema_tokens_improved: schemaImproved,
        end_to_end_latency_improved: latencyImproved,
        success_lower_95_percentage_points: successLower,
        schema_tokens_upper_95: schemaUpper,
        latency_upper_95_ms: latencyUpper,
        reasons,
      });
    }
  }

  const completeMatrix =
    campaignCountValid && agents.length > 0 && gates.length === agents.length * campaignIds.length;
  return {
    required_agents: agents,
    required_campaigns: campaignIds,
    primary_catalog_size: options.primaryCatalogSize,
    noninferiority_margin_percentage_points: margin,
    campaign_agent_gates: gates,
    cross_agent_success_noninferior:
      completeMatrix && gates.every((gate) => gate.success_noninferior),
    cross_agent_initial_schema_tokens_improved:
      completeMatrix && gates.every((gate) => gate.initial_schema_tokens_improved),
    cross_agent_end_to_end_latency_improved:
      completeMatrix && gates.every((gate) => gate.end_to_end_latency_improved),
  };
}

export function buildToolDisclosureSummary(
  manifest: ToolDisclosureManifest,
  runs: readonly ToolDisclosureRun[],
  options: { generatedAt?: string } = {},
): ToolDisclosureSummary {
  validateEvidenceSet(manifest, runs);
  const comparisonCells = buildComparisonCells(runs, {
    samples: manifest.protocol.bootstrap_samples,
    seed: manifest.protocol.bootstrap_seed,
  });
  const staticVisibility = summarizeStaticVisibility(runs);
  const claimGates = evaluateClaimGates(comparisonCells, staticVisibility, {
    agents: manifest.protocol.agents,
    campaignIds: manifest.campaigns.map((campaign) => campaign.campaign_id),
    primaryCatalogSize: manifest.protocol.primary_catalog_size,
    noninferiorityMarginPercentagePoints: manifest.protocol.noninferiority_margin_percentage_points,
  });
  const summaryWithoutClaims: ToolDisclosureSummary = {
    schema_version: TOOL_DISCLOSURE_SCHEMA_VERSION,
    benchmark_id: manifest.benchmark_id,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    bootstrap_samples: manifest.protocol.bootstrap_samples,
    bootstrap_seed: normalizeSeed(manifest.protocol.bootstrap_seed),
    comparison_cells: comparisonCells,
    static_visibility: staticVisibility,
    claim_gates: claimGates,
    claims: [],
  };
  return {
    ...summaryWithoutClaims,
    claims: buildConservativeClaims(summaryWithoutClaims),
  };
}

/** Public claim text is derived only from gated values; callers cannot supply prose. */
export function buildConservativeClaims(summary: ToolDisclosureSummary): string[] {
  const claims: string[] = [];
  const gates = summary.claim_gates;
  const targetStaticCells = summary.static_visibility.filter(
    (cell) =>
      gates.required_campaigns.includes(cell.campaign_id) &&
      gates.required_agents.includes(cell.agent) &&
      cell.catalog_size === gates.primary_catalog_size,
  );
  const expectedCellCount = gates.required_campaigns.length * gates.required_agents.length;
  const successMatrixPasses = claimGateMatrixPasses(summary, (gate) =>
    Boolean(
      gate.success_noninferior &&
        gate.success_lower_95_percentage_points !== undefined &&
        gate.success_lower_95_percentage_points >= gates.noninferiority_margin_percentage_points,
    ),
  );
  const schemaMatrixPasses = claimGateMatrixPasses(summary, (gate) =>
    Boolean(
      gate.initial_schema_tokens_improved &&
        gate.schema_tokens_upper_95 !== undefined &&
        gate.schema_tokens_upper_95 < 0,
    ),
  );
  const latencyMatrixPasses = claimGateMatrixPasses(summary, (gate) =>
    Boolean(
      gate.end_to_end_latency_improved &&
        gate.latency_upper_95_ms !== undefined &&
        gate.latency_upper_95_ms < 0,
    ),
  );

  if (
    gates.cross_agent_initial_schema_tokens_improved &&
    gates.cross_agent_success_noninferior &&
    successMatrixPasses &&
    schemaMatrixPasses &&
    expectedCellCount > 0 &&
    targetStaticCells.length === expectedCellCount &&
    targetStaticCells.every((cell) => cell.reduction.tokenizer_tokens > 0)
  ) {
    const reductions = targetStaticCells.map((cell) => cell.reduction.tokenizer_tokens_percent);
    const minimumReduction = Math.min(...reductions);
    const exactNinetyNine = reductions.every((reduction) => reduction >= 99);
    const amount = exactNinetyNine
      ? "at least 99%"
      : `at least ${formatConservativePercent(minimumReduction)}`;
    claims.push(
      `Across ${gates.required_agents.length} agents and two independent campaigns at ` +
        `${gates.primary_catalog_size} catalog tools, progressive disclosure reduced initial ` +
        `serialized tool-schema tokens ${amount}.`,
    );
    // Defensive invariant: the 99% wording is impossible below the measured threshold.
    if (minimumReduction < 99 && claims.at(-1)?.includes("99%")) {
      throw new Error("claim generator attempted to overstate schema-token reduction");
    }
  }

  if (gates.cross_agent_success_noninferior && successMatrixPasses) {
    claims.push(
      `Across ${gates.required_agents.length} agents and two independent campaigns at ` +
        `${gates.primary_catalog_size} catalog tools, progressive disclosure was noninferior ` +
        `to direct exposure for task success at the ${formatNumber(
          Math.abs(gates.noninferiority_margin_percentage_points),
        )}-percentage-point margin.`,
    );
  }

  if (
    gates.cross_agent_end_to_end_latency_improved &&
    gates.cross_agent_success_noninferior &&
    successMatrixPasses &&
    latencyMatrixPasses
  ) {
    claims.push(
      `Across ${gates.required_agents.length} agents and two independent campaigns at ` +
        `${gates.primary_catalog_size} catalog tools, progressive disclosure reduced ` +
        `end-to-end task latency with paired 95% confidence intervals below zero.`,
    );
  }
  return claims;
}

function claimGateMatrixPasses(
  summary: ToolDisclosureSummary,
  predicate: (gate: CampaignAgentGate) => boolean,
): boolean {
  const gates = summary.claim_gates;
  if (
    gates.required_campaigns.length !== 2 ||
    unique(gates.required_campaigns).length !== gates.required_campaigns.length ||
    gates.required_agents.length === 0 ||
    unique(gates.required_agents).length !== gates.required_agents.length
  ) {
    return false;
  }
  for (const campaignId of gates.required_campaigns) {
    for (const agent of gates.required_agents) {
      const matching = gates.campaign_agent_gates.filter(
        (gate) => gate.campaign_id === campaignId && gate.agent === agent,
      );
      if (matching.length !== 1 || !predicate(matching[0])) return false;
    }
  }
  return (
    gates.campaign_agent_gates.length ===
    gates.required_campaigns.length * gates.required_agents.length
  );
}

function buildComparisonCell(
  group: ComparisonGroup,
  samples: number,
  baseSeed: number,
): ComparisonCellSummary {
  const directRuns = group.runs.filter((run) => run.mode === "direct");
  const progressiveRuns = group.runs.filter((run) => run.mode === "progressive");
  if (directRuns.length === 0 || progressiveRuns.length === 0) {
    throw new Error(`comparison requires both modes for ${comparisonGroupLabel(group)}`);
  }
  const directTasks = aggregateTasks(directRuns);
  const progressiveTasks = aggregateTasks(progressiveRuns);
  const taskIds = [...directTasks.keys()]
    .filter((taskId) => progressiveTasks.has(taskId))
    .sort((left, right) => left.localeCompare(right));
  if (taskIds.length === 0) {
    throw new Error(`comparison has no scored task pairs for ${comparisonGroupLabel(group)}`);
  }

  const metricSeed = (metric: string): number =>
    deriveSeed(
      baseSeed,
      [group.campaignId, group.phase, group.agent, group.catalogSize, metric].join("|"),
    );
  const difference = (
    metric: keyof TaskAggregate,
    seedName: string,
    scale = 1,
  ): ConfidenceInterval | undefined => {
    const pairs: PairedObservation[] = [];
    for (const taskId of taskIds) {
      const directValue = directTasks.get(taskId)?.[metric];
      const progressiveValue = progressiveTasks.get(taskId)?.[metric];
      if (directValue === undefined || progressiveValue === undefined) continue;
      pairs.push({ direct: directValue * scale, progressive: progressiveValue * scale });
    }
    if (pairs.length === 0) return undefined;
    return pairedBootstrapDifference(pairs, { samples, seed: metricSeed(seedName) });
  };
  const success = difference("success", "success", 100);
  const schema = difference("initialSchemaTokens", "initial-schema-tokens");
  if (!success || !schema) {
    throw new Error(`comparison is missing required metrics for ${comparisonGroupLabel(group)}`);
  }

  return {
    campaign_id: group.campaignId,
    phase: group.phase,
    agent: group.agent,
    catalog_size: group.catalogSize,
    direct: aggregateMode(directRuns, directTasks),
    progressive: aggregateMode(progressiveRuns, progressiveTasks),
    differences: {
      success_percentage_points: success,
      initial_tool_schema_tokens: schema,
      total_prompt_tokens: difference("totalPromptTokens", "total-prompt-tokens"),
      time_to_first_response_byte_ms: difference(
        "timeToFirstResponseByteMs",
        "time-to-first-response-byte",
      ),
      end_to_end_time_ms: difference("endToEndTimeMs", "end-to-end-time"),
    },
  };
}

function aggregateTasks(runs: readonly ToolDisclosureRun[]): Map<string, TaskAggregate> {
  const byTask = new Map<string, ToolDisclosureRun[]>();
  for (const run of runs) {
    if (!run.scored) continue;
    const taskRuns = byTask.get(run.task_id) ?? [];
    taskRuns.push(run);
    byTask.set(run.task_id, taskRuns);
  }
  return new Map(
    [...byTask.entries()].map(([taskId, taskRuns]) => [
      taskId,
      {
        success: mean(taskRuns.map((run) => Number(run.correctness.task_success))),
        initialSchemaTokens: mean(
          taskRuns.map((run) => run.measurements.initial_tool_schema.tokenizer_tokens),
        ),
        totalPromptTokens: optionalMean(
          taskRuns.map((run) => run.measurements.total_prompt_tokens),
        ),
        timeToFirstResponseByteMs: optionalMean(
          taskRuns.map((run) => run.measurements.time_to_first_response_byte_ms),
        ),
        endToEndTimeMs: optionalMean(taskRuns.map((run) => run.measurements.end_to_end_time_ms)),
      },
    ]),
  );
}

function aggregateMode(
  runs: readonly ToolDisclosureRun[],
  tasks: ReadonlyMap<string, TaskAggregate>,
): ModeAggregate {
  const taskValues = [...tasks.values()];
  return {
    runs: runs.length,
    scored_runs: runs.filter((run) => run.scored).length,
    tasks: tasks.size,
    success_rate_percent: round6(mean(taskValues.map((task) => task.success)) * 100),
    mean_initial_tool_schema_tokens: round6(
      mean(taskValues.map((task) => task.initialSchemaTokens)),
    ),
    mean_total_prompt_tokens: optionalMean(taskValues.map((task) => task.totalPromptTokens)),
    mean_time_to_first_response_byte_ms: optionalMean(
      taskValues.map((task) => task.timeToFirstResponseByteMs),
    ),
    mean_end_to_end_time_ms: optionalMean(taskValues.map((task) => task.endToEndTimeMs)),
  };
}

function exactVisibilitySnapshot(
  group: StaticGroup,
  mode: ToolDisclosureMode,
): SchemaVisibilitySnapshot {
  const modeRuns = group.runs.filter((run) => run.mode === mode && run.outcome === "success");
  if (modeRuns.length === 0) {
    throw new Error(`static visibility is missing ${mode} mode for ${staticGroupLabel(group)}`);
  }
  const signatures = new Set(
    modeRuns.map((run) => {
      const value = run.measurements.initial_tool_schema;
      return `${value.tool_count}:${value.serialized_bytes}:${value.tokenizer_tokens}`;
    }),
  );
  if (signatures.size !== 1) {
    throw new Error(
      `static visibility is nondeterministic for ${mode} mode in ${staticGroupLabel(group)}`,
    );
  }
  const measurement = modeRuns[0].measurements.initial_tool_schema;
  return { ...measurement, samples: modeRuns.length };
}

function validateEvidenceSet(
  manifest: ToolDisclosureManifest,
  runs: readonly ToolDisclosureRun[],
): void {
  if (manifest.schema_version !== TOOL_DISCLOSURE_SCHEMA_VERSION) {
    throw new Error(`unsupported manifest schema: ${manifest.schema_version}`);
  }
  if (manifest.campaigns.length !== 2) {
    throw new Error("public claim protocol requires exactly two campaigns");
  }
  for (const run of runs) {
    if (run.schema_version !== manifest.schema_version) {
      throw new Error(`run ${run.run_id} uses a different schema version`);
    }
    if (run.benchmark_id !== manifest.benchmark_id) {
      throw new Error(`run ${run.run_id} belongs to a different benchmark`);
    }
  }
}

function validateRun(run: ToolDisclosureRun): void {
  if (run.schema_version !== TOOL_DISCLOSURE_SCHEMA_VERSION) {
    throw new Error(`run ${run.run_id} has unsupported schema ${run.schema_version}`);
  }
  const shouldBeScored = run.phase !== "static-visibility" && run.outcome !== "setup-error";
  if (run.phase !== "static-visibility" && !run.task_kind) {
    throw new Error(`run ${run.run_id} is missing its task kind`);
  }
  if (run.scored !== shouldBeScored) {
    throw new Error(`run ${run.run_id} has inconsistent scored/outcome fields`);
  }
  if (
    run.phase !== "static-visibility" &&
    run.correctness.task_success !== (run.outcome === "success")
  ) {
    throw new Error(`run ${run.run_id} has inconsistent success/outcome fields`);
  }
  for (const [name, value] of Object.entries(run.measurements.initial_tool_schema)) {
    assertNonnegativeInteger(value, `${run.run_id} initial_tool_schema.${name}`);
  }
}

function compareComparisonGroups(left: ComparisonGroup, right: ComparisonGroup): number {
  return (
    left.campaignId.localeCompare(right.campaignId) ||
    PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase] ||
    left.agent.localeCompare(right.agent) ||
    left.catalogSize - right.catalogSize
  );
}

function compareStaticGroups(left: StaticGroup, right: StaticGroup): number {
  return (
    left.campaignId.localeCompare(right.campaignId) ||
    left.agent.localeCompare(right.agent) ||
    left.catalogSize - right.catalogSize
  );
}

function comparisonGroupLabel(group: ComparisonGroup): string {
  return `${group.campaignId}/${group.phase}/${group.agent}/${group.catalogSize}`;
}

function staticGroupLabel(group: StaticGroup): string {
  return `${group.campaignId}/${group.agent}/${group.catalogSize}`;
}

function optionalMean(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) return undefined;
  present.forEach((value) => assertFinite(value, "metric value"));
  return round6(mean(present));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("mean requires at least one value");
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function quantile(sortedValues: readonly number[], probability: number): number {
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

function deriveSeed(baseSeed: number, label: string): number {
  let hash = normalizeSeed(baseSeed) ^ 0x81_1c_9d_c5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return normalizeSeed(hash);
}

function normalizeSeed(seed: number): number {
  if (!Number.isInteger(seed))
    throw new Error(`bootstrap seed must be an integer, received ${seed}`);
  return seed >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return "unavailable";
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatConservativePercent(value: number): string {
  // One decimal avoids rounding a sub-99 result into the public "99%" headline.
  const floored = Math.floor(value * 10) / 10;
  return `${formatNumber(floored)}%`;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
}
