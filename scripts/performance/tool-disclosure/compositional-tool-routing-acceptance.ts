// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenAIFunctionTool } from "./catalog";
import type { RoutingFallbackReason } from "./compositional-tool-router";

export type CompositionalRoutingVariant = "initial" | "refined";

export interface CompositionalRoutingAcceptanceTool {
  name: string;
  description: string;
  definition: OpenAIFunctionTool;
}

export interface CompositionalRoutingExpectedStep {
  capability: string;
  /** A lower-case phrase that makes this capability observable in the prompt. */
  prompt_cue: string;
  tool_name: string;
}

export interface CompositionalRoutingAcceptanceCase {
  id: string;
  prompt: string;
  expected_steps: readonly CompositionalRoutingExpectedStep[];
}

export interface CompositionalRoutingStepPrediction {
  subtask: string;
  /** Best candidate first. The evaluator reads positions 1 and 1-10. */
  ranked_tool_names: readonly string[];
}

export interface CompositionalRoutingCasePrediction {
  case_id: string;
  disposition: "routed" | "passthrough";
  fallback: RoutingFallbackReason | null;
  steps: readonly CompositionalRoutingStepPrediction[];
  /** Logical router selection; passthrough forwarding is derived from the catalog. */
  selected_tool_names: readonly string[];
}

export interface CompositionalRoutingVariantInput {
  variant: CompositionalRoutingVariant;
  cases: readonly CompositionalRoutingCasePrediction[];
}

export interface CompositionalRoutingCaseResult {
  case_id: string;
  disposition: "routed" | "passthrough";
  fallback: RoutingFallbackReason | null;
  routing_succeeded: boolean;
  expected_step_count: number;
  predicted_step_count: number;
  decomposition_exact: boolean;
  decomposition_within_one: boolean;
  /** One-based rank for each expected step; null means the target was absent. */
  expected_tool_ranks: readonly (number | null)[];
  chain_exact_selection: boolean;
  selected_tool_count: number;
  selection_count_exact: boolean;
  forwarded_tool_names: readonly string[];
  forwarded_tool_count: number;
  chain_exact_forwarding: boolean;
  forwarding_count_exact: boolean;
  /** Null for cases that require tools. */
  no_tool_exact: boolean | null;
}

export interface CompositionalRoutingMetrics {
  variant: CompositionalRoutingVariant;
  case_count: number;
  route_failure_case_count: number;
  routing_success_rate: number;
  expected_step_count: number;
  predicted_step_count: number;
  decomposition_exact_rate: number;
  decomposition_within_one_rate: number;
  exact_tool_recall_at_1: number;
  exact_tool_recall_at_10: number;
  chain_exact_selection_rate: number;
  selection_count_exact_rate: number;
  chain_exact_forwarding_rate: number;
  forwarding_count_exact_rate: number;
  selected_tool_count: number;
  mean_selected_tool_count: number;
  max_selected_tool_count: number;
  forwarded_tool_count: number;
  mean_forwarded_tool_count: number;
  max_forwarded_tool_count: number;
  no_tool_case_count: number;
  no_tool_exact_rate: number;
  cases: readonly CompositionalRoutingCaseResult[];
}

export interface CompositionalRoutingGateThresholds {
  min_routing_success_rate: number;
  min_decomposition_exact_rate: number;
  min_decomposition_within_one_rate: number;
  min_exact_tool_recall_at_1: number;
  min_exact_tool_recall_at_10: number;
  min_chain_exact_selection_rate: number;
  min_selection_count_exact_rate: number;
  min_chain_exact_forwarding_rate: number;
  min_forwarding_count_exact_rate: number;
  min_no_tool_exact_rate: number;
  max_selected_tool_count: number;
  max_forwarded_tool_count: number;
}

export interface CompositionalRoutingGateResult {
  passed: boolean;
  thresholds: CompositionalRoutingGateThresholds;
  reasons: readonly string[];
}

export interface CompositionalRoutingComparison {
  initial: CompositionalRoutingMetrics;
  refined: CompositionalRoutingMetrics;
  refined_minus_initial: {
    decomposition_exact_rate: number;
    decomposition_within_one_rate: number;
    exact_tool_recall_at_1: number;
    exact_tool_recall_at_10: number;
    chain_exact_selection_rate: number;
    chain_exact_forwarding_rate: number;
    routing_success_rate: number;
  };
  refined_not_worse: boolean;
  refined_gate: CompositionalRoutingGateResult;
  passed: boolean;
  reasons: readonly string[];
}

