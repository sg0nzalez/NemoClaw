// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConnectOptions } from "@openshell/sdk";

export interface GatewayMetadata {
  name: string;
  gateway_endpoint: string;
  is_remote?: boolean;
  gateway_port?: number;
  remote_host?: string;
  resolved_host?: string;
  auth_mode?: string | null;
  edge_team_domain?: string;
  edge_auth_url?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  oidc_audience?: string;
  oidc_scopes?: string;
}

export type GatewayAuthMode = "plaintext" | "tls" | "mtls" | "cloudflare_jwt" | "oidc";

export interface ResolvedGatewayMetadata {
  name: string;
  endpoint: URL;
  target: string;
  authMode: GatewayAuthMode;
  metadataPath: string | null;
  gatewayDir: string | null;
  mtlsDir: string | null;
  caCertPath: string | null;
  insecureTls: boolean;
  sdkCompatible: boolean;
  connectOptions: ConnectOptions;
}

export interface GatewayMetadataOptions {
  env?: NodeJS.ProcessEnv;
  gatewayName?: string;
  gatewayEndpoint?: string;
  gatewayInsecure?: boolean;
}

type LoadedGatewayMetadata = {
  metadata: GatewayMetadata;
  metadataPath: string;
  gatewayDir: string;
};

function configRoot(env: NodeJS.ProcessEnv): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "openshell");
}

function activeGatewayPath(env: NodeJS.ProcessEnv): string {
  return path.join(configRoot(env), "active_gateway");
}

function gatewaysDir(env: NodeJS.ProcessEnv): string {
  return path.join(configRoot(env), "gateways");
}

function sanitizeGatewayName(name: string): string {
  return name
    .split("")
    .map((ch) => (/[A-Za-z0-9._-]/.test(ch) ? ch : "_"))
    .join("");
}

function readActiveGateway(env: NodeJS.ProcessEnv): string | null {
  try {
    const name = fs.readFileSync(activeGatewayPath(env), "utf-8").trim();
    return name || null;
  } catch {
    return null;
  }
}

function readGatewayMetadata(name: string, env: NodeJS.ProcessEnv): LoadedGatewayMetadata {
  const safeName = sanitizeGatewayName(name);
  const gatewayDir = path.join(gatewaysDir(env), safeName);
  const metadataPath = path.join(gatewayDir, "metadata.json");
  const raw = fs.readFileSync(metadataPath, "utf-8");
  const parsed = JSON.parse(raw) as GatewayMetadata;
  return { metadata: parsed, metadataPath, gatewayDir };
}

function parseEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error(
      `OpenShell gateway endpoint '${endpoint}' is not a valid URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `OpenShell gateway endpoint '${endpoint}' must use http:// or https:// for the OpenShell SDK.`,
    );
  }
  return url;
}

function endpointTarget(url: URL): string {
  if (url.port) return url.host;
  return `${url.hostname}:${url.protocol === "https:" ? 443 : 80}`;
}

function normalizeAuthMode(mode: string | null | undefined, url: URL, fromMetadata: boolean): GatewayAuthMode {
  const normalized = (mode || "").trim().toLowerCase();
  if (!normalized) {
    if (url.protocol === "http:") return "plaintext";
    return fromMetadata ? "mtls" : "tls";
  }
  if (normalized === "plaintext") {
    if (url.protocol !== "http:") {
      throw new Error(
        `OpenShell gateway auth mode 'plaintext' requires an http:// endpoint, got '${url.toString()}'.`,
      );
    }
    return "plaintext";
  }
  if (normalized === "mtls") {
    if (url.protocol !== "https:") {
      throw new Error(
        `OpenShell gateway auth mode 'mtls' requires an https:// endpoint, got '${url.toString()}'.`,
      );
    }
    return "mtls";
  }
  if (normalized === "cloudflare_jwt" || normalized === "oidc") return normalized;
  if (normalized === "tls") return "tls";
  throw new Error(
    `OpenShell gateway auth mode '${normalized}' is not supported by NemoClaw's OpenShell SDK adapter.`,
  );
}

