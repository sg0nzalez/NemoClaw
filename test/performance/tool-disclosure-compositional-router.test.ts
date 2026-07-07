// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildDenseToolIndex,
  type DecompositionRequest,
  exactInnerProductTopK,
  l2Normalize,
  routeCompositionalTools,
  routeCompositionalToolsPaired,
  selectRoutedToolDefinitions,
  type TaskDecomposer,
  type TextEmbedder,
  type ToolRoutingCatalogEntry,
  unionToolHints,
} from "../../scripts/performance/tool-disclosure/compositional-tool-router";

interface TestDefinition {
  type: "function";
  function: {
    name: string;
    parameters: { type: "object"; properties: Record<string, unknown> };
  };
}

function definition(name: string): TestDefinition {
  return {
    type: "function",
    function: {
      name,
      parameters: { type: "object", properties: { value: { type: "string" } } },
    },
  };
}

function catalogEntry(name: string, description: string): ToolRoutingCatalogEntry<TestDefinition> {
  return { name, description, definition: definition(name) };
}

class KeywordEmbedder implements TextEmbedder {
  readonly calls: string[][] = [];

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      return /calendar|appointment|event/u.test(normalized)
        ? [3, 0, 0, 0]
        : /email|notify|message/u.test(normalized)
          ? [0, 4, 0, 0]
          : /weather|forecast/u.test(normalized)
            ? [0, 0, 5, 0]
            : [0, 0, 0, 2];
    });
  }
}