export const DEFAULT_COMPOSITIONAL_ROUTING_GATE_THRESHOLDS: CompositionalRoutingGateThresholds = {
  min_routing_success_rate: 1,
  min_decomposition_exact_rate: 1,
  min_decomposition_within_one_rate: 1,
  min_exact_tool_recall_at_1: 1,
  min_exact_tool_recall_at_10: 1,
  min_chain_exact_selection_rate: 1,
  min_selection_count_exact_rate: 1,
  min_chain_exact_forwarding_rate: 1,
  min_forwarding_count_exact_rate: 1,
  min_no_tool_exact_rate: 1,
  max_selected_tool_count: 5,
  max_forwarded_tool_count: 5,
};

function routeTool(name: string, description: string): CompositionalRoutingAcceptanceTool {
  return {
    name,
    description,
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          description: "Route-only acceptance fixture input.",
          properties: {
            input: {
              type: "string",
              description: "Deterministic input for the selected fixture capability.",
              minLength: 1,
              maxLength: 160,
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
      },
    },
  };
}

/**
 * A small route-only catalog with deliberately distinct capability metadata.
 * It complements the scaling catalog, whose repeated category/operation pairs
 * are useful for schema-volume tests but cannot identify one exact semantic
 * target without relying on numeric suffixes.
 */
export const COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS: readonly CompositionalRoutingAcceptanceTool[] =
  [
    routeTool(
      "route_fetch_https_bytes",
      "Download raw response bytes from one HTTPS address without interpreting the payload.",
    ),
    routeTool(
      "route_read_local_file",
      "Read bytes from a file already present on the local filesystem.",
    ),
    routeTool(
      "route_decompress_gzip",
      "Expand a gzip-compressed byte stream into its original uncompressed bytes.",
    ),
    routeTool("route_decompress_zip", "Extract named members from a ZIP archive container."),
    routeTool(
      "route_parse_csv_rows",
      "Parse comma-separated text with a header row into structured records.",
    ),
    routeTool(
      "route_parse_jsonl_records",
      "Parse newline-delimited JSON text into one structured record per line.",
    ),
    routeTool(
      "route_validate_json_schema",
      "Check structured records against a supplied JSON Schema contract.",
    ),
    routeTool(
      "route_filter_tabular_rows",
      "Keep only table rows that satisfy a field-level predicate.",
    ),
    routeTool(
      "route_aggregate_numeric_column",
      "Compute a requested numeric aggregate such as an average over one table column.",
    ),
    routeTool("route_render_line_chart", "Render ordered numeric observations as a line chart."),
    routeTool("route_render_bar_chart", "Render categorical numeric values as vertical bars."),
    routeTool(
      "route_lookup_directory_contact",
      "Find a person's messaging destination in an organization directory.",
    ),
    routeTool(
      "route_draft_email_message",
      "Create an email draft with recipients, subject, and body without sending it.",
    ),
    routeTool("route_send_email_message", "Deliver an existing email draft to its recipients."),
    routeTool("route_post_team_channel", "Post a text update to a team chat channel destination."),
    routeTool("route_store_object_blob", "Write supplied bytes to an object-storage key."),
    routeTool(
      "route_query_sql_readonly",
      "Run a read-only SQL query and return tabular result rows.",
    ),
    routeTool("route_summarize_text", "Condense a text document into a short prose summary."),
    routeTool("route_transcribe_audio", "Convert spoken audio into a text transcript."),
    routeTool("route_translate_text", "Translate supplied text from one language to another."),
  ];

function step(
  toolName: string,
  capability: string,
  promptCue: string,
): CompositionalRoutingExpectedStep {
  return { tool_name: toolName, capability, prompt_cue: promptCue };
}

