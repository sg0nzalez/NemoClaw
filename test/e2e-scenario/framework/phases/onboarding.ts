// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { redactString } from "../../scenarios/orchestrators/redaction.ts";
import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { artifactLabel, assertExitZero } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import { validateSandboxName } from "../clients/sandbox.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { EnvironmentReady } from "./environment.ts";

const ONBOARD_ARGS = [
  "onboard",
  "--non-interactive",
  "--yes",
  "--yes-i-accept-third-party-software",
];
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
const COMPATIBLE_ENDPOINT_MAX_BODY_BYTES = 64 * 1024;
const COMPATIBLE_ENDPOINT_MODEL = "mock-compatible-model";
const HOST_SANDBOX_ALIAS = "host.openshell.internal";
const NEGATIVE_PREFLIGHT_LOG = "negative-preflight.log";
const DOCKER_MISSING_PATTERNS = [
  /Cannot connect to the Docker daemon/i,
  /Is the docker daemon running\??/i,
  /docker daemon is not running/i,
  /docker[- ]missing/i,
  /Docker is required before onboarding/i,
  /Docker is not reachable/i,
  /could not talk to the Docker daemon/i,
];
const MISSING_SANDBOX_DELETE_PATTERNS = [
  /\bNotFound\b/i,
  /\bNot Found\b/i,
  /sandbox not found/i,
  /sandbox .* not found/i,
  /sandbox .* not present/i,
  /sandbox does not exist/i,
  /no such sandbox/i,
];

export interface OnboardingSecrets {
  required(name: string): string;
  redact?(text: string, extraValues?: string[]): string;
}

export interface OnboardingCleanup {
  add(name: string, run: () => Promise<void> | void): void;
}

export interface OnboardingOptions {
  sandboxName?: string;
  timeoutMs?: number;
}

export interface OnboardingExpectedFailure {
  phase: "preflight";
  errorClass: "docker-missing";
}

export interface NemoClawInstance {
  onboarding: string;
  sandboxName: string;
  agent: "openclaw" | "hermes";
  provider: "nvidia" | "ollama" | "compatible-endpoint";
  providerEnv: "cloud" | "local" | "compatible";
  model?: string;
  platformOs?: "ubuntu" | "macos" | "windows";
  gatewayUrl: string;
  result: ShellProbeResult;
  expectedFailure?: OnboardingExpectedFailure;
}

function defaultSandboxName(onboarding: string): string {
  return `e2e-${artifactLabel(onboarding)}`;
}

function sandboxNameFromOptions(onboarding: string, options: OnboardingOptions): string {
  const sandboxName = options.sandboxName ?? defaultSandboxName(onboarding);
  validateSandboxName(sandboxName);
  return sandboxName;
}

function commandEnv(sandboxName: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    ...extra,
  };
}

