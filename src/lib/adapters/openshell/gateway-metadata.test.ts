// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGatewayMetadata } from "./gateway-metadata";

function writeGateway(home: string, name: string, metadata: Record<string, unknown>): string {
  const dir = path.join(home, ".config", "openshell", "gateways", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata));
  fs.writeFileSync(path.join(home, ".config", "openshell", "active_gateway"), name);
  return dir;
}

describe("resolveGatewayMetadata", () => {
  it("resolves the active plaintext local gateway into SDK ConnectOptions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-gw-"));
    try {
      writeGateway(home, "nemoclaw", {
        name: "nemoclaw",
        gateway_endpoint: "http://127.0.0.1:8080",
        auth_mode: "plaintext",
      });

      const gateway = resolveGatewayMetadata({ env: { HOME: home } as NodeJS.ProcessEnv });

      expect(gateway.name).toBe("nemoclaw");
      expect(gateway.target).toBe("127.0.0.1:8080");
      expect(gateway.authMode).toBe("plaintext");
      expect(gateway.sdkCompatible).toBe(true);
      expect(gateway.connectOptions).toMatchObject({
        gateway: "http://127.0.0.1:8080/",
      });
      expect(gateway.connectOptions).not.toHaveProperty("edgeToken");
      expect(gateway.connectOptions).not.toHaveProperty("oidcToken");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("loads Cloudflare edge_token for SDK edge auth", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-gw-"));
    try {
      const dir = writeGateway(home, "edge", {
        name: "edge",
        gateway_endpoint: "https://gateway.example.test",
        auth_mode: "cloudflare_jwt",
        is_remote: true,
      });
      fs.writeFileSync(path.join(dir, "edge_token"), "edge-token\n", { mode: 0o600 });

      const gateway = resolveGatewayMetadata({ env: { HOME: home } as NodeJS.ProcessEnv });

      expect(gateway.authMode).toBe("cloudflare_jwt");
      expect(gateway.sdkCompatible).toBe(true);
      expect(gateway.connectOptions).toMatchObject({
        gateway: "https://gateway.example.test/",
        edgeToken: "edge-token",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("loads oidc_token.json access_token for SDK OIDC auth", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-gw-"));
    try {
      const dir = writeGateway(home, "oidc", {
        name: "oidc",
        gateway_endpoint: "https://gateway.example.test",
        auth_mode: "oidc",
        oidc_issuer: "https://issuer.example.test",
        oidc_client_id: "openshell",
      });
      fs.writeFileSync(
        path.join(dir, "oidc_token.json"),
        JSON.stringify({
          access_token: "oidc-token",
          refresh_token: "refresh",
          issuer: "https://issuer.example.test",
          client_id: "openshell",
        }),
        { mode: 0o600 },
      );

      const gateway = resolveGatewayMetadata({ env: { HOME: home } as NodeJS.ProcessEnv });

      expect(gateway.authMode).toBe("oidc");
      expect(gateway.sdkCompatible).toBe(true);
      expect(gateway.connectOptions).toMatchObject({
        gateway: "https://gateway.example.test/",
        oidcToken: "oidc-token",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("passes CA and insecure settings through when the SDK supports the auth mode", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-gw-"));
    try {
      const dir = writeGateway(home, "oidc", {
        name: "oidc",
        gateway_endpoint: "https://127.0.0.1:17670",
        auth_mode: "oidc",
      });
      fs.writeFileSync(path.join(dir, "oidc_token.json"), JSON.stringify({ access_token: "tok" }));
      fs.mkdirSync(path.join(dir, "mtls"), { recursive: true });
      fs.writeFileSync(path.join(dir, "mtls", "ca.crt"), "CA PEM");

      const gateway = resolveGatewayMetadata({
        env: { HOME: home, OPENSHELL_GATEWAY_INSECURE: "1" } as NodeJS.ProcessEnv,
      });

      expect(gateway.connectOptions.caCert?.toString("utf-8")).toBe("CA PEM");
      expect(gateway.connectOptions.insecureSkipVerify).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("marks mTLS gateways as an upstream SDK prerequisite", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-gw-"));
    try {
      writeGateway(home, "secure", {
        name: "secure",
        gateway_endpoint: "https://127.0.0.1:17670",
        auth_mode: "mtls",
      });

      const gateway = resolveGatewayMetadata({ env: { HOME: home } as NodeJS.ProcessEnv });

      expect(gateway.authMode).toBe("mtls");
      expect(gateway.sdkCompatible).toBe(false);
      expect(gateway.connectOptions.gateway).toBe("https://127.0.0.1:17670/");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects missing active gateway metadata", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-gw-"));
    try {
      expect(() =>
        resolveGatewayMetadata({ env: { HOME: home } as NodeJS.ProcessEnv }),
      ).toThrow(/No active OpenShell gateway/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