/** Eight unambiguous cases spanning zero through five implicit atomic capabilities. */
export const COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES: readonly CompositionalRoutingAcceptanceCase[] =
  [
    {
      id: "route-no-tool-01",
      prompt: "Use no external capability and reply with the literal phrase ROUTE-CONTROL-ALPHA.",
      expected_steps: [],
    },
    {
      id: "route-single-csv-01",
      prompt: "Turn comma-separated text with a header row into structured records.",
      expected_steps: [step("route_parse_csv_rows", "parse CSV records", "comma-separated")],
    },
    {
      id: "route-single-bars-01",
      prompt: "Show the categorical totals as vertical bars, rather than a connected line.",
      expected_steps: [
        step(
          "route_render_bar_chart",
          "render categorical values as vertical bars",
          "vertical bars",
        ),
      ],
    },
    {
      id: "route-chain-two-channel-01",
      prompt:
        "Find Morgan's team-chat destination in the organization directory, then post the status update to that channel.",
      expected_steps: [
        step("route_lookup_directory_contact", "look up a directory contact", "directory"),
        step("route_post_team_channel", "post a team-channel message", "post"),
      ],
    },
    {
      id: "route-chain-two-email-01",
      prompt: "Prepare an email draft for the reviewers, then deliver that draft to them.",
      expected_steps: [
        step("route_draft_email_message", "draft an email", "draft"),
        step("route_send_email_message", "send an email draft", "deliver"),
      ],
    },
    {
      id: "route-chain-three-analysis-01",
      prompt:
        "Run a read-only SQL query for monthly latency, calculate the average value, and plot the ordered results as a line chart.",
      expected_steps: [
        step("route_query_sql_readonly", "query SQL data", "sql"),
        step("route_aggregate_numeric_column", "aggregate a numeric column", "average"),
        step("route_render_line_chart", "render a line chart", "line chart"),
      ],
    },
    {
      id: "route-chain-four-jsonl-01",
      prompt:
        "Download the bytes at the HTTPS address, expand the gzip stream, parse its newline-delimited JSON records, and check them against the supplied JSON Schema.",
      expected_steps: [
        step("route_fetch_https_bytes", "fetch HTTPS bytes", "https"),
        step("route_decompress_gzip", "decompress gzip bytes", "gzip"),
        step("route_parse_jsonl_records", "parse JSONL records", "newline-delimited json"),
        step("route_validate_json_schema", "validate JSON records", "json schema"),
      ],
    },
    {
      id: "route-chain-five-report-01",
      prompt:
        "Fetch the CSV file from its HTTPS address, parse the comma-separated rows, keep rows whose state is active, average the cost column, and present the result as vertical bars.",
      expected_steps: [
        step("route_fetch_https_bytes", "fetch HTTPS bytes", "https"),
        step("route_parse_csv_rows", "parse CSV records", "comma-separated"),
        step("route_filter_tabular_rows", "filter table rows", "keep rows"),
        step("route_aggregate_numeric_column", "aggregate a numeric column", "average"),
        step(
          "route_render_bar_chart",
          "render categorical values as vertical bars",
          "vertical bars",
        ),
      ],
    },
  ];

