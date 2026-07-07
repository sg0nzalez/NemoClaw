// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createToolDisclosureRecordingProxy,
  type ToolDisclosureRecordingProxy,
} from "../../scripts/performance/tool-disclosure/recorder";

interface TestUpstream {
  baseUrl: string;
  close: () => Promise<void>;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestUpstream> {
  const sockets = new Set<Socket>();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  expect(address).not.toBeNull();
  expect(typeof address).not.toBe("string");
  const tcpAddress = address as AddressInfo;

  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(close);
  return { baseUrl: `http://127.0.0.1:${tcpAddress.port}`, close };
}

async function startProxy(
  upstreamBaseUrl: string,
  options: {
    maxRequestBodyBytes?: number;
    requestTimeoutMs?: number;
    requiredTemperature?: number;
  } = {},
): Promise<{ proxy: ToolDisclosureRecordingProxy; baseUrl: string }> {
  const proxy = createToolDisclosureRecordingProxy({ upstreamBaseUrl, ...options });
  const address = await proxy.start();
  cleanup.push(() => proxy.stop());
  expect(address.host).toBe("127.0.0.1");
  expect(address.base_url).toBe(`http://127.0.0.1:${address.port}`);
  return { proxy, baseUrl: address.base_url };
}

function collectBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

describe("tool-disclosure recording proxy", () => {
  it("fails closed for non-loopback listeners and credential-bearing upstream URLs", () => {
    expect(() =>
      createToolDisclosureRecordingProxy({
        upstreamBaseUrl: "https://localhost:8000/v1",
        listenHost: "0.0.0.0",
      }),
    ).toThrow("must be exactly 127.0.0.1");
    expect(() =>
      createToolDisclosureRecordingProxy({
        upstreamBaseUrl: "https://user:password@localhost:8000/v1",
      }),
    ).toThrow("must not contain credentials");
    expect(() =>
      createToolDisclosureRecordingProxy({
        upstreamBaseUrl: "https://localhost:8000/v1?api_key=private-key",
      }),
    ).toThrow("must not contain a query or fragment");
    expect(() =>
      createToolDisclosureRecordingProxy({
        upstreamBaseUrl: "http://inference.example/v1",
      }),
    ).toThrow("upstreamBaseUrl is allowed only on loopback");
  });

  it("rejects non-loopback HTTPS recorder upstreams for the local performance test", () => {
    expect(() =>
      createToolDisclosureRecordingProxy({
        upstreamBaseUrl: "https://inference.example/v1",
      }),
    ).toThrow("upstreamBaseUrl is allowed only on loopback");
    for (const upstreamBaseUrl of [
      "http://localhost:8000/v1",
      "https://127.0.0.1:8000/v1",
      "https://[::1]:8000/v1",
    ]) {
      expect(() => createToolDisclosureRecordingProxy({ upstreamBaseUrl })).not.toThrow();
    }
  });

  it("canonicalizes the IPv6 loopback and rejects mapped or non-loopback variants", () => {
    expect(() =>
      createToolDisclosureRecordingProxy({
        upstreamBaseUrl: "http://[0:0:0:0:0:0:0:1]:8000/v1",
      }),
    ).not.toThrow();
    expect(() =>
      createToolDisclosureRecordingProxy({
        upstreamBaseUrl: "http://[::ffff:127.0.0.1]:8000/v1",
      }),
    ).toThrow("upstreamBaseUrl is allowed only on loopback");
    expect(() =>
      createToolDisclosureRecordingProxy({
        upstreamBaseUrl: "http://[::2]:8000/v1",
      }),
    ).toThrow("upstreamBaseUrl is allowed only on loopback");
  });

  it("normalizes localhost to literal IPv4 before connecting upstream", async () => {
    let observedHost = "";
    let observedPath = "";
    const upstream = await startUpstream((request, response) => {
      observedHost = request.headers.host ?? "";
      observedPath = request.url ?? "";
      response.end("{}");
    });
    const upstreamUrl = new URL(upstream.baseUrl);
    upstreamUrl.hostname = "localhost";
    upstreamUrl.pathname = "/proxy/v1";
    const { proxy, baseUrl } = await startProxy(upstreamUrl.toString());

    proxy.beginRun("localhost-normalization");
    const response = await fetch(`${baseUrl}/v1/models`);
    await response.arrayBuffer();
    proxy.endRun();

    expect(response.status).toBe(200);
    expect(observedHost).toBe(`127.0.0.1:${upstreamUrl.port}`);
    expect(observedPath).toBe("/proxy/v1/models");
  });

  it("accepts bounded public scheduled run IDs and rejects unsafe IDs", () => {
    const proxy = createToolDisclosureRecordingProxy({
      upstreamBaseUrl: "https://localhost:8000/v1",
    });
    const scheduledId = "c1--primary--openclaw--progressive--n512--single-01--r1";
    expect(proxy.beginRun(scheduledId)).toBe(scheduledId);
    expect(proxy.endRun()).toEqual([]);

    expect(() => proxy.beginRun("run id with prompt content")).toThrow("public-safe");
    expect(() => proxy.beginRun(`r${"x".repeat(256)}`)).toThrow("1-256");
  });

  it("forwards requests while retaining only canonical tool metadata", async () => {
    const received: Array<{ url: string; authorization: string; body: string }> = [];
    const upstream = await startUpstream((request, response) => {
      void collectBody(request).then((body) => {
        received.push({
          url: request.url ?? "",
          authorization: String(request.headers.authorization ?? ""),
          body,
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "x-private-upstream-header": "header-secret",
        });
        response.end('{"choices":[{"message":{"content":"response-secret"}}]}');
      });
    });
    const { proxy, baseUrl } = await startProxy(`${upstream.baseUrl}/v1`);
    const tool = {
      type: "function",
      function: {
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
        name: "weather_lookup",
        description: "schema-secret",
      },
    };
    const requestBody = JSON.stringify({
      model: "model-secret",
      messages: [{ role: "user", content: "prompt-secret" }],
      tools: [tool],
      stream: false,
    });

    const runId = proxy.beginRun();
    const firstResponse = await fetch(`${baseUrl}/v1/chat/completions?api_key=query-secret`, {
      method: "POST",
      headers: {
        authorization: "Bearer authorization-secret",
        "content-type": "application/json",
      },
      body: requestBody,
    });
    expect(await firstResponse.text()).toContain("response-secret");

    const reorderedTool = {
      function: {
        description: "schema-secret",
        name: "weather_lookup",
        parameters: {
          properties: { city: { type: "string" } },
          type: "object",
        },
      },
      type: "function",
    };
    const secondResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [], tools: [reorderedTool] }),
    });
    await secondResponse.arrayBuffer();