function readOptionalTrimmedFile(filePath: string): string | null {
  try {
    const value = fs.readFileSync(filePath, "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function readEdgeToken(gatewayDir: string, env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.OPENSHELL_EDGE_TOKEN || env.OPENSHELL_GATEWAY_EDGE_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return (
    readOptionalTrimmedFile(path.join(gatewayDir, "edge_token")) ||
    readOptionalTrimmedFile(path.join(gatewayDir, "cf_token"))
  );
}

function readOidcToken(gatewayDir: string, env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.OPENSHELL_OIDC_TOKEN || env.OPENSHELL_GATEWAY_OIDC_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const tokenPath = path.join(gatewayDir, "oidc_token.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as { access_token?: unknown };
    return typeof parsed.access_token === "string" && parsed.access_token.trim()
      ? parsed.access_token.trim()
      : null;
  } catch {
    return null;
  }
}

function readCaCert(gatewayDir: string | null): { caCert?: Buffer; caCertPath: string | null } {
  if (!gatewayDir) return { caCertPath: null };
  const caCertPath = path.join(gatewayDir, "mtls", "ca.crt");
  try {
    return { caCert: fs.readFileSync(caCertPath), caCertPath };
  } catch {
    return { caCertPath };
  }
}

function buildConnectOptions(params: {
  endpoint: URL;
  authMode: GatewayAuthMode;
  gatewayDir: string | null;
  insecureTls: boolean;
  env: NodeJS.ProcessEnv;
}): { connectOptions: ConnectOptions; caCertPath: string | null; sdkCompatible: boolean } {
  const { caCert, caCertPath } = readCaCert(params.gatewayDir);
  const connectOptions: ConnectOptions = {
    gateway: params.endpoint.toString(),
    ...(caCert ? { caCert } : {}),
    ...(params.insecureTls ? { insecureSkipVerify: true } : {}),
  };

  if (params.authMode === "cloudflare_jwt") {
    if (!params.gatewayDir) {
      throw new Error("OpenShell Cloudflare gateway metadata is required to load edge_token.");
    }
    const edgeToken = readEdgeToken(params.gatewayDir, params.env);
    if (!edgeToken) {
      throw new Error(
        "OpenShell Cloudflare gateway is selected, but no edge_token is available. Run `openshell gateway login`.",
      );
    }
    connectOptions.edgeToken = edgeToken;
  }

  if (params.authMode === "oidc") {
    if (!params.gatewayDir) {
      throw new Error("OpenShell OIDC gateway metadata is required to load oidc_token.json.");
    }
    const oidcToken = readOidcToken(params.gatewayDir, params.env);
    if (!oidcToken) {
      throw new Error(
        "OpenShell OIDC gateway is selected, but no oidc_token.json access_token is available. Run `openshell gateway login`.",
      );
    }
    connectOptions.oidcToken = oidcToken;
  }

  return {
    connectOptions,
    caCertPath,
    sdkCompatible: params.authMode !== "mtls",
  };
}

export function resolveGatewayMetadata(
  options: GatewayMetadataOptions = {},
): ResolvedGatewayMetadata {
  const env = options.env ?? process.env;
  const endpointOverride =
    options.gatewayEndpoint || env.OPENSHELL_GATEWAY_ENDPOINT || env.OPENSHELL_GATEWAY_URL;
  const gatewayName = options.gatewayName || env.OPENSHELL_GATEWAY || readActiveGateway(env);
  const insecureTls =
    options.gatewayInsecure === true ||
    env.OPENSHELL_GATEWAY_INSECURE === "1" ||
    env.OPENSHELL_GATEWAY_INSECURE === "true";

  let loaded: LoadedGatewayMetadata | null = null;
  if (gatewayName) {
    try {
      loaded = readGatewayMetadata(gatewayName, env);
    } catch (error) {
      if (!endpointOverride) {
        throw new Error(
          `Failed to load OpenShell gateway metadata for '${gatewayName}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (!endpointOverride && !loaded) {
    throw new Error(
      "No active OpenShell gateway is configured. Run `openshell gateway select <name>` or set OPENSHELL_GATEWAY.",
    );
  }

  const endpoint = parseEndpoint(endpointOverride || loaded?.metadata.gateway_endpoint || "");
  const name = loaded?.metadata.name || gatewayName || "endpoint";
  const gatewayDir = loaded?.gatewayDir ?? (gatewayName ? path.join(gatewaysDir(env), sanitizeGatewayName(gatewayName)) : null);
  const authMode = normalizeAuthMode(
    loaded?.metadata.auth_mode ?? env.OPENSHELL_GATEWAY_AUTH_MODE,
    endpoint,
    loaded !== null,
  );
  const { connectOptions, caCertPath, sdkCompatible } = buildConnectOptions({
    endpoint,
    authMode,
    gatewayDir,
    insecureTls,
    env,
  });

  return {
    name,
    endpoint,
    target: endpointTarget(endpoint),
    authMode,
    metadataPath: loaded?.metadataPath ?? null,
    gatewayDir,
    mtlsDir: gatewayDir ? path.join(gatewayDir, "mtls") : null,
    caCertPath,
    insecureTls,
    sdkCompatible,
    connectOptions,
  };
}
