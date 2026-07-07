// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  routeCompositionalTools,
  routeCompositionalToolsPaired,
} from "../../scripts/performance/tool-disclosure/compositional-tool-router";
import {
  COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES,
  COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS,
  type CompositionalRoutingCasePrediction,
  type CompositionalRoutingVariant,
  type CompositionalRoutingVariantInput,
  compareCompositionalRoutingVariants,
  DEFAULT_COMPOSITIONAL_ROUTING_GATE_THRESHOLDS,
  evaluateCompositionalRoutingGates,
  evaluateCompositionalRoutingVariant,
} from "../../scripts/performance/tool-disclosure/compositional-tool-routing-acceptance";
import { PortableHashingTextEmbedder } from "../../scripts/performance/tool-disclosure/compositional-tool-routing-adapters";

const toolNames = COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS.map((tool) => tool.name);

function perfectPrediction(variant: CompositionalRoutingVariant): CompositionalRoutingVariantInput {
  return {
    variant,
    cases: COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES.map((fixture) => {
      const expectedNames = fixture.expected_steps.map((expected) => expected.tool_name);
      return {
        case_id: fixture.id,
        disposition: "routed" as const,
        fallback: null,
        steps: fixture.expected_steps.map((expected, index) => ({
          subtask: `${fixture.id} scripted atomic step ${index + 1}`,
          ranked_tool_names: [
            expected.tool_name,
            ...toolNames.filter((name) => name !== expected.tool_name),
          ],
        })),
        selected_tool_names: expectedNames,
      };
    }),
  };
}

function replaceCase(
  input: CompositionalRoutingVariantInput,
  caseId: string,
  update: (prediction: CompositionalRoutingCasePrediction) => CompositionalRoutingCasePrediction,
): CompositionalRoutingVariantInput {
  return {
    ...input,
    cases: input.cases.map((prediction) =>
      prediction.case_id === caseId ? update(prediction) : prediction,
    ),
  };
}