interface CompatibleEndpointMock {
  endpointUrl: string;
  apiKey: string;
  model: string;
  close(): Promise<void>;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startCompatibleEndpointMock(): Promise<CompatibleEndpointMock> {
  const apiKey = `test-compatible-endpoint-${randomBytes(16).toString("hex")}`;
  const server = createServer((req, res) => {
    const path = req.url?.split("?", 1)[0] ?? "/";
    const protectedRoute =
      (req.method === "GET" && path === "/v1/models") ||
      (req.method === "POST" && path === "/v1/chat/completions");
    const writeJson = (status: number, payload: Record<string, unknown>) => {
      if (res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (protectedRoute && req.headers.authorization !== `Bearer ${apiKey}`) {
      req.resume();
      writeJson(401, { error: "unauthorized" });
      return;
    }

    let body = "";
    let bodyTooLarge = false;
    let bodyBytes = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (bodyTooLarge) return;
      bodyBytes += Buffer.byteLength(chunk, "utf8");
      if (bodyBytes > COMPATIBLE_ENDPOINT_MAX_BODY_BYTES) {
        bodyTooLarge = true;
        writeJson(413, { error: "request body too large" });
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (bodyTooLarge || res.writableEnded) return;
      if (req.method === "GET" && path === "/health") {
        writeJson(200, { ok: true });
        return;
      }
      if (req.method === "GET" && path === "/v1/models") {
        writeJson(200, {
          object: "list",
          data: [{ id: COMPATIBLE_ENDPOINT_MODEL, object: "model" }],
        });
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          writeJson(400, { error: "invalid JSON request body" });
          return;
        }
        const requestedModel =
          parsed && typeof parsed === "object" ? (parsed as { model?: unknown }).model : undefined;
        if (requestedModel !== COMPATIBLE_ENDPOINT_MODEL) {
          writeJson(400, {
            error: "unsupported model",
            expected: COMPATIBLE_ENDPOINT_MODEL,
            received: typeof requestedModel === "string" ? requestedModel : null,
          });
          return;
        }
        writeJson(200, {
          id: "chatcmpl-nemoclaw-e2e",
          object: "chat.completion",
          model: COMPATIBLE_ENDPOINT_MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "PONG" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: Math.max(1, body.length), completion_tokens: 1 },
        });
        return;
      }
      writeJson(404, { error: "not found", path });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Source boundary: this is host-side E2E fixture infrastructure, not a
    // NemoClaw product service. Docker-backed OpenShell sandboxes reach host
    // services through host.openshell.internal, and binding only localhost
    // makes the mock unreachable from the sandbox on Linux.
    //
    // Removal condition: narrow this bind to loopback or a specific
    // host-gateway address once OpenShell exposes a stable host-loopback alias
    // or the fixture can discover the sandbox-reachable host address. Protected
    // /v1 routes require the per-run bearer token above while this is broad.
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("compatible endpoint mock did not bind to a TCP port");
  }
  let closed = false;
  return {
    endpointUrl: `http://${HOST_SANDBOX_ALIAS}:${(address as AddressInfo).port}/v1`,
    apiKey,
    model: COMPATIBLE_ENDPOINT_MODEL,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
}

function noDockerShim(): string {
  // Migration source of truth for the typed fixture path: simulate the invalid
  // state where the Docker client exists but the daemon is unreachable. The
  // legacy shell worker keeps a matching shim until live no-Docker onboarding
  // dispatch moves fully into Vitest; remove both shims once the scenario can
  // inject a Docker client boundary directly instead of shadowing command lookup.
  return `#!/usr/bin/env bash
printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n' >&2
exit 1
`;
}

function prependPath(pathEntry: string, currentPath?: string): string {
  return currentPath ? `${pathEntry}:${currentPath}` : pathEntry;
}

function resultText(result: ShellProbeResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function redactExplicitValues(text: string, values: string[]): string {
  return values.reduce(
    (redacted, value) => (value ? redacted.split(value).join("[REDACTED]") : redacted),
    text,
  );
}

function legacyNegativePreflightLogPath(): string | undefined {
  const contextDir = process.env.E2E_CONTEXT_DIR;
  return contextDir ? join(contextDir, NEGATIVE_PREFLIGHT_LOG) : undefined;
}

function hasDockerMissingSignature(result: ShellProbeResult): boolean {
  const text = resultText(result);
  return DOCKER_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

function hasMissingSandboxDeleteSignature(result: ShellProbeResult): boolean {
  const text = resultText(result);
  return MISSING_SANDBOX_DELETE_PATTERNS.some((pattern) => pattern.test(text));
}

export class OnboardingPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly secrets: OnboardingSecrets,
    private readonly cleanup?: OnboardingCleanup,
  ) {}

  async from(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    switch (environment.onboarding) {
      case "cloud-openclaw":
        return await this.cloudOpenClaw(environment, options);
      case "cloud-openclaw-no-docker":
        return await this.cloudOpenClawNoDocker(environment, options);
      case "openai-compatible-openclaw":
        return await this.openAiCompatibleOpenClaw(environment, options);
      default:
        throw new Error(`Unsupported onboarding profile '${environment.onboarding}'.`);
    }
  }

  async cloudOpenClaw(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    if (!environment.docker.available) {
      throw new Error("cloud-openclaw onboarding requires an available Docker runtime.");
    }
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    this.registerSandboxCleanup(sandboxName);
    const result = await this.host.nemoclaw(ONBOARD_ARGS, {
      artifactName: "onboard-cloud-openclaw",
      env: commandEnv(sandboxName, { NVIDIA_API_KEY: apiKey }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, "cloud-openclaw onboarding");
    return {
      onboarding: environment.onboarding,
      sandboxName,
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      gatewayUrl: OPENCLAW_GATEWAY_URL,
      result,
    };
  }

  async cloudOpenClawNoDocker(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    if (environment.docker.expectation !== "missing") {
      throw new Error(
        "cloud-openclaw-no-docker onboarding requires the docker-missing runtime expectation.",
      );
    }
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    this.registerSandboxCleanup(sandboxName);
    const shimDir = await mkdtemp(join(tmpdir(), "e2e-no-docker-"));
    const shimPath = join(shimDir, "docker");
    try {
      await writeFile(shimPath, noDockerShim(), "utf8");
      await chmod(shimPath, 0o700);
      const env = commandEnv(sandboxName, { NVIDIA_API_KEY: apiKey });
      env.PATH = prependPath(shimDir, env.PATH);
      const result = await this.host.nemoclaw(ONBOARD_ARGS, {
        artifactName: "onboard-cloud-openclaw-no-docker",
        env,
        redactionValues: [apiKey],
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      await this.writeNegativePreflightEvidence(result, [apiKey]);
      if (result.exitCode === 0) {
        throw new Error("cloud-openclaw-no-docker onboarding unexpectedly succeeded.");
      }
      if (!hasDockerMissingSignature(result)) {
        throw new Error(
          `cloud-openclaw-no-docker onboarding failed without Docker-missing preflight signature: ${resultText(result)}`,
        );
      }
      return {
        onboarding: environment.onboarding,
        sandboxName,
        agent: "openclaw",
        provider: "nvidia",
        providerEnv: "cloud",
        gatewayUrl: OPENCLAW_GATEWAY_URL,
        result,
        expectedFailure: {
          phase: "preflight",
          errorClass: "docker-missing",
        },
      };
    } finally {
      await rm(shimDir, { force: true, recursive: true });
    }
  }

  async openAiCompatibleOpenClaw(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    if (!environment.docker.available) {
      throw new Error(
        "openai-compatible-openclaw onboarding requires an available Docker runtime.",
      );
    }
    if (!this.cleanup) {
      throw new Error("openai-compatible-openclaw onboarding requires cleanup registration.");
    }
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const mock = await startCompatibleEndpointMock();
    this.cleanup.add("stop OpenAI-compatible endpoint mock", mock.close);
    this.registerSandboxCleanup(sandboxName);
    const result = await this.host.nemoclaw(ONBOARD_ARGS, {
      artifactName: "onboard-openai-compatible-openclaw",
      env: commandEnv(sandboxName, {
        COMPATIBLE_API_KEY: mock.apiKey,
        NEMOCLAW_ENDPOINT_URL: mock.endpointUrl,
        NEMOCLAW_MODEL: mock.model,
        NEMOCLAW_POLICY_TIER: "open",
        NEMOCLAW_PROVIDER: "custom",
      }),
      redactionValues: [mock.apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, "openai-compatible-openclaw onboarding");
    return {
      onboarding: environment.onboarding,
      sandboxName,
      agent: "openclaw",
      provider: "compatible-endpoint",
      providerEnv: "compatible",
      model: mock.model,
      gatewayUrl: OPENCLAW_GATEWAY_URL,
      result,
    };
  }

  private registerSandboxCleanup(sandboxName: string): void {
    if (!this.cleanup) return;
    this.cleanup.add(`destroy NemoClaw sandbox ${sandboxName}`, async () => {
      const result = await this.host.nemoclaw([sandboxName, "destroy", "--yes"], {
        artifactName: `cleanup-destroy-${artifactLabel(sandboxName)}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (result.exitCode !== 0 && !hasMissingSandboxDeleteSignature(result)) {
        assertExitZero(result, `cleanup destroy sandbox ${sandboxName}`);
      }
    });
  }

  private redact(text: string, extraValues: string[] = []): string {
    return (
      this.secrets.redact?.(text, extraValues) ??
      redactString(redactExplicitValues(text, extraValues))
    );
  }

  private async writeNegativePreflightEvidence(
    result: ShellProbeResult,
    redactionValues: string[],
  ): Promise<void> {
    const logPath = legacyNegativePreflightLogPath();
    if (!logPath) return;
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, this.redact(resultText(result), redactionValues), "utf8");
  }
}