describe("independent compositional tool dense retrieval", () => {
  it("normalizes vectors and applies exact top-k with score/name tie-breaking", async () => {
    expect(l2Normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(() => l2Normalize([0, 0])).toThrow("positive finite L2 norm");
    expect(() => l2Normalize([1, Number.NaN])).toThrow("must be finite");

    const catalog = [
      catalogEntry("zeta", "first horizontal tool"),
      catalogEntry("alpha", "second horizontal tool"),
      catalogEntry("vertical", "vertical tool"),
    ];
    const embedder: TextEmbedder = {
      async embed() {
        return [
          [20, 0],
          [2, 0],
          [0, 7],
        ];
      },
    };
    const index = await buildDenseToolIndex(catalog, embedder);

    expect(index.tools.map((tool) => tool.vector)).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(exactInnerProductTopK(index, [9, 0], 2)).toEqual([
      { name: "alpha", score: 1 },
      { name: "zeta", score: 1 },
    ]);

    const tied = {
      dimension: 1,
      tools: Array.from({ length: 20 }, (_, toolIndex) => ({
        name: `tool-${String(toolIndex).padStart(2, "0")}`,
        vector: [1],
      })),
    };
    expect(exactInnerProductTopK(tied, [1])).toHaveLength(10);
  });

  it("unions hints by maximum score before applying the deterministic cap", () => {
    const hints = unionToolHints(
      [
        [
          { name: "shared", score: 0.2 },
          { name: "bravo", score: 0.8 },
          { name: "charlie", score: 0.7 },
        ],
        [
          { name: "shared", score: 0.9 },
          { name: "alpha", score: 0.8 },
        ],
      ],
      3,
    );

    expect(hints).toEqual([
      { name: "shared", score: 0.9 },
      { name: "alpha", score: 0.8 },
      { name: "bravo", score: 0.8 },
    ]);

    const defaultHints = unionToolHints([
      Array.from({ length: 10 }, (_, index) => ({ name: `left-${index}`, score: 1 - index / 100 })),
      Array.from({ length: 10 }, (_, index) => ({
        name: `right-${index}`,
        score: 0.5 - index / 100,
      })),
    ]);
    expect(defaultHints).toHaveLength(12);
  });
});

describe("independent compositional tool routing", () => {
  it("shares one initial decomposition and one prepared index across paired routes", async () => {
    const catalog = [
      catalogEntry("calendar_find", "Find an appointment in a calendar."),
      catalogEntry("email_send", "Send an email message to notify a teammate."),
    ];
    const decompose = vi.fn<TaskDecomposer["decompose"]>(async (request) =>
      request.pass === "initial"
        ? ["locate the appointment", "notify the teammate"]
        : ["find the calendar event", "send the email message"],
    );
    const embedder = new KeywordEmbedder();

    const pair = await routeCompositionalToolsPaired("Arrange and notify.", catalog, {
      decomposer: { decompose },
      embedder,
    });

    expect(pair.shared_initial_decomposition).toBe(true);
    expect(pair.shared_initial_subtask_count).toBe(2);
    expect(decompose.mock.calls.filter(([request]) => request.pass === "initial")).toHaveLength(1);
    expect(decompose.mock.calls.filter(([request]) => request.pass === "refined")).toHaveLength(1);
    expect(
      embedder.calls.filter((batch) => batch.every((text) => text.includes("\n"))),
    ).toHaveLength(1);
    expect(embedder.calls).toHaveLength(3);
    expect(embedder.calls[1]).toEqual(["locate the appointment", "notify the teammate"]);
    expect(embedder.calls[2]).toEqual(["find the calendar event", "send the email message"]);
    expect(pair.initial.evidence.initial_candidate_tool_names).toEqual(
      pair.refined.evidence.initial_candidate_tool_names,
    );
    expect(pair.initial.evidence.timings.initial_decomposition_ms).toBe(
      pair.refined.evidence.timings.initial_decomposition_ms,
    );
    expect(pair.initial.evidence.timings.catalog_embedding_ms).toBe(
      pair.refined.evidence.timings.catalog_embedding_ms,
    );
    expect(pair.initial.evidence.timings.initial_retrieval_ms).toBe(
      pair.refined.evidence.timings.initial_retrieval_ms,
    );
    expect(pair.initial.selected_tool_names).toEqual(pair.refined.selected_tool_names);
  });

  it("shares paired initial failures without starting retrieval or refinement", async () => {
    const decompose = vi.fn<TaskDecomposer["decompose"]>().mockResolvedValue({ malformed: true });
    const embed = vi.fn<TextEmbedder["embed"]>();
    const pair = await routeCompositionalToolsPaired(
      "Arrange and notify.",
      [catalogEntry("calendar_find", "Find a calendar event.")],
      { decomposer: { decompose }, embedder: { embed } },
    );

    expect(decompose).toHaveBeenCalledOnce();
    expect(embed).not.toHaveBeenCalled();
    expect(pair.initial).toMatchObject({
      disposition: "passthrough",
      evidence: { fallback: "initial-decomposition-malformed" },
    });
    expect(pair.refined).toMatchObject({
      disposition: "passthrough",
      evidence: { fallback: "initial-decomposition-malformed" },
    });
    expect(pair.initial.evidence.timings.initial_decomposition_ms).toBe(
      pair.refined.evidence.timings.initial_decomposition_ms,
    );
  });

  it("shares a paired no-tool result without embedding or refining", async () => {
    const decompose = vi.fn<TaskDecomposer["decompose"]>().mockResolvedValue([]);
    const embed = vi.fn<TextEmbedder["embed"]>();
    const pair = await routeCompositionalToolsPaired(
      "Answer without tools.",
      [catalogEntry("calendar_find", "Find a calendar event.")],
      { decomposer: { decompose }, embedder: { embed } },
    );

    expect(decompose).toHaveBeenCalledOnce();
    expect(embed).not.toHaveBeenCalled();
    expect(pair.initial).toMatchObject({
      disposition: "routed",
      selected_tool_names: [],
      evidence: { decomposition_passes: 1, fallback: null },
    });
    expect(pair.refined).toMatchObject({
      disposition: "routed",
      selected_tool_names: [],
      evidence: { decomposition_passes: 1, fallback: null },
    });
  });

  it("supports a one-pass initial route over the same retriever", async () => {
    const catalog = [
      catalogEntry("calendar_find", "Find an appointment in a calendar."),
      catalogEntry("email_send", "Send an email message to notify a teammate."),
      catalogEntry("weather_read", "Read a weather forecast."),
    ];
    const decompose = vi
      .fn<TaskDecomposer["decompose"]>()
      .mockResolvedValue(["find the calendar event", "send the email message"]);

    const result = await routeCompositionalTools("Arrange and notify.", catalog, {
      decomposer: { decompose },
      embedder: new KeywordEmbedder(),
      refinementPasses: 0,
    });

    expect(decompose).toHaveBeenCalledOnce();
    expect(result.disposition).toBe("routed");
    expect(result.selected_tool_names).toEqual(["calendar_find", "email_send"]);
    expect(result.evidence).toMatchObject({
      initial_subtask_count: 2,
      refined_subtask_count: 0,
      decomposition_passes: 1,
      hint_count: 0,
      selected_tool_count: 2,
      fallback: null,
    });
    expect(result.evidence.final_candidate_counts).toEqual([3, 3]);
  });

  it("runs one initial pass and one hint-informed refinement before bounded selection", async () => {
    const catalog = [
      catalogEntry("calendar_find", "Find an appointment in a calendar."),
      catalogEntry("email_send", "Send an email message to notify a teammate."),
      catalogEntry("weather_read", "Read a weather forecast."),
      catalogEntry("generic_lookup", "Look up an unrelated record."),
    ];
    const requests: DecompositionRequest[] = [];
    const decomposer: TaskDecomposer = {
      async decompose(request) {
        requests.push(request);
        return request.pass === "initial"
          ? ["locate the appointment", "notify the teammate"]
          : ["find the calendar event", "send the email message"];
      },
    };
    const embedder = new KeywordEmbedder();
    const result = await routeCompositionalTools(
      "Arrange the appointment, then tell the teammate.",
      catalog,
      { decomposer, embedder, maxSelectedTools: 2 },
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      pass: "initial",
      query: "Arrange the appointment, then tell the teammate.",
      tool_hints: [],
    });
    expect(requests[1].pass).toBe("refined");
    expect(requests[1].tool_hints).toContain("calendar_find");
    expect(requests[1].tool_hints).toContain("email_send");
    expect(result.disposition).toBe("routed");
    expect(result.selected_tool_names).toEqual(["calendar_find", "email_send"]);
    expect(result.evidence).toMatchObject({
      initial_subtask_count: 2,
      refined_subtask_count: 2,
      decomposition_passes: 2,
      selected_tool_count: 2,
      selected_tool_names: ["calendar_find", "email_send"],
      fallback: null,
    });
    expect(result.evidence.initial_candidate_counts).toEqual([4, 4]);
    expect(result.evidence.final_candidate_counts).toEqual([4, 4]);
    expect(result.evidence.final_candidate_tool_names[0][0]).toBe("calendar_find");
    expect(result.evidence.final_candidate_tool_names[1][0]).toBe("email_send");
    expect(JSON.stringify(result.evidence)).not.toContain("Arrange the appointment");
    expect(JSON.stringify(result.evidence)).not.toContain("locate the appointment");
    expect(embedder.calls).toHaveLength(3);
  });

  it("fails open for malformed decomposition and unavailable retrieval", async () => {
    const catalog = [
      catalogEntry("calendar_find", "Find a calendar event."),
      catalogEntry("email_send", "Send an email message."),
    ];
    const malformed = await routeCompositionalTools("do work", catalog, {
      decomposer: {
        async decompose() {
          return { steps: ["do work"] };
        },
      },
      embedder: new KeywordEmbedder(),
    });
    expect(malformed.disposition).toBe("passthrough");
    expect(malformed.evidence.fallback).toBe("initial-decomposition-malformed");
    expect(selectRoutedToolDefinitions(catalog, malformed)).toEqual(
      catalog.map((entry) => entry.definition),
    );

    const unavailable = await routeCompositionalTools("find the appointment", catalog, {
      decomposer: {
        async decompose() {
          return ["find the calendar event"];
        },
      },
      embedder: {
        async embed() {
          throw new Error("embedding service unavailable");
        },
      },
    });
    expect(unavailable.disposition).toBe("passthrough");
    expect(unavailable.evidence.fallback).toBe("catalog-embedding-failed");
    expect(unavailable.selected_tool_names).toEqual([]);

    const disagreement = await routeCompositionalTools("find the appointment", catalog, {
      decomposer: {
        async decompose(request) {
          return request.pass === "initial" ? ["find the calendar event"] : [];
        },
      },
      embedder: new KeywordEmbedder(),
    });
    expect(disagreement.disposition).toBe("passthrough");
    expect(disagreement.evidence.fallback).toBe("refinement-no-tool-disagreement");
  });

  it("treats an empty initial decomposition as a valid no-tool route", async () => {
    const embed = vi.fn<TextEmbedder["embed"]>();
    const decompose = vi.fn<TaskDecomposer["decompose"]>().mockResolvedValue([]);
    const catalog = [catalogEntry("calendar_find", "Find a calendar event.")];

    const result = await routeCompositionalTools("Answer without tools.", catalog, {
      decomposer: { decompose },
      embedder: { embed },
    });

    expect(result.disposition).toBe("routed");
    expect(result.selected_tool_names).toEqual([]);
    expect(result.evidence).toMatchObject({
      initial_subtask_count: 0,
      refined_subtask_count: 0,
      decomposition_passes: 1,
      hint_count: 0,
      selected_tool_count: 0,
      fallback: null,
    });
    expect(decompose).toHaveBeenCalledOnce();
    expect(embed).not.toHaveBeenCalled();
    expect(selectRoutedToolDefinitions(catalog, result)).toEqual([]);
  });

  it("returns original schema objects in selected order and fails open above the cap", async () => {
    const calendar = catalogEntry("calendar_find", "Find a calendar event.");
    const email = catalogEntry("email_send", "Send an email message.");
    const catalog = [email, calendar];
    const originalSchemas = structuredClone(catalog.map((entry) => entry.definition));
    const decomposer: TaskDecomposer = {
      async decompose(request) {
        return request.pass === "initial"
          ? ["calendar event", "email message"]
          : ["find calendar event", "send email message"];
      },
    };
    const result = await routeCompositionalTools("schedule and notify", catalog, {
      decomposer,
      embedder: new KeywordEmbedder(),
      maxSelectedTools: 2,
    });
    const selected = selectRoutedToolDefinitions(catalog, result);

    expect(selected).toEqual([calendar.definition, email.definition]);
    expect(selected[0]).toBe(calendar.definition);
    expect(selected[1]).toBe(email.definition);
    expect(catalog.map((entry) => entry.definition)).toEqual(originalSchemas);

    const capped = await routeCompositionalTools("schedule and notify", catalog, {
      decomposer,
      embedder: new KeywordEmbedder(),
      maxSelectedTools: 1,
    });
    expect(capped.disposition).toBe("passthrough");
    expect(capped.evidence.fallback).toBe("selection-limit-exceeded");
    const passthrough = selectRoutedToolDefinitions(catalog, capped);
    expect(passthrough).toEqual([email.definition, calendar.definition]);
    expect(passthrough[0]).toBe(email.definition);
    expect(passthrough[1]).toBe(calendar.definition);
  });
});