describe("compositional routing acceptance corpus", () => {
  it("contains distinct metadata and unambiguous cases from zero through five steps", () => {
    expect(COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS).toHaveLength(20);
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(
      new Set(COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS.map((tool) => tool.description)).size,
    ).toBe(COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS.length);

    const stepCounts = COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES.map(
      (fixture) => fixture.expected_steps.length,
    );
    expect(new Set(stepCounts)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(stepCounts.reduce((total, count) => total + count, 0)).toBe(18);
    for (const fixture of COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES) {
      expect(fixture.prompt.trim()).not.toBe("");
      for (const expected of fixture.expected_steps) {
        expect(toolNames).toContain(expected.tool_name);
        expect(fixture.prompt.toLocaleLowerCase("en-US")).toContain(expected.prompt_cue);
        expect(fixture.prompt).not.toContain(expected.tool_name);
      }
    }
  });

  it("scores perfect scripted decomposition, retrieval, selection, and no-tool behavior", () => {
    const metrics = evaluateCompositionalRoutingVariant(perfectPrediction("refined"));

    expect(metrics).toMatchObject({
      variant: "refined",
      case_count: 8,
      expected_step_count: 18,
      predicted_step_count: 18,
      decomposition_exact_rate: 1,
      decomposition_within_one_rate: 1,
      exact_tool_recall_at_1: 1,
      exact_tool_recall_at_10: 1,
      chain_exact_selection_rate: 1,
      selection_count_exact_rate: 1,
      selected_tool_count: 18,
      mean_selected_tool_count: 2.25,
      max_selected_tool_count: 5,
      no_tool_case_count: 1,
      no_tool_exact_rate: 1,
    });
    expect(metrics.cases.flatMap((fixture) => fixture.expected_tool_ranks)).toEqual(
      Array.from({ length: 18 }, () => 1),
    );
    expect(evaluateCompositionalRoutingGates(metrics)).toMatchObject({ passed: true, reasons: [] });
  });

  it("passes the acceptance gates through the real router when decomposition is held fixed", async () => {
    const embedder = new PortableHashingTextEmbedder();
    const predictions: CompositionalRoutingCasePrediction[] = [];
    for (const fixture of COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES) {
      const subtasks = fixture.expected_steps.map((expected) => expected.capability);
      const routed = await routeCompositionalTools(
        fixture.prompt,
        COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS,
        {
          embedder,
          decomposer: { decompose: async () => subtasks },
        },
      );
      expect(routed.disposition, fixture.id).toBe("routed");
      predictions.push({
        case_id: fixture.id,
        disposition: routed.disposition,
        fallback: routed.evidence.fallback,
        steps: routed.evidence.final_candidate_tool_names.map((ranked, index) => ({
          subtask: subtasks[index] ?? "no external capability",
          ranked_tool_names: ranked,
        })),
        selected_tool_names: routed.selected_tool_names,
      });
    }

    const metrics = evaluateCompositionalRoutingVariant({ variant: "refined", cases: predictions });
    expect(metrics).toMatchObject({
      decomposition_exact_rate: 1,
      exact_tool_recall_at_1: 1,
      exact_tool_recall_at_10: 1,
      chain_exact_selection_rate: 1,
      selection_count_exact_rate: 1,
      max_selected_tool_count: 5,
      no_tool_exact_rate: 1,
    });
    expect(evaluateCompositionalRoutingGates(metrics)).toMatchObject({ passed: true, reasons: [] });
  });

  it("shares the initial model output in the scripted initial-versus-refined control", async () => {
    const embedder = new PortableHashingTextEmbedder();
    const initialCases: CompositionalRoutingCasePrediction[] = [];
    const refinedCases: CompositionalRoutingCasePrediction[] = [];
    for (const fixture of COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES) {
      const refinedSubtasks = fixture.expected_steps.map((expected) => expected.capability);
      const initialSubtasks =
        refinedSubtasks.length <= 1
          ? refinedSubtasks
          : [`complete the ${refinedSubtasks.length} requested operations`];
      const pair = await routeCompositionalToolsPaired(
        fixture.prompt,
        COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS,
        {
          embedder,
          decomposer: {
            decompose: async (request) =>
              request.pass === "refined" ? refinedSubtasks : initialSubtasks,
          },
        },
      );
      expect(pair.shared_initial_decomposition, fixture.id).toBe(true);
      initialCases.push({
        case_id: fixture.id,
        disposition: pair.initial.disposition,
        fallback: pair.initial.evidence.fallback,
        steps: pair.initial.evidence.final_candidate_tool_names.map((ranked, index) => ({
          subtask: initialSubtasks[index] ?? "no external capability",
          ranked_tool_names: ranked,
        })),
        selected_tool_names: pair.initial.selected_tool_names,
      });
      refinedCases.push({
        case_id: fixture.id,
        disposition: pair.refined.disposition,
        fallback: pair.refined.evidence.fallback,
        steps: pair.refined.evidence.final_candidate_tool_names.map((ranked, index) => ({
          subtask: refinedSubtasks[index] ?? "no external capability",
          ranked_tool_names: ranked,
        })),
        selected_tool_names: pair.refined.selected_tool_names,
      });
    }

    const comparison = compareCompositionalRoutingVariants(
      { variant: "initial", cases: initialCases },
      { variant: "refined", cases: refinedCases },
    );

    expect(comparison.initial.decomposition_exact_rate).toBeLessThan(1);
    expect(comparison.refined.decomposition_exact_rate).toBe(1);
    expect(comparison.refined.exact_tool_recall_at_1).toBe(1);
    expect(comparison.refined_minus_initial.decomposition_exact_rate).toBeGreaterThan(0);
    expect(comparison.refined_not_worse).toBe(true);
    expect(comparison.refined_gate.passed).toBe(true);
    expect(comparison.passed).toBe(true);
  });

  it("compares scripted initial and refined inputs without treating them as empirical evidence", () => {
    let initial = perfectPrediction("initial");
    initial = replaceCase(initial, "route-chain-three-analysis-01", (prediction) => ({
      ...prediction,
      steps: prediction.steps.slice(0, 2),
      selected_tool_names: prediction.selected_tool_names.slice(0, 2),
    }));
    initial = replaceCase(initial, "route-single-bars-01", (prediction) => ({
      ...prediction,
      steps: prediction.steps.map((step) => ({
        ...step,
        ranked_tool_names: [
          "route_render_line_chart",
          ...step.ranked_tool_names.filter((name) => name !== "route_render_line_chart"),
        ],
      })),
      selected_tool_names: ["route_render_line_chart"],
    }));

    const comparison = compareCompositionalRoutingVariants(initial, perfectPrediction("refined"));

    expect(comparison.initial.decomposition_exact_rate).toBeLessThan(1);
    expect(comparison.initial.exact_tool_recall_at_1).toBeLessThan(1);
    expect(comparison.initial.chain_exact_selection_rate).toBeLessThan(1);
    expect(comparison.refined_minus_initial.decomposition_exact_rate).toBeGreaterThan(0);
    expect(comparison.refined_minus_initial.exact_tool_recall_at_1).toBeGreaterThan(0);
    expect(comparison.refined_not_worse).toBe(true);
    expect(comparison.refined_gate.passed).toBe(true);
    expect(comparison.passed).toBe(true);
  });

  it("fails strict gates when one selected chain is wrong", () => {
    const refined = replaceCase(
      perfectPrediction("refined"),
      "route-single-bars-01",
      (prediction) => ({
        ...prediction,
        selected_tool_names: ["route_render_line_chart"],
      }),
    );
    const metrics = evaluateCompositionalRoutingVariant(refined);
    const gate = evaluateCompositionalRoutingGates(metrics);

    expect(metrics.exact_tool_recall_at_1).toBe(1);
    expect(metrics.chain_exact_selection_rate).toBe(7 / 8);
    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain("chain_exact_selection_rate 0.875 is below 1");
  });

  it("counts a no-tool decomposition or selection as a control failure", () => {
    const refined = replaceCase(perfectPrediction("refined"), "route-no-tool-01", (prediction) => ({
      ...prediction,
      steps: [
        {
          subtask: "unnecessary external lookup",
          ranked_tool_names: ["route_lookup_directory_contact"],
        },
      ],
      selected_tool_names: ["route_lookup_directory_contact"],
    }));
    const metrics = evaluateCompositionalRoutingVariant(refined);

    expect(metrics.no_tool_exact_rate).toBe(0);
    expect(metrics.selection_count_exact_rate).toBe(7 / 8);
    expect(metrics.max_selected_tool_count).toBe(5);
    expect(evaluateCompositionalRoutingGates(metrics).passed).toBe(false);
  });

  it("cannot score a failed-open no-tool route as successful", () => {
    const refined = replaceCase(perfectPrediction("refined"), "route-no-tool-01", (prediction) => ({
      ...prediction,
      disposition: "passthrough",
      fallback: "initial-decomposition-failed",
      selected_tool_names: [],
    }));
    const metrics = evaluateCompositionalRoutingVariant(refined);

    expect(metrics.routing_success_rate).toBe(7 / 8);
    expect(metrics.route_failure_case_count).toBe(1);
    expect(metrics.no_tool_exact_rate).toBe(0);
    expect(metrics.chain_exact_forwarding_rate).toBe(7 / 8);
    expect(metrics.forwarding_count_exact_rate).toBe(7 / 8);
    expect(metrics.max_forwarded_tool_count).toBe(20);
    expect(metrics.cases[0]).toMatchObject({
      disposition: "passthrough",
      routing_succeeded: false,
      forwarded_tool_count: 20,
      no_tool_exact: false,
    });
    const permissive = Object.fromEntries(
      Object.entries(DEFAULT_COMPOSITIONAL_ROUTING_GATE_THRESHOLDS).map(([key, value]) => [
        key,
        key.startsWith("min_") ? 0 : Math.max(value, 20),
      ]),
    ) as unknown as typeof DEFAULT_COMPOSITIONAL_ROUTING_GATE_THRESHOLDS;
    expect(evaluateCompositionalRoutingGates(metrics, permissive)).toMatchObject({
      passed: false,
      reasons: ["route_failure_case_count 1 must be zero"],
    });
  });

  it("rejects incomplete, duplicate, and unknown-tool evidence", () => {
    const perfect = perfectPrediction("refined");
    expect(() =>
      evaluateCompositionalRoutingVariant({ ...perfect, cases: perfect.cases.slice(1) }),
    ).toThrow(/exactly 8 cases/);
    expect(() =>
      evaluateCompositionalRoutingVariant({
        ...perfect,
        cases: [perfect.cases[0], ...perfect.cases.slice(0, -1)],
      }),
    ).toThrow(/duplicate case/);
    expect(() =>
      evaluateCompositionalRoutingVariant(
        replaceCase(perfect, "route-single-csv-01", (prediction) => ({
          ...prediction,
          selected_tool_names: ["route_unknown"],
        })),
      ),
    ).toThrow(/selected unknown tool/);
    expect(() =>
      evaluateCompositionalRoutingVariant(
        replaceCase(perfect, "route-single-csv-01", (prediction) => ({
          ...prediction,
          steps: prediction.steps.map((step) => ({
            ...step,
            ranked_tool_names: [step.ranked_tool_names[0], step.ranked_tool_names[0]],
          })),
        })),
      ),
    ).toThrow(/ranking contains duplicates/);
    expect(() =>
      evaluateCompositionalRoutingVariant(
        replaceCase(perfect, "route-single-csv-01", (prediction) => ({
          ...prediction,
          fallback: "initial-decomposition-failed",
        })),
      ),
    ).toThrow(/inconsistent disposition and fallback/);
    expect(() =>
      evaluateCompositionalRoutingVariant(
        replaceCase(perfect, "route-single-csv-01", (prediction) => ({
          ...prediction,
          disposition: "passthrough",
        })),
      ),
    ).toThrow(/inconsistent disposition and fallback/);
  });
});
