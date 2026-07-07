// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenAIChatTaskDecomposer,
  createOpenAITextEmbedder,
  type ModelUsageEvent,
  PortableHashingTextEmbedder,
} from "../../scripts/performance/tool-disclosure/compositional-tool-routing-adapters";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("independent compositional tool model adapters", () => {
  it("requests both decomposition passes without copying request text into usage evidence", async () => {
    const responses = [["collect the records"], ["fetch records", "send a notification"]];
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const content = JSON.stringify({ subtasks: responses[calls.length - 1] });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `\`\`\`json\n${content}\n\`\`\`` } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const usage: ModelUsageEvent[] = [];
    const decomposer = createOpenAIChatTaskDecomposer({
      baseUrl: "https://models.example.test/v1",
      model: "test-model",
      allowRemote: true,
      apiKey: "private-api-key",
      reasoningControl: "enable_thinking_false",
      jsonObjectResponse: true,
      onUsage: (event) => usage.push(event),
    });

    await expect(
      decomposer.decompose({
        pass: "initial",
        query: "private request text",
        tool_hints: [],
      }),
    ).resolves.toEqual(responses[0]);
    await expect(
      decomposer.decompose({
        pass: "refined",
        query: "private request text",
        tool_hints: ["route_fetch", "route_notify"],
      }),
    ).resolves.toEqual(responses[1]);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://models.example.test/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe("Bearer private-api-key");
    expect(calls[0].body).toMatchObject({
      model: "test-model",
      temperature: 0,
      max_tokens: 256,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(calls[1].body)).toContain("route_fetch");
    expect(usage).toHaveLength(2);
    expect(usage.map((event) => event.pass)).toEqual(["initial", "refined"]);
    expect(usage[0]).toMatchObject({
      operation: "decomposition",
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    });
    expect(JSON.stringify(usage)).not.toMatch(/private request|private-api-key|test-model/);
  });

  it("returns a fixed decomposition failure without relaying provider content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("provider-private-error", { status: 500 })),
    );
    const decomposer = createOpenAIChatTaskDecomposer({
      baseUrl: "https://models.example.test",
      model: "test-model",
      allowRemote: true,
    });

    await expect(
      decomposer.decompose({ pass: "initial", query: "request", tool_hints: [] }),
    ).rejects.toThrow("decomposition request failed");
  });

  it("batches embeddings and restores provider results to input order", async () => {
    const observedInputs: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { input: string[] };
        observedInputs.push(payload.input);
        const data = payload.input
          .map((text, index) => ({ index, embedding: [text.length, index + 1] }))
          .reverse();
        return new Response(JSON.stringify({ data, usage: { total_tokens: 3 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const usage: ModelUsageEvent[] = [];
    const embedder = createOpenAITextEmbedder({
      baseUrl: "https://models.example.test/v1",
      model: "test-embedding-model",
      allowRemote: true,
      batchSize: 2,
      onUsage: (event) => usage.push(event),
    });

    await expect(embedder.embed(["a", "bb", "ccc"])).resolves.toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
    ]);
    expect(observedInputs).toEqual([["a", "bb"], ["ccc"]]);
    expect(usage).toHaveLength(2);
    expect(usage.every((event) => event.operation === "embedding")).toBe(true);
  });

  it("provides a deterministic dependency-free lexical adapter for smoke tests", async () => {
    const embedder = new PortableHashingTextEmbedder(512);
    const [first, second, different] = await embedder.embed([
      "send an email notification",
      "email notification send",
      "decompress a gzip archive",
    ]);
    const dot = (left: readonly number[], right: readonly number[]) =>
      left.reduce((sum, value, index) => sum + value * right[index], 0);

    expect(first).toEqual(await embedder.embed(["send an email notification"]).then(([v]) => v));
    expect(dot(first, second)).toBeGreaterThan(dot(first, different));
  });

  it("requires HTTPS and explicit opt-in before sending content off-host", () => {
    expect(() =>
      createOpenAIChatTaskDecomposer({
        baseUrl: "https://models.example.test/v1",
        model: "test-model",
      }),
    ).toThrow("require allowRemote");
    expect(() =>
      createOpenAITextEmbedder({
        baseUrl: "http://models.example.test/v1",
        model: "test-model",
        allowRemote: true,
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      createOpenAIChatTaskDecomposer({
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "test-model",
        reasoningControl: "invalid" as "thinking_false",
      }),
    ).toThrow("reasoningControl is not supported");
  });
});
