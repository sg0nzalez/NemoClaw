// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES } from "../../scripts/performance/tool-disclosure/compositional-tool-routing-acceptance";
import { runCompositionalRoutingAcceptance } from "../../scripts/performance/tool-disclosure/compositional-tool-routing-run";

afterEach(() => {
  delete process.env.ROUTING_TEST_API_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("compositional routing acceptance runner", () => {
  it("runs a shared-initial paired evaluation and emits public-safe evidence", async () => {
    const privateKey = "private-route-acceptance-key";
    process.env.ROUTING_TEST_API_KEY = privateKey;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const user =
        [...payload.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const fixture = COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES.find((candidate) =>
        user.includes(candidate.prompt),
      );
      expect(fixture).toBeDefined();
      const matchedFixture = fixture as NonNullable<typeof fixture>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  subtasks: matchedFixture.expected_steps.map((expected) => expected.capability),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const output = await runCompositionalRoutingAcceptance({
      decomposer: {
        base_url: "https://models.example.test/v1",
        model: "test-decomposer",
        revision: "immutable-test-revision",
        api_key_env: "ROUTING_TEST_API_KEY",
        allow_remote: true,
        reasoning_control: "enable_thinking_false",
        json_object_response: true,
      },
      embedding: { kind: "portable", dimensions: 1_024 },
    });

    expect(output).toMatchObject({
      schema_version: "nemoclaw.compositional_tool_routing_acceptance.v1",
      claim_eligible: false,
      configuration: {
        decomposer_model: "test-decomposer",
        decomposer_revision: "immutable-test-revision",
        decomposer_reasoning_control: "enable_thinking_false",
        decomposer_output_mode: "json-object",
        embedding_kind: "portable",
        embedding_model: "portable-lexical-hashing",
        embedding_revision: "builtin-v1",
        top_k: 10,
        hint_count: 12,
        temperature: 0,
      },
      corpus: { tool_count: 20, case_count: 8, expected_step_count: 18 },
      usage: {
        decomposition: {
          requests: 15,
          prompt_tokens: 150,
          completion_tokens: 30,
          total_tokens: 180,
        },
        embedding: { requests: 0 },
      },
      acceptance_passed: true,
    });
    expect(output.cases).toHaveLength(8);
    expect(output.cases.every((entry) => entry.shared_initial_decomposition)).toBe(true);
    const noTool = output.cases.find((entry) => entry.case_id === "route-no-tool-01");
    expect(noTool?.refined).toMatchObject({
      disposition: "routed",
      forwarded_tool_names: [],
      forwarded_tool_count: 0,
      evidence: { fallback: null },
    });
    const toolCase = output.cases.find((entry) => entry.case_id === "route-single-csv-01");
    expect(toolCase?.refined.forwarded_tool_names).toEqual(
      toolCase?.refined.evidence.selected_tool_names,
    );
    expect(output.comparison.refined_gate.passed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(15);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("models.example.test");
    for (const fixture of COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES) {
      expect(serialized).not.toContain(fixture.prompt);
    }
  });

  it("fails acceptance and records full-catalog forwarding when no-tool routing fails open", async () => {
    process.env.ROUTING_TEST_API_KEY = "private-route-acceptance-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const user =
          [...payload.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const fixture = COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES.find((candidate) =>
          user.includes(candidate.prompt),
        );
        expect(fixture).toBeDefined();
        const matchedFixture = fixture as NonNullable<typeof fixture>;
        const content =
          matchedFixture.id === "route-no-tool-01"
            ? "not-json"
            : JSON.stringify({
                subtasks: matchedFixture.expected_steps.map((expected) => expected.capability),
              });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const output = await runCompositionalRoutingAcceptance({
      decomposer: {
        base_url: "https://models.example.test/v1",
        model: "test-decomposer",
        revision: "immutable-test-revision",
        api_key_env: "ROUTING_TEST_API_KEY",
        allow_remote: true,
      },
      embedding: { kind: "portable" },
    });

    expect(output.acceptance_passed).toBe(false);
    expect(output.comparison.refined.route_failure_case_count).toBe(1);
    expect(output.comparison.refined_gate.reasons).toContain(
      "route_failure_case_count 1 must be zero",
    );
    const noTool = output.cases.find((entry) => entry.case_id === "route-no-tool-01");
    expect(noTool?.refined).toMatchObject({
      disposition: "passthrough",
      forwarded_tool_count: 20,
      evidence: { fallback: "initial-decomposition-failed" },
    });
    expect(noTool?.refined.forwarded_tool_names).toHaveLength(20);
  });
});
