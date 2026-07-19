// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createGrpcOpenShellSandboxControlForGateway,
  resolveOpenShellGrpcGateway,
} from "./grpc-gateway-config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function fixture(): { root: string; xdg: string; system: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-grpc-gateway-"));
  roots.push(root);
  return { root, xdg: path.join(root, "xdg"), system: path.join(root, "system") };
}

function writeMetadata(
  configRoot: string,
  gatewayName: string,
  metadata: Record<string, unknown>,
): string {
  const target = path.join(configRoot, "gateways", gatewayName, "metadata.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ name: gatewayName, ...metadata }));
  return target;
}

function writeMtls(xdg: string, gatewayName: string): void {
  const target = path.join(xdg, "openshell", "gateways", gatewayName, "mtls");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "ca.crt"), "ca-pem");
  fs.writeFileSync(path.join(target, "tls.crt"), "cert-pem");
  fs.writeFileSync(path.join(target, "tls.key"), "key-pem");
}

describe("OpenShell gRPC gateway configuration", () => {
  it("resolves user metadata and per-user mTLS materials", () => {
    const dirs = fixture();
    writeMetadata(path.join(dirs.xdg, "openshell"), "nemoclaw", {
      gateway_endpoint: "https://127.0.0.1:8080",
      auth_mode: "mtls",
    });
    writeMtls(dirs.xdg, "nemoclaw");

    const resolved = resolveOpenShellGrpcGateway("nemoclaw", {
      xdgConfigHome: dirs.xdg,
      systemConfigRoot: dirs.system,
    });

    expect(resolved).toEqual({
      gatewayName: "nemoclaw",
      metadataSource: "user",
      authMode: "mtls",
      clientConfig: {
        endpoint: "https://127.0.0.1:8080",
        caCertificate: Buffer.from("ca-pem"),
        clientCertificate: Buffer.from("cert-pem"),
        clientKey: Buffer.from("key-pem"),
      },
    });
  });

  it("falls back to system metadata while keeping credentials in the user gateway directory", () => {
    const dirs = fixture();
    writeMetadata(dirs.system, "nemoclaw", {
      gateway_endpoint: "https://localhost:8080",
      auth_mode: "mtls",
    });
    writeMtls(dirs.xdg, "nemoclaw");

    const resolved = resolveOpenShellGrpcGateway("nemoclaw", {
      xdgConfigHome: dirs.xdg,
      systemConfigRoot: dirs.system,
    });

    expect(resolved.metadataSource).toBe("system");
    expect(resolved.clientConfig.clientKey?.toString()).toBe("key-pem");
  });

  it("lets a user metadata entry shadow system metadata even when malformed", () => {
    const dirs = fixture();
    const userPath = writeMetadata(path.join(dirs.xdg, "openshell"), "nemoclaw", {
      gateway_endpoint: "http://127.0.0.1:8080",
    });
    fs.writeFileSync(userPath, "not-json");
    writeMetadata(dirs.system, "nemoclaw", {
      gateway_endpoint: "http://127.0.0.1:9090",
      auth_mode: "plaintext",
    });

    expect(() =>
      resolveOpenShellGrpcGateway("nemoclaw", {
        xdgConfigHome: dirs.xdg,
        systemConfigRoot: dirs.system,
      }),
    ).toThrow(`Failed to parse OpenShell gateway metadata from ${userPath}`);
  });

  it("infers plaintext for legacy HTTP metadata and constructs a direct client", () => {
    const dirs = fixture();
    writeMetadata(path.join(dirs.xdg, "openshell"), "nemoclaw", {
      gateway_endpoint: "http://127.0.0.1:1",
    });
    const options = { xdgConfigHome: dirs.xdg, systemConfigRoot: dirs.system };

    expect(resolveOpenShellGrpcGateway("nemoclaw", options)).toMatchObject({
      authMode: "plaintext",
      clientConfig: { endpoint: "http://127.0.0.1:1" },
    });
    const control = createGrpcOpenShellSandboxControlForGateway("nemoclaw", options);
    control.close();
  });

  it("loads an unexpired OIDC token and optional private CA", () => {
    const dirs = fixture();
    writeMetadata(path.join(dirs.xdg, "openshell"), "cloud", {
      gateway_endpoint: "https://gateway.example:443",
      auth_mode: "oidc",
    });
    const gatewayDir = path.join(dirs.xdg, "openshell", "gateways", "cloud");
    fs.writeFileSync(
      path.join(gatewayDir, "oidc_token.json"),
      JSON.stringify({ access_token: "oidc-token", expires_at: 2000 }),
    );
    fs.mkdirSync(path.join(gatewayDir, "mtls"));
    fs.writeFileSync(path.join(gatewayDir, "mtls", "ca.crt"), "private-ca");

    const resolved = resolveOpenShellGrpcGateway("cloud", {
      xdgConfigHome: dirs.xdg,
      systemConfigRoot: dirs.system,
      nowSeconds: 1000,
    });

    expect(resolved.authMode).toBe("oidc");
    expect(resolved.clientConfig).toEqual({
      endpoint: "https://gateway.example:443",
      bearerToken: "oidc-token",
      caCertificate: Buffer.from("private-ca"),
    });
  });

  it("rejects OIDC tokens that need refresh", () => {
    const dirs = fixture();
    writeMetadata(path.join(dirs.xdg, "openshell"), "cloud", {
      gateway_endpoint: "https://gateway.example:443",
      auth_mode: "oidc",
    });
    fs.writeFileSync(
      path.join(dirs.xdg, "openshell", "gateways", "cloud", "oidc_token.json"),
      JSON.stringify({ access_token: "expired", expires_at: 1020 }),
    );

    expect(() =>
      resolveOpenShellGrpcGateway("cloud", {
        xdgConfigHome: dirs.xdg,
        systemConfigRoot: dirs.system,
        nowSeconds: 1000,
      }),
    ).toThrow("expired or near expiry");
  });

  it("fails closed for edge-tunneled and unknown auth modes", () => {
    const dirs = fixture();
    writeMetadata(path.join(dirs.xdg, "openshell"), "edge", {
      gateway_endpoint: "https://edge.example:443",
      auth_mode: "cloudflare_jwt",
    });
    writeMetadata(path.join(dirs.xdg, "openshell"), "unknown", {
      gateway_endpoint: "https://unknown.example:443",
      auth_mode: "future-auth",
    });
    const options = { xdgConfigHome: dirs.xdg, systemConfigRoot: dirs.system };

    expect(() => resolveOpenShellGrpcGateway("edge", options)).toThrow(
      "require the OpenShell edge tunnel",
    );
    expect(() => resolveOpenShellGrpcGateway("unknown", options)).toThrow(
      "Unsupported OpenShell gateway auth mode 'future-auth'",
    );
  });

  it.each([
    ["plaintext", "https://gateway.example:443", "plaintext gateway metadata"],
    ["mtls", "http://127.0.0.1:8080", "mTLS gateway metadata"],
    ["oidc", "http://127.0.0.1:8080", "OIDC gateway metadata"],
  ])("rejects %s metadata with an incompatible endpoint", (authMode, endpoint, message) => {
    const dirs = fixture();
    writeMetadata(path.join(dirs.xdg, "openshell"), "mismatch", {
      gateway_endpoint: endpoint,
      auth_mode: authMode,
    });

    expect(() =>
      resolveOpenShellGrpcGateway("mismatch", {
        xdgConfigHome: dirs.xdg,
        systemConfigRoot: dirs.system,
      }),
    ).toThrow(message);
  });

  it("rejects relative configuration roots and invalid clocks", () => {
    expect(() =>
      resolveOpenShellGrpcGateway("nemoclaw", { xdgConfigHome: "relative/config" }),
    ).toThrow("must be an absolute path");

    const dirs = fixture();
    writeMetadata(path.join(dirs.xdg, "openshell"), "nemoclaw", {
      gateway_endpoint: "http://127.0.0.1:8080",
      auth_mode: "plaintext",
    });
    expect(() =>
      resolveOpenShellGrpcGateway("nemoclaw", {
        xdgConfigHome: dirs.xdg,
        systemConfigRoot: dirs.system,
        nowSeconds: Number.NaN,
      }),
    ).toThrow("nowSeconds must be a non-negative safe integer");
  });

  it("rejects unsafe names and metadata name mismatches", () => {
    const dirs = fixture();
    const metadataPath = writeMetadata(path.join(dirs.xdg, "openshell"), "nemoclaw", {
      gateway_endpoint: "http://127.0.0.1:8080",
      auth_mode: "plaintext",
    });
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        name: "other",
        gateway_endpoint: "http://127.0.0.1:8080",
        auth_mode: "plaintext",
      }),
    );
    const options = { xdgConfigHome: dirs.xdg, systemConfigRoot: dirs.system };

    expect(() => resolveOpenShellGrpcGateway("../escape", options)).toThrow("one path component");
    expect(() => resolveOpenShellGrpcGateway("nemoclaw", options)).toThrow("name mismatch");
  });

  it("reports the exact missing mTLS material", () => {
    const dirs = fixture();
    writeMetadata(path.join(dirs.xdg, "openshell"), "nemoclaw", {
      gateway_endpoint: "https://127.0.0.1:8080",
      auth_mode: "mtls",
    });

    expect(() =>
      resolveOpenShellGrpcGateway("nemoclaw", {
        xdgConfigHome: dirs.xdg,
        systemConfigRoot: dirs.system,
      }),
    ).toThrow(path.join("nemoclaw", "mtls", "ca.crt"));
  });
});