function assertRate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be between zero and one`);
  }
}

function assertThresholds(thresholds: CompositionalRoutingGateThresholds): void {
  for (const [label, value] of Object.entries(thresholds)) {
    if (label === "max_selected_tool_count" || label === "max_forwarded_tool_count") continue;
    assertRate(value, label);
  }
  for (const [label, value] of [
    ["max_selected_tool_count", thresholds.max_selected_tool_count],
    ["max_forwarded_tool_count", thresholds.max_forwarded_tool_count],
  ] as const) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
    if (value < 0) throw new RangeError(`${label} must not be negative`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

function assertFixture(
  tools: readonly CompositionalRoutingAcceptanceTool[],
  cases: readonly CompositionalRoutingAcceptanceCase[],
): Set<string> {
  if (tools.length === 0) throw new Error("route acceptance catalog must not be empty");
  if (cases.length === 0) throw new Error("route acceptance cases must not be empty");
  const toolNames = tools.map((tool) => tool.name);
  assertUnique(toolNames, "route acceptance tool names");
  const knownTools = new Set(toolNames);
  const caseIds = cases.map((fixture) => fixture.id);
  assertUnique(caseIds, "route acceptance case ids");
  for (const fixture of cases) {
    if (!fixture.prompt.trim()) throw new Error(`${fixture.id} has an empty prompt`);
    const expectedNames = fixture.expected_steps.map((expected) => expected.tool_name);
    assertUnique(expectedNames, `${fixture.id} expected tool names`);
    for (const expected of fixture.expected_steps) {
      if (!knownTools.has(expected.tool_name)) {
        throw new Error(`${fixture.id} references unknown tool ${expected.tool_name}`);
      }
      if (!expected.capability.trim() || !expected.prompt_cue.trim()) {
        throw new Error(`${fixture.id} has empty expected step metadata`);
      }
      if (!fixture.prompt.toLocaleLowerCase("en-US").includes(expected.prompt_cue)) {
        throw new Error(`${fixture.id} does not expose prompt cue ${expected.prompt_cue}`);
      }
    }
  }
  return knownTools;
}

function assertPrediction(
  prediction: CompositionalRoutingCasePrediction,
  knownTools: ReadonlySet<string>,
): void {
  if (prediction.disposition !== "routed" && prediction.disposition !== "passthrough") {
    throw new TypeError(`${prediction.case_id} has an invalid disposition`);
  }
  const routingSucceeded = prediction.disposition === "routed";
  if (routingSucceeded !== (prediction.fallback === null)) {
    throw new Error(`${prediction.case_id} has inconsistent disposition and fallback`);
  }
  assertUnique(prediction.selected_tool_names, `${prediction.case_id} selected tools`);
  for (const name of prediction.selected_tool_names) {
    if (!knownTools.has(name)) {
      throw new Error(`${prediction.case_id} selected unknown tool ${name}`);
    }
  }
  for (const [index, predicted] of prediction.steps.entries()) {
    if (!predicted.subtask.trim()) {
      throw new Error(`${prediction.case_id} step ${index + 1} has an empty subtask`);
    }
    assertUnique(predicted.ranked_tool_names, `${prediction.case_id} step ${index + 1} ranking`);
    for (const name of predicted.ranked_tool_names) {
      if (!knownTools.has(name)) {
        throw new Error(`${prediction.case_id} ranked unknown tool ${name}`);
      }
    }
  }
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function sequencesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Evaluate one router variant without invoking a model or embedding implementation. */
export function evaluateCompositionalRoutingVariant(
  input: CompositionalRoutingVariantInput,
  options: {
    tools?: readonly CompositionalRoutingAcceptanceTool[];
    cases?: readonly CompositionalRoutingAcceptanceCase[];
  } = {},
): CompositionalRoutingMetrics {
  const tools = options.tools ?? COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS;
  const fixtures = options.cases ?? COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES;
  const knownTools = assertFixture(tools, fixtures);
  const catalogToolNames = tools.map((tool) => tool.name);
  if (input.cases.length !== fixtures.length) {
    throw new Error(`${input.variant} predictions must contain exactly ${fixtures.length} cases`);
  }
  const predictions = new Map<string, CompositionalRoutingCasePrediction>();
  for (const prediction of input.cases) {
    if (predictions.has(prediction.case_id)) {
      throw new Error(`${input.variant} contains duplicate case ${prediction.case_id}`);
    }
    assertPrediction(prediction, knownTools);
    predictions.set(prediction.case_id, prediction);
  }

  const results: CompositionalRoutingCaseResult[] = [];
  let expectedStepCount = 0;
  let predictedStepCount = 0;
  let routingSuccesses = 0;
  let routeFailureCases = 0;
  let exactDecomposition = 0;
  let withinOneDecomposition = 0;
  let recallAtOne = 0;
  let recallAtTen = 0;
  let exactChains = 0;
  let exactSelectionCounts = 0;
  let exactForwardingChains = 0;
  let exactForwardingCounts = 0;
  let selectedToolCount = 0;
  let maxSelectedToolCount = 0;
  let forwardedToolCount = 0;
  let maxForwardedToolCount = 0;
  let noToolCaseCount = 0;
  let exactNoToolCases = 0;

  for (const fixture of fixtures) {
    const prediction = predictions.get(fixture.id);
    if (!prediction) throw new Error(`${input.variant} is missing case ${fixture.id}`);
    const expectedNames = fixture.expected_steps.map((expected) => expected.tool_name);
    const expectedCount = expectedNames.length;
    const predictedCount = prediction.steps.length;
    const routingSucceeded = prediction.disposition === "routed";
    const forwardedToolNames = routingSucceeded
      ? [...prediction.selected_tool_names]
      : [...catalogToolNames];
    const decompositionExact = predictedCount === expectedCount;
    const decompositionWithinOne = Math.abs(predictedCount - expectedCount) <= 1;
    const expectedToolRanks = expectedNames.map((expectedName, index) => {
      const ranked = prediction.steps[index]?.ranked_tool_names ?? [];
      const rank = ranked.indexOf(expectedName);
      if (rank === 0) recallAtOne += 1;
      if (rank >= 0 && rank < 10) recallAtTen += 1;
      return rank < 0 ? null : rank + 1;
    });
    const chainExactSelection = sequencesEqual(prediction.selected_tool_names, expectedNames);
    const selectionCountExact = prediction.selected_tool_names.length === expectedCount;
    const chainExactForwarding =
      routingSucceeded && sequencesEqual(forwardedToolNames, expectedNames);
    const forwardingCountExact = routingSucceeded && forwardedToolNames.length === expectedCount;
    const noToolExact =
      expectedCount === 0
        ? routingSucceeded && predictedCount === 0 && forwardedToolNames.length === 0
        : null;

    expectedStepCount += expectedCount;
    predictedStepCount += predictedCount;
    routingSuccesses += Number(routingSucceeded);
    routeFailureCases += Number(!routingSucceeded);
    exactDecomposition += Number(decompositionExact);
    withinOneDecomposition += Number(decompositionWithinOne);
    exactChains += Number(chainExactSelection);
    exactSelectionCounts += Number(selectionCountExact);
    exactForwardingChains += Number(chainExactForwarding);
    exactForwardingCounts += Number(forwardingCountExact);
    selectedToolCount += prediction.selected_tool_names.length;
    maxSelectedToolCount = Math.max(maxSelectedToolCount, prediction.selected_tool_names.length);
    forwardedToolCount += forwardedToolNames.length;
    maxForwardedToolCount = Math.max(maxForwardedToolCount, forwardedToolNames.length);
    if (noToolExact !== null) {
      noToolCaseCount += 1;
      exactNoToolCases += Number(noToolExact);
    }
    results.push({
      case_id: fixture.id,
      disposition: prediction.disposition,
      fallback: prediction.fallback,
      routing_succeeded: routingSucceeded,
      expected_step_count: expectedCount,
      predicted_step_count: predictedCount,
      decomposition_exact: decompositionExact,
      decomposition_within_one: decompositionWithinOne,
      expected_tool_ranks: expectedToolRanks,
      chain_exact_selection: chainExactSelection,
      selected_tool_count: prediction.selected_tool_names.length,
      selection_count_exact: selectionCountExact,
      forwarded_tool_names: forwardedToolNames,
      forwarded_tool_count: forwardedToolNames.length,
      chain_exact_forwarding: chainExactForwarding,
      forwarding_count_exact: forwardingCountExact,
      no_tool_exact: noToolExact,
    });
  }

  return {
    variant: input.variant,
    case_count: fixtures.length,
    route_failure_case_count: routeFailureCases,
    routing_success_rate: rate(routingSuccesses, fixtures.length),
    expected_step_count: expectedStepCount,
    predicted_step_count: predictedStepCount,
    decomposition_exact_rate: rate(exactDecomposition, fixtures.length),
    decomposition_within_one_rate: rate(withinOneDecomposition, fixtures.length),
    exact_tool_recall_at_1: rate(recallAtOne, expectedStepCount),
    exact_tool_recall_at_10: rate(recallAtTen, expectedStepCount),
    chain_exact_selection_rate: rate(exactChains, fixtures.length),
    selection_count_exact_rate: rate(exactSelectionCounts, fixtures.length),
    chain_exact_forwarding_rate: rate(exactForwardingChains, fixtures.length),
    forwarding_count_exact_rate: rate(exactForwardingCounts, fixtures.length),
    selected_tool_count: selectedToolCount,
    mean_selected_tool_count: selectedToolCount / fixtures.length,
    max_selected_tool_count: maxSelectedToolCount,
    forwarded_tool_count: forwardedToolCount,
    mean_forwarded_tool_count: forwardedToolCount / fixtures.length,
    max_forwarded_tool_count: maxForwardedToolCount,
    no_tool_case_count: noToolCaseCount,
    no_tool_exact_rate: rate(exactNoToolCases, noToolCaseCount),
    cases: results,
  };
}

/** Apply explicit, deterministic quality and disclosure-size gates. */
export function evaluateCompositionalRoutingGates(
  metrics: CompositionalRoutingMetrics,
  thresholds: CompositionalRoutingGateThresholds = DEFAULT_COMPOSITIONAL_ROUTING_GATE_THRESHOLDS,
): CompositionalRoutingGateResult {
  assertThresholds(thresholds);
  const reasons: string[] = [];
  if (metrics.route_failure_case_count > 0) {
    reasons.push(`route_failure_case_count ${metrics.route_failure_case_count} must be zero`);
  }
  const minimums: ReadonlyArray<
    [keyof CompositionalRoutingMetrics, keyof CompositionalRoutingGateThresholds]
  > = [
    ["routing_success_rate", "min_routing_success_rate"],
    ["decomposition_exact_rate", "min_decomposition_exact_rate"],
    ["decomposition_within_one_rate", "min_decomposition_within_one_rate"],
    ["exact_tool_recall_at_1", "min_exact_tool_recall_at_1"],
    ["exact_tool_recall_at_10", "min_exact_tool_recall_at_10"],
    ["chain_exact_selection_rate", "min_chain_exact_selection_rate"],
    ["selection_count_exact_rate", "min_selection_count_exact_rate"],
    ["chain_exact_forwarding_rate", "min_chain_exact_forwarding_rate"],
    ["forwarding_count_exact_rate", "min_forwarding_count_exact_rate"],
    ["no_tool_exact_rate", "min_no_tool_exact_rate"],
  ];
  for (const [metricName, thresholdName] of minimums) {
    const value = metrics[metricName];
    const threshold = thresholds[thresholdName];
    if (typeof value !== "number" || value < threshold) {
      reasons.push(`${String(metricName)} ${String(value)} is below ${String(threshold)}`);
    }
  }
  if (metrics.max_selected_tool_count > thresholds.max_selected_tool_count) {
    reasons.push(
      `max_selected_tool_count ${metrics.max_selected_tool_count} exceeds ${thresholds.max_selected_tool_count}`,
    );
  }
  if (metrics.max_forwarded_tool_count > thresholds.max_forwarded_tool_count) {
    reasons.push(
      `max_forwarded_tool_count ${metrics.max_forwarded_tool_count} exceeds ${thresholds.max_forwarded_tool_count}`,
    );
  }
  return { passed: reasons.length === 0, thresholds: { ...thresholds }, reasons };
}

/** Compare initial and one-pass refined routing while gating refined independently. */
export function compareCompositionalRoutingVariants(
  initialInput: CompositionalRoutingVariantInput,
  refinedInput: CompositionalRoutingVariantInput,
  options: {
    tools?: readonly CompositionalRoutingAcceptanceTool[];
    cases?: readonly CompositionalRoutingAcceptanceCase[];
    thresholds?: CompositionalRoutingGateThresholds;
  } = {},
): CompositionalRoutingComparison {
  if (initialInput.variant !== "initial") {
    throw new Error("the first route comparison input must be initial");
  }
  if (refinedInput.variant !== "refined") {
    throw new Error("the second route comparison input must be refined");
  }
  const evaluateOptions = { tools: options.tools, cases: options.cases };
  const initial = evaluateCompositionalRoutingVariant(initialInput, evaluateOptions);
  const refined = evaluateCompositionalRoutingVariant(refinedInput, evaluateOptions);
  const refinedGate = evaluateCompositionalRoutingGates(refined, options.thresholds);
  const deltas = {
    decomposition_exact_rate: refined.decomposition_exact_rate - initial.decomposition_exact_rate,
    decomposition_within_one_rate:
      refined.decomposition_within_one_rate - initial.decomposition_within_one_rate,
    exact_tool_recall_at_1: refined.exact_tool_recall_at_1 - initial.exact_tool_recall_at_1,
    exact_tool_recall_at_10: refined.exact_tool_recall_at_10 - initial.exact_tool_recall_at_10,
    chain_exact_selection_rate:
      refined.chain_exact_selection_rate - initial.chain_exact_selection_rate,
    chain_exact_forwarding_rate:
      refined.chain_exact_forwarding_rate - initial.chain_exact_forwarding_rate,
    routing_success_rate: refined.routing_success_rate - initial.routing_success_rate,
  };
  const regressions = Object.entries(deltas)
    .filter(([, value]) => value < 0)
    .map(([name, value]) => `${name} regressed by ${Math.abs(value)}`);
  const reasons = [...refinedGate.reasons, ...regressions];
  return {
    initial,
    refined,
    refined_minus_initial: deltas,
    refined_not_worse: regressions.length === 0,
    refined_gate: refinedGate,
    passed: reasons.length === 0,
    reasons,
  };
}
