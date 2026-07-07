// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import type {
  DecompositionRequest,
  TaskDecomposer,
  TextEmbedder,
} from "../../scripts/performance/tool-disclosure/compositional-tool-router";
import { CompositionalToolRoutingTransform } from "../../scripts/performance/tool-disclosure/compositional-tool-routing-transform";
import { createToolDisclosureRecordingProxy } from "../../scripts/performance/tool-disclosure/recorder";

function vectorFor(text: string): number[] {
  const normalized = text.toLowerCase();
  return normalized.includes("calendar")
    ? [1, 0, 0]
    : normalized.includes("email")
      ? [0, 1, 0]
      : [0, 0, 1];
}

const embedder: TextEmbedder = {
  embed: async (texts) => texts.map(vectorFor),
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

function tools(): unknown[] {
  return [
    {
      type: "function",
      function: { name: "core_shell", description: "Run a shell command.", parameters: {} },
    },
    {
      type: "function",
      function: {
        name: "route_calendar_list",
        description: "List calendar events.",
        parameters: {},
      },
    },
    {
      type: "function",
      function: {
        name: "route_storage_delete",
        description: "Delete an object from storage.",
        parameters: {},
      },
    },
    {
      type: "function",
      function: {
        name: "route_email_send",
        description: "Send an email message.",
        parameters: {},
      },
    },
  ];
}

function requestBody(prompt = "List today's calendar events and send them by email."): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: "private-model",
      messages: [{ role: "user", content: prompt }],
      tools: tools(),
    }),
    "utf8",
  );
}

function input(body: Buffer, modelCallSequence = 1) {
  return {
    runId: "route-test-run",
    endpoint: "chat-completions" as const,
    method: "POST" as const,
    modelCallSequence,
    body,
    signal: new AbortController().signal,
  };
}

function names(body: Buffer): string[] {
  const payload = JSON.parse(body.toString("utf8")) as { tools: unknown[] };
  return payload.tools.map((tool) => {
    const value = tool as { function: { name: string } };
    return value.function.name;
  });
}

