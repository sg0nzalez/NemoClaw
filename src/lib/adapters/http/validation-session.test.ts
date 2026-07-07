// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createValidationSession, getValidationSessionIneligibility } from "./validation-session";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  expect(address).toBeTruthy();
  expect(typeof address).toBe("object");
  return (address as import("node:net").AddressInfo).port;
}

describe("provider validation session", () => {
  it("resolves once and reuses one TCP connection for sequential requests", async () => {
    let connections = 0;
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? "");
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const sockets: import("node:net").Socket[] = [];
    const session = await createValidationSession(`http://provider.example.test:${port}/v1`, {
      env: {},
      lookup,
      onSocket: (socket) => sockets.push(socket),
    });

    expect(session).not.toBeNull();
    const first = await session!.request({
      url: `http://provider.example.test:${port}/v1/responses`,
      body: "{}",
      timeoutMs: 1_000,
    });
    const second = await session!.request({
      url: `http://provider.example.test:${port}/v1/chat/completions`,
      body: "{}",
      timeoutMs: 1_000,
    });
    session!.close();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(connections).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].destroyed).toBe(true);
    expect(requests).toEqual(["/v1/responses", "/v1/chat/completions"]);
  });

  it("falls back when pre-resolution fails", async () => {
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" });
    });

    await expect(
      createValidationSession("https://provider.example.test/v1", { env: {}, lookup }),
    ).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("reconnects without another DNS lookup when the server closes keepalive", async () => {
    let connections = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      response.setHeader("connection", "close");
      response.end('{"ok":true}');
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const session = await createValidationSession(`http://provider.example.test:${port}/v1`, {
      env: {},
      lookup,
    });

    for (const path of ["responses", "chat/completions"]) {
      await expect(
        session!.request({
          url: `http://provider.example.test:${port}/v1/${path}`,
          body: "{}",
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ ok: true });
    }
    session!.close();

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(connections).toBe(2);
  });

  it("refuses to send a session request to another origin", async () => {
    const server = http.createServer((_request, response) => response.end('{"ok":true}'));
    const port = await listen(server);
    const session = await createValidationSession(`http://provider.example.test:${port}/v1`, {
      env: {},
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    await expect(
      session!.request({
        url: "http://different.example.test/v1/responses",
        body: "{}",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ ok: false, message: "validation session origin mismatch" });
    session!.close();
  });

  it("keeps proxy, curl-specific TLS, IP, local, and sandbox endpoints on curl", () => {
    expect(
      getValidationSessionIneligibility("https://provider.example.test/v1", {
        HTTPS_PROXY: "http://proxy.example.test:8080",
      }),
    ).toBe("proxy_configured");
    expect(
      getValidationSessionIneligibility("https://provider.example.test/v1", {
        CURL_CA_BUNDLE: "/tmp/corporate-ca.pem",
      }),
    ).toBe("curl_tls_configured");
    expect(getValidationSessionIneligibility("https://127.0.0.1/v1", {})).toBe("ip_literal");
    expect(getValidationSessionIneligibility("http://localhost:8000/v1", {})).toBe(
      "local_endpoint",
    );
    expect(getValidationSessionIneligibility("http://host.openshell.internal/v1", {})).toBe(
      "sandbox_internal_endpoint",
    );
    expect(getValidationSessionIneligibility("http://host.docker.internal/v1", {})).toBe(
      "docker_internal_endpoint",
    );
  });
});
