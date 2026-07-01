// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { setupHermesProviderInference } from "./hermes";

vi.mock("../../private-networks", () => ({
  isPrivateHostname: (hostname: string) => {
    const privateHosts = new Set(["localhost", "host.docker.internal"]);
    const privatePatterns = [
      /^127\./,
      /^10\./,
      /^192\.168\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^169\.254\./,
    ];
    if (privateHosts.has(hostname)) return true;
    if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return true;
    return privatePatterns.some((re) => re.test(hostname));
  },
}));

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    upsertProvider: vi.fn(),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: vi.fn(() => false),
    registry: { updateSandbox: vi.fn() },
    hermesProviderAuth: {
      isHermesProviderRegistered: vi.fn(() => true),
      ensureHermesProviderApiKeyCredentials: vi.fn(() => ({})),
      ensureHermesProviderOAuthCredentials: vi.fn(() => ({})),
    },
    getHermesToolGatewayBroker: vi.fn(() => ({
      getHermesToolGatewayProviderName: vi.fn(() => "hermes-tool-gateway"),
    })),
    providerExistsInGateway: vi.fn(() => true),
    normalizeHermesAuthMethod: vi.fn(() => "api-key"),
    resolveHermesNousApiKey: vi.fn(() => null),
    checkHermesProviderStoreReachable: vi.fn(() => ({ ok: true })),
    hermesAuthMethodLabel: vi.fn((m: string) => m),
    hermesConstants: {
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV: "NOUS_API_KEY",
      HERMES_AUTH_METHOD_API_KEY: "api-key",
      HERMES_AUTH_METHOD_OAUTH: "oauth",
    },
    requireValue: vi.fn((v: unknown, msg: string) => {
      if (!v) throw new Error(msg);
      return v;
    }),
    redact: vi.fn((s: string) => s),
    compactText: vi.fn((s: string) => s),
    ...overrides,
  };
}

describe("setupHermesProviderInference SSRF guard (#6072)", () => {
  it("rejects loopback address", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://127.0.0.1:8080/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects cloud metadata endpoint", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://169.254.169.254/latest/meta-data/",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects private RFC-1918 range", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://10.0.0.1/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects localhost hostname", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://localhost:11434/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects .internal TLD", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://my-service.internal/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("throws on malformed URL", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "not-a-url",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/Invalid inference endpoint URL/);
  });

  it("accepts a public HTTPS endpoint", async () => {
    const deps = makeDeps();
    await setupHermesProviderInference(
      {
        sandboxName: "alpha",
        model: "m",
        provider: "p",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: null,
        hermesAuthMethod: null,
        hermesToolGateways: [],
      },
      deps as never,
    );
    expect(deps.runOpenshell).toHaveBeenCalled();
  });

  it("skips SSRF check when endpointUrl is null", async () => {
    const deps = makeDeps();
    await setupHermesProviderInference(
      {
        sandboxName: "alpha",
        model: "m",
        provider: "p",
        endpointUrl: null,
        credentialEnv: null,
        hermesAuthMethod: null,
        hermesToolGateways: [],
      },
      deps as never,
    );
    expect(deps.runOpenshell).toHaveBeenCalled();
  });
});