describe("independent compositional tool request transform", () => {
  it("filters the schemas measured and forwarded by the recording proxy", async () => {
    let upstreamBody = "";
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        upstreamBody = Buffer.concat(chunks).toString("utf8");
        response.end("{}");
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const address = upstream.address() as AddressInfo;
    const transform = new CompositionalToolRoutingTransform({
      decomposer: {
        decompose: async () => ["list calendar events", "send an email message"],
      },
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
    });
    const proxy = createToolDisclosureRecordingProxy({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      requestTransform: transform.requestTransform,
    });
    const proxyAddress = await proxy.start();
    cleanup.push(() => proxy.stop());

    proxy.beginRun("proxy-route-run");
    const response = await fetch(`${proxyAddress.base_url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody(),
    });
    await response.arrayBuffer();
    const [event] = proxy.endRun();

    expect(response.status).toBe(200);
    expect(names(Buffer.from(upstreamBody))).toEqual([
      "core_shell",
      "route_calendar_list",
      "route_email_send",
    ]);
    expect(event).toMatchObject({
      visible_tool_count: 3,
      tool_names: ["core_shell", "route_calendar_list", "route_email_send"],
    });
    expect(await transform.consumeEvidence("proxy-route-run")).toHaveLength(1);
  });

  it("runs two decomposition passes, filters only routable tools, and caches the route", async () => {
    const requests: DecompositionRequest[] = [];
    const decomposer: TaskDecomposer = {
      decompose: async (request) => {
        requests.push(request);
        return ["list calendar events", "send an email message"];
      },
    };
    const transform = new CompositionalToolRoutingTransform({
      decomposer,
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
    });

    const body = requestBody();
    const first = await transform.requestTransform(input(body));
    const second = await transform.requestTransform(input(body, 2));

    expect(names(first)).toEqual(["core_shell", "route_calendar_list", "route_email_send"]);
    expect(second.equals(first)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.pass)).toEqual(["initial", "refined"]);
    expect(requests[1].tool_hints).toContain("route_calendar_list");
    expect(requests[1].tool_hints).toContain("route_email_send");

    const [evidence] = await transform.consumeEvidence("route-test-run");
    expect(evidence).toMatchObject({
      source_tool_count: 4,
      routable_tool_count: 3,
      preserved_tool_count: 1,
      forwarded_tool_count: 3,
      cache_hits: 1,
      index_cache_hit: false,
      transform_bypass: null,
      routing: {
        initial_subtask_count: 2,
        refined_subtask_count: 2,
        decomposition_passes: 2,
        selected_tool_count: 2,
        selected_tool_names: ["route_calendar_list", "route_email_send"],
        fallback: null,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("today's calendar");
    expect(await transform.consumeEvidence("route-test-run")).toEqual([]);
  });

  it("keeps the full request byte-for-byte when routing falls back", async () => {
    const transform = new CompositionalToolRoutingTransform({
      decomposer: { decompose: async () => ({ malformed: true }) },
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
    });
    const body = requestBody("private fallback prompt");

    const forwarded = await transform.requestTransform(input(body));

    expect(forwarded.equals(body)).toBe(true);
    const [evidence] = await transform.consumeEvidence("route-test-run");
    expect(evidence).toMatchObject({
      forwarded_tool_count: 4,
      routing: {
        decomposition_passes: 1,
        fallback: "initial-decomposition-malformed",
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("private fallback prompt");
  });

  it("rejects a routing fallback in strict mode while retaining its evidence", async () => {
    const transform = new CompositionalToolRoutingTransform({
      decomposer: { decompose: async () => ({ malformed: true }) },
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
      requireRouting: true,
    });

    await expect(transform.requestTransform(input(requestBody()))).rejects.toThrow(
      "required compositional routing bypassed: routing fallback: initial-decomposition-malformed",
    );
    expect(await transform.consumeEvidence("route-test-run")).toMatchObject([
      { routing: { fallback: "initial-decomposition-malformed" } },
    ]);
  });

  it("treats an empty decomposition as an intentional no-tool route", async () => {
    let embeddingCalls = 0;
    const transform = new CompositionalToolRoutingTransform({
      decomposer: { decompose: async () => [] },
      embedder: {
        embed: async () => {
          embeddingCalls += 1;
          return [];
        },
      },
      isRoutableTool: (name) => name.startsWith("route_"),
    });

    const forwarded = await transform.requestTransform(
      input(requestBody("Reply with the literal phrase CONTROL and use no tools.")),
    );

    expect(names(forwarded)).toEqual(["core_shell"]);
    expect(embeddingCalls).toBe(1);
    expect(await transform.consumeEvidence("route-test-run")).toMatchObject([
      {
        forwarded_tool_count: 1,
        routing: {
          initial_subtask_count: 0,
          refined_subtask_count: 0,
          decomposition_passes: 1,
          selected_tool_count: 0,
          fallback: null,
        },
      },
    ]);
  });

  it("leaves unsupported endpoints untouched and does not retain evidence", async () => {
    const transform = new CompositionalToolRoutingTransform({
      decomposer: { decompose: async () => ["unused"] },
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
    });
    const body = requestBody();
    const forwarded = await transform.requestTransform({
      ...input(body),
      endpoint: "responses",
    });

    expect(forwarded.equals(body)).toBe(true);
    expect(await transform.consumeEvidence("route-test-run")).toEqual([]);
  });

  it("reuses the prepared catalog index across run IDs", async () => {
    const embeddingBatchSizes: number[] = [];
    const transform = new CompositionalToolRoutingTransform({
      decomposer: {
        decompose: async () => ["list calendar events", "send an email message"],
      },
      embedder: {
        embed: async (texts) => {
          embeddingBatchSizes.push(texts.length);
          return texts.map(vectorFor);
        },
      },
      isRoutableTool: (name) => name.startsWith("route_"),
    });
    const body = requestBody();

    await transform.requestTransform(input(body));
    await transform.requestTransform({ ...input(body), runId: "route-test-run-2" });

    const [first] = await transform.consumeEvidence("route-test-run");
    const [second] = await transform.consumeEvidence("route-test-run-2");
    expect(first.index_cache_hit).toBe(false);
    expect(second.index_cache_hit).toBe(true);
    expect(embeddingBatchSizes).toEqual([3, 2, 2, 2, 2]);
  });

  it("lets one request abort without cancelling shared route or index work", async () => {
    let releaseInitial: ((subtasks: string[]) => void) | undefined;
    let markInitialStarted: (() => void) | undefined;
    const initialStarted = new Promise<void>((resolve) => {
      markInitialStarted = resolve;
    });
    const decompositionSignals: Array<AbortSignal | undefined> = [];
    const embeddingSignals: Array<AbortSignal | undefined> = [];
    const transform = new CompositionalToolRoutingTransform({
      decomposer: {
        decompose: async (request) => {
          decompositionSignals.push(request.signal);
          return request.pass === "refined"
            ? ["list calendar events"]
            : (markInitialStarted?.(),
              new Promise<string[]>((resolve) => {
                releaseInitial = resolve;
              }));
        },
      },
      embedder: {
        embed: async (texts, signal) => {
          embeddingSignals.push(signal);
          return texts.map(vectorFor);
        },
      },
      isRoutableTool: (name) => name.startsWith("route_"),
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const body = requestBody("List today's calendar events.");
    const first = transform.requestTransform({
      ...input(body),
      signal: firstController.signal,
    });
    await initialStarted;
    const second = transform.requestTransform({
      ...input(body, 2),
      signal: secondController.signal,
    });
    const firstRejection = expect(first).rejects.toMatchObject({ name: "AbortError" });

    firstController.abort();
    await firstRejection;
    releaseInitial?.(["list calendar events"]);

    expect(names(await second)).toEqual(["core_shell", "route_calendar_list"]);
    expect(decompositionSignals).toEqual([undefined, undefined]);
    expect(embeddingSignals.every((signal) => signal === undefined)).toBe(true);
    expect(await transform.consumeEvidence("route-test-run")).toMatchObject([
      { cache_hits: 1, routing: { fallback: null } },
    ]);
  });

  it("preserves a request whose named tool choice conflicts with the route", async () => {
    const transform = new CompositionalToolRoutingTransform({
      decomposer: { decompose: async () => ["list calendar events"] },
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
    });
    const payload = JSON.parse(requestBody().toString("utf8")) as Record<string, unknown>;
    payload.tool_choice = {
      type: "function",
      function: { name: "route_storage_delete" },
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");

    const forwarded = await transform.requestTransform(input(body));

    expect(forwarded.equals(body)).toBe(true);
    const [evidence] = await transform.consumeEvidence("route-test-run");
    expect(evidence).toMatchObject({
      forwarded_tool_count: 4,
      transform_bypass: "tool-choice-conflict",
    });
  });

  it("rejects a named tool-choice conflict in strict mode", async () => {
    const transform = new CompositionalToolRoutingTransform({
      decomposer: { decompose: async () => ["list calendar events"] },
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
      requireRouting: true,
    });
    const payload = JSON.parse(requestBody().toString("utf8")) as Record<string, unknown>;
    payload.tool_choice = {
      type: "function",
      function: { name: "route_storage_delete" },
    };

    await expect(
      transform.requestTransform(input(Buffer.from(JSON.stringify(payload), "utf8"))),
    ).rejects.toThrow(
      "required compositional routing bypassed: named tool choice conflicts with routed catalog",
    );
    expect(await transform.consumeEvidence("route-test-run")).toMatchObject([
      { transform_bypass: "tool-choice-conflict", forwarded_tool_count: 4 },
    ]);
  });

  it("preserves a required-tool request when routing would expose no tools", async () => {
    const transform = new CompositionalToolRoutingTransform({
      decomposer: { decompose: async () => [] },
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
    });
    const payload = JSON.parse(requestBody().toString("utf8")) as { tools: unknown[] } & Record<
      string,
      unknown
    >;
    payload.tools = payload.tools.slice(1);
    payload.tool_choice = "required";
    const body = Buffer.from(JSON.stringify(payload), "utf8");

    expect((await transform.requestTransform(input(body))).equals(body)).toBe(true);
    expect(await transform.consumeEvidence("route-test-run")).toMatchObject([
      { transform_bypass: "tool-choice-conflict", forwarded_tool_count: 3 },
    ]);
  });

  it("rejects an empty required-tool route in strict mode", async () => {
    const transform = new CompositionalToolRoutingTransform({
      decomposer: { decompose: async () => [] },
      embedder,
      isRoutableTool: (name) => name.startsWith("route_"),
      requireRouting: true,
    });
    const payload = JSON.parse(requestBody().toString("utf8")) as { tools: unknown[] } & Record<
      string,
      unknown
    >;
    payload.tools = payload.tools.slice(1);
    payload.tool_choice = "required";

    await expect(
      transform.requestTransform(input(Buffer.from(JSON.stringify(payload), "utf8"))),
    ).rejects.toThrow(
      "required compositional routing bypassed: required tool choice has no routed tools",
    );
  });
});