    const events = proxy.endRun();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      run_id: runId,
      request_sequence: 1,
      model_call_sequence: 1,
      endpoint: "chat-completions",
      method: "POST",
      visible_tool_count: 1,
      tool_names: ["weather_lookup"],
      status_code: 200,
      outcome: "completed",
      error_reason: null,
    });
    expect(events[1].model_call_sequence).toBe(2);
    expect(events[1].tools_sha256).toBe(events[0].tools_sha256);

    const canonical = JSON.stringify([
      {
        function: {
          description: "schema-secret",
          name: "weather_lookup",
          parameters: {
            properties: { city: { type: "string" } },
            type: "object",
          },
        },
        type: "function",
      },
    ]);
    expect(events[0].canonical_tools_json_bytes).toBe(Buffer.byteLength(canonical));
    expect(events[0].tools_sha256).toBe(createHash("sha256").update(canonical).digest("hex"));

    expect(received[0]).toEqual({
      url: "/v1/chat/completions?api_key=query-secret",
      authorization: "Bearer authorization-secret",
      body: requestBody,
    });
    const serializedEvents = JSON.stringify(events);
    for (const secret of [
      "prompt-secret",
      "model-secret",
      "schema-secret",
      "authorization-secret",
      "query-secret",
      "response-secret",
      "header-secret",
    ]) {
      expect(serializedEvents).not.toContain(secret);
    }

    const snapshots = proxy.consumeToolSchemaSnapshots(runId);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual({
      run_id: runId,
      model_call_sequence: 1,
      canonical_tools_json: canonical,
    });
    expect(proxy.consumeToolSchemaSnapshots(runId)).toEqual([]);

    proxy.resetEvents();
    expect(proxy.getEvents()).toEqual([]);
  });

  it("streams SSE bytes unchanged and records monotonic first-byte timing", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(chunks[0]);
      setTimeout(() => {
        response.write(chunks[1]);
        response.end(chunks[2]);
      }, 15);
    });
    const { proxy, baseUrl } = await startProxy(upstream.baseUrl);

    proxy.beginRun();
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "private-model",
        input: "private-input",
        stream: true,
        tools: [{ type: "function", name: "calculator", parameters: {} }],
      }),
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(chunks.join(""));

    const [event] = proxy.endRun();
    expect(event).toMatchObject({
      endpoint: "responses",
      visible_tool_count: 1,
      tool_names: ["calculator"],
      status_code: 200,
      outcome: "completed",
    });
    expect(event.first_byte_monotonic_ms).not.toBeNull();
    expect(event.started_monotonic_ms).toBeLessThanOrEqual(event.first_byte_monotonic_ms ?? 0);
    expect(event.first_byte_monotonic_ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      event.ended_monotonic_ms,
    );
    expect(event.duration_ms).toBeGreaterThanOrEqual(event.time_to_first_byte_ms ?? 0);
  });

  it("forces a missing frozen temperature and rejects a conflicting value", async () => {
    const received: string[] = [];
    const upstream = await startUpstream((request, response) => {
      void collectBody(request).then((body) => {
        received.push(body);
        response.end("{}");
      });
    });
    const { proxy, baseUrl } = await startProxy(upstream.baseUrl, { requiredTemperature: 0 });
    proxy.beginRun("temperature-missing");
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [], tools: [] }),
    });
    proxy.endRun();
    expect(JSON.parse(received[0])).toMatchObject({ temperature: 0 });

    proxy.beginRun("temperature-conflict");
    const rejected = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [], tools: [], temperature: 0.5 }),
    });
    expect(rejected.status).toBe(400);
    proxy.endRun();
    expect(received).toHaveLength(1);
  });

  it("rejects upstream redirects without relaying Location or body secrets", async () => {
    let hits = 0;
    const upstream = await startUpstream((_request, response) => {
      hits += 1;
      response.writeHead(307, {
        location: "https://example.invalid/v1?token=location-secret",
        "content-type": "text/plain",
      });
      response.end("redirect-response-secret");
    });
    const { proxy, baseUrl } = await startProxy(upstream.baseUrl);

    proxy.beginRun();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"messages":[{"content":"request-secret"}]}',
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ error: "upstream redirect rejected" });
    expect(hits).toBe(1);

    const [event] = proxy.endRun();
    expect(event).toMatchObject({
      status_code: 502,
      first_byte_monotonic_ms: null,
      outcome: "request-rejected",
      error_reason: "proxy-failure",
    });
    expect(JSON.stringify(event)).not.toMatch(
      /location-secret|redirect-response-secret|request-secret/,
    );
  });

  it("rejects oversized bodies without contacting the upstream", async () => {
    let hits = 0;
    const upstream = await startUpstream((_request, response) => {
      hits += 1;
      response.end("unexpected");
    });
    const { proxy, baseUrl } = await startProxy(upstream.baseUrl, {
      maxRequestBodyBytes: 32,
    });

    proxy.beginRun();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ content: "x".repeat(100) }] }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
    expect(hits).toBe(0);

    const [event] = proxy.endRun();
    expect(event).toMatchObject({
      status_code: 413,
      outcome: "request-rejected",
      error_reason: "request-body-too-large",
      visible_tool_count: 0,
    });
  });

  it("bounds stalled upstream calls and exposes only a redacted error class", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await collectBody(request);
      setTimeout(() => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("upstream-error-body-secret");
      }, 200);
    });
    const { proxy, baseUrl } = await startProxy(upstream.baseUrl, {
      requestTimeoutMs: 30,
    });

    proxy.beginRun();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer timeout-authorization-secret",
        "content-type": "application/json",
      },
      body: '{"messages":[{"content":"timeout-prompt-secret"}]}',
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "upstream timeout" });

    const [event] = proxy.endRun();
    expect(event).toMatchObject({
      status_code: 504,
      outcome: "upstream-timeout",
      error_reason: "upstream-timeout",
    });
    expect(JSON.stringify(event)).not.toMatch(
      /timeout-authorization-secret|timeout-prompt-secret|upstream-error-body-secret/,
    );
  });

  it("bounds an SSE response that stalls after its first byte", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
    });
    const { proxy, baseUrl } = await startProxy(upstream.baseUrl, {
      requestTimeoutMs: 30,
    });

    proxy.beginRun("c1--primary--hermes--progressive--n512--single-01--r1");
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"stream":true}',
    });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toBeDefined();

    const [event] = proxy.endRun();
    expect(event).toMatchObject({
      status_code: 200,
      outcome: "upstream-timeout",
      error_reason: "upstream-timeout",
    });
    expect(event.first_byte_monotonic_ms).not.toBeNull();
  });

  it("does not forward or record paths outside the OpenAI v1 boundary", async () => {
    let hits = 0;
    const upstream = await startUpstream((_request, response) => {
      hits += 1;
      response.end("unexpected");
    });
    const { proxy, baseUrl } = await startProxy(upstream.baseUrl);

    proxy.beginRun();
    const response = await fetch(`${baseUrl}/health?token=health-secret`);
    expect(response.status).toBe(404);
    expect(hits).toBe(0);
    expect(proxy.endRun()).toEqual([]);
  });
});
