// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
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
const RESUME_ONBOARD_ARGS = [
  "onboard",
  "--resume",
  "--non-interactive",
  "--yes",
  "--yes-i-accept-third-party-software",
];
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
const NEGATIVE_PREFLIGHT_LOG = "negative-preflight.log";
const DEFAULT_CUSTOM_POLICY_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const DEFAULT_CUSTOM_POLICY_PRESETS = Object.freeze(["npm", "pypi"]);
const INVALID_NVIDIA_API_KEY = "not-a-nvidia-key";
const GATEWAY_PORT_CONFLICT_PORT = 18_080;
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
const MISSING_FORWARD_STOP_PATTERNS = [
  /\bNotFound\b/i,
  /\bNot Found\b/i,
  /forward .*not found/i,
  /forward .*not running/i,
  /no active forward/i,
  /no such forward/i,
  /port .*not forwarded/i,
];
const INVALID_NVIDIA_API_KEY_PATTERNS = [
  /Invalid NVIDIA API key/i,
  /Must start with nvapi-/i,
  /invalid .*NVIDIA.*api key/i,
];
const GATEWAY_PORT_CONFLICT_PATTERNS = [
  /address already in use/i,
  /port .*18080.*(?:in use|occupied|unavailable)/i,
  /gateway port .*18080/i,
  /port conflict/i,
];
const E2E_FORCED_POLICY_FAILURE_PATTERNS = [
  /Forced onboarding failure at step 'policies'/i,
  /forced.*polic/i,
  /policy failure/i,
];
const STACK_TRACE_PATTERNS = [/(^|\s)(TypeError|ReferenceError|SyntaxError):/m, /^\s+at /m];

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

export type OnboardingExpectedFailure =
  | {
      phase: "preflight";
      errorClass: "docker-missing";
    }
  | {
      phase: "onboarding";
      errorClass: "invalid-nvidia-api-key" | "gateway-port-conflict";
    };

export interface OnboardingResultSet {
  initial?: ShellProbeResult;
  resume?: ShellProbeResult;
  repairDelete?: ShellProbeResult;
  repairForwardStop?: ShellProbeResult;
  second?: ShellProbeResult;
}

export interface NemoClawInstance {
  onboarding: string;
  sandboxName: string;
  agent: "openclaw" | "hermes";
  provider: "nvidia" | "ollama";
  providerEnv: "cloud" | "local";
  platformOs?: "ubuntu" | "macos" | "windows";
  gatewayUrl: string;
  result: ShellProbeResult;
  results?: OnboardingResultSet;
  model?: string;
  policyPresets?: readonly string[];
  gatewayPort?: number;
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
    ...extra,
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
  };
}

function resumeCommandEnv(sandboxName: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
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
  return hasSignature(result, DOCKER_MISSING_PATTERNS);
}

function hasMissingSandboxDeleteSignature(result: ShellProbeResult): boolean {
  return hasSignature(result, MISSING_SANDBOX_DELETE_PATTERNS);
}

function hasMissingForwardStopSignature(result: ShellProbeResult): boolean {
  return hasSignature(result, MISSING_FORWARD_STOP_PATTERNS);
}

function hasSignature(result: ShellProbeResult, patterns: readonly RegExp[]): boolean {
  const text = resultText(result);
  return patterns.some((pattern) => pattern.test(text));
}

function hasStackTrace(result: ShellProbeResult): boolean {
  return hasSignature(result, STACK_TRACE_PATTERNS);
}

function assertDockerAvailable(environment: EnvironmentReady, onboarding: string): void {
  if (!environment.docker.available) {
    throw new Error(`${onboarding} onboarding requires an available Docker runtime.`);
  }
}

function assertExpectedFailureSignature(
  result: ShellProbeResult,
  patterns: readonly RegExp[],
  label: string,
): void {
  if (result.exitCode === 0) {
    throw new Error(`${label} unexpectedly succeeded.`);
  }
  if (hasStackTrace(result)) {
    throw new Error(`${label} printed a stack trace: ${resultText(result)}`);
  }
  if (!hasSignature(result, patterns)) {
    throw new Error(`${label} failed without expected failure signature: ${resultText(result)}`);
  }
}

function assertRepairStepResult(
  result: ShellProbeResult,
  label: string,
  isBenignMissing: (result: ShellProbeResult) => boolean,
): void {
  if (result.exitCode === 0) return;
  if (hasStackTrace(result)) {
    throw new Error(`${label} printed a stack trace: ${resultText(result)}`);
  }
  if (isBenignMissing(result)) return;
  assertExitZero(result, label);
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
      case "cloud-openclaw-custom-policies":
        return await this.cloudOpenClawCustomPolicies(environment, options);
      case "cloud-openclaw-invalid-nvidia-key":
        return await this.cloudOpenClawInvalidNvidiaKey(environment, options);
      case "cloud-openclaw-gateway-port-conflict":
        return await this.cloudOpenClawGatewayPortConflict(environment, options);
      case "cloud-openclaw-no-docker":
        return await this.cloudOpenClawNoDocker(environment, options);
      case "cloud-nvidia-openclaw-resume-after-interrupt":
        return await this.cloudNvidiaOpenClawResumeAfterInterrupt(environment, options);
      case "cloud-nvidia-openclaw-repair-existing-config":
        return await this.cloudNvidiaOpenClawRepairExistingConfig(environment, options);
      case "cloud-nvidia-openclaw-double-same-provider":
        return await this.cloudNvidiaOpenClawDoubleSameProvider(environment, options);
      default:
        throw new Error(`Unsupported onboarding profile '${environment.onboarding}'.`);
    }
  }

  async cloudOpenClaw(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    assertDockerAvailable(environment, environment.onboarding);
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    this.registerSandboxCleanup(sandboxName);
    const result = await this.runOnboard({
      artifactName: "onboard-cloud-openclaw",
      env: commandEnv(sandboxName, { NVIDIA_API_KEY: apiKey }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, "cloud-openclaw onboarding");
    return this.instance(environment, sandboxName, result);
  }

  async cloudOpenClawCustomPolicies(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    assertDockerAvailable(environment, environment.onboarding);
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    const policyPresets = DEFAULT_CUSTOM_POLICY_PRESETS;
    this.registerSandboxCleanup(sandboxName);
    const result = await this.runOnboard({
      artifactName: "onboard-cloud-openclaw-custom-policies",
      env: commandEnv(sandboxName, {
        NVIDIA_API_KEY: apiKey,
        NEMOCLAW_MODEL: DEFAULT_CUSTOM_POLICY_MODEL,
        NEMOCLAW_POLICY_MODE: "custom",
        NEMOCLAW_POLICY_PRESETS: policyPresets.join(","),
      }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, "cloud-openclaw-custom-policies onboarding");
    return this.instance(environment, sandboxName, result, {
      model: DEFAULT_CUSTOM_POLICY_MODEL,
      policyPresets,
    });
  }

  async cloudOpenClawInvalidNvidiaKey(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    assertDockerAvailable(environment, environment.onboarding);
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    this.registerSandboxCleanup(sandboxName);
    const result = await this.runOnboard({
      artifactName: "onboard-cloud-openclaw-invalid-nvidia-key",
      env: commandEnv(sandboxName, {
        NVIDIA_API_KEY: INVALID_NVIDIA_API_KEY,
        NEMOCLAW_POLICY_MODE: "skip",
      }),
      redactionValues: [INVALID_NVIDIA_API_KEY],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExpectedFailureSignature(
      result,
      INVALID_NVIDIA_API_KEY_PATTERNS,
      "cloud-openclaw-invalid-nvidia-key onboarding",
    );
    return this.instance(environment, sandboxName, result, {
      expectedFailure: {
        phase: "onboarding",
        errorClass: "invalid-nvidia-api-key",
      },
    });
  }

  async cloudOpenClawGatewayPortConflict(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    assertDockerAvailable(environment, environment.onboarding);
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    this.registerSandboxCleanup(sandboxName);
    const result = await this.withPortHolder(GATEWAY_PORT_CONFLICT_PORT, async () =>
      this.runOnboard({
        artifactName: "onboard-cloud-openclaw-gateway-port-conflict",
        env: commandEnv(sandboxName, {
          NVIDIA_API_KEY: apiKey,
          NEMOCLAW_GATEWAY_PORT: String(GATEWAY_PORT_CONFLICT_PORT),
        }),
        redactionValues: [apiKey],
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
    );
    assertExpectedFailureSignature(
      result,
      GATEWAY_PORT_CONFLICT_PATTERNS,
      "cloud-openclaw-gateway-port-conflict onboarding",
    );
    return this.instance(environment, sandboxName, result, {
      gatewayPort: GATEWAY_PORT_CONFLICT_PORT,
      expectedFailure: {
        phase: "onboarding",
        errorClass: "gateway-port-conflict",
      },
    });
  }

  async cloudNvidiaOpenClawResumeAfterInterrupt(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    const initial = await this.interruptAtPolicyStep(environment, sandboxName, apiKey, options);
    const resume = await this.resumeOnboard(environment, sandboxName, options, {
      artifactName: "onboard-cloud-nvidia-openclaw-resume-after-interrupt-resume",
    });
    return this.instance(environment, sandboxName, resume, {
      results: { initial, resume },
    });
  }

  async cloudNvidiaOpenClawRepairExistingConfig(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    const initial = await this.interruptAtPolicyStep(environment, sandboxName, apiKey, options);
    const repairDelete = await this.host.command("openshell", ["sandbox", "delete", sandboxName], {
      artifactName: "onboard-cloud-nvidia-openclaw-repair-delete-sandbox",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    assertRepairStepResult(
      repairDelete,
      "cloud-nvidia-openclaw-repair-existing-config delete sandbox",
      hasMissingSandboxDeleteSignature,
    );
    const repairForwardStop = await this.host.command("openshell", ["forward", "stop", "18789"], {
      artifactName: "onboard-cloud-nvidia-openclaw-repair-stop-forward",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    assertRepairStepResult(
      repairForwardStop,
      "cloud-nvidia-openclaw-repair-existing-config stop forward",
      hasMissingForwardStopSignature,
    );
    const resume = await this.resumeOnboard(environment, sandboxName, options, {
      artifactName: "onboard-cloud-nvidia-openclaw-repair-existing-config-resume",
    });
    return this.instance(environment, sandboxName, resume, {
      results: { initial, repairDelete, repairForwardStop, resume },
    });
  }

  async cloudNvidiaOpenClawDoubleSameProvider(
    environment: EnvironmentReady,
    options: OnboardingOptions = {},
  ): Promise<NemoClawInstance> {
    assertDockerAvailable(environment, environment.onboarding);
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    this.registerSandboxCleanup(sandboxName);
    const initial = await this.runOnboard({
      artifactName: "onboard-cloud-nvidia-openclaw-double-same-provider-initial",
      env: commandEnv(sandboxName, {
        NVIDIA_API_KEY: apiKey,
        NEMOCLAW_POLICY_MODE: "skip",
      }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(initial, "cloud-nvidia-openclaw-double-same-provider initial onboarding");
    const second = await this.runOnboard({
      artifactName: "onboard-cloud-nvidia-openclaw-double-same-provider-recreate",
      env: commandEnv(sandboxName, {
        NVIDIA_API_KEY: apiKey,
        NEMOCLAW_POLICY_MODE: "skip",
        NEMOCLAW_RECREATE_SANDBOX: "1",
      }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(second, "cloud-nvidia-openclaw-double-same-provider recreate onboarding");
    return this.instance(environment, sandboxName, second, {
      results: { initial, second },
    });
  }

  private instance(
    environment: EnvironmentReady,
    sandboxName: string,
    result: ShellProbeResult,
    extra: Partial<NemoClawInstance> = {},
  ): NemoClawInstance {
    return {
      onboarding: environment.onboarding,
      sandboxName,
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      gatewayUrl: OPENCLAW_GATEWAY_URL,
      result,
      ...extra,
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
      const result = await this.runOnboard({
        artifactName: "onboard-cloud-openclaw-no-docker",
        env,
        redactionValues: [apiKey],
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      await this.writeNegativePreflightEvidence(result, [apiKey]);
      if (result.exitCode === 0) {
        throw new Error("cloud-openclaw-no-docker onboarding unexpectedly succeeded.");
      }
      if (hasStackTrace(result)) {
        throw new Error(
          `cloud-openclaw-no-docker onboarding printed a stack trace: ${resultText(result)}`,
        );
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

  private async interruptAtPolicyStep(
    environment: EnvironmentReady,
    sandboxName: string,
    apiKey: string,
    options: OnboardingOptions,
  ): Promise<ShellProbeResult> {
    assertDockerAvailable(environment, environment.onboarding);
    this.registerSandboxCleanup(sandboxName);
    const result = await this.runOnboard({
      artifactName: `onboard-${artifactLabel(environment.onboarding)}-interrupted`,
      env: commandEnv(sandboxName, {
        NVIDIA_API_KEY: apiKey,
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
        NEMOCLAW_POLICY_MODE: "suggested",
      }),
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExpectedFailureSignature(
      result,
      E2E_FORCED_POLICY_FAILURE_PATTERNS,
      `${environment.onboarding} interrupted onboarding`,
    );
    return result;
  }

  private async resumeOnboard(
    environment: EnvironmentReady,
    sandboxName: string,
    options: OnboardingOptions,
    settings: { artifactName: string },
  ): Promise<ShellProbeResult> {
    assertDockerAvailable(environment, environment.onboarding);
    const result = await this.runOnboard({
      args: RESUME_ONBOARD_ARGS,
      artifactName: settings.artifactName,
      env: resumeCommandEnv(sandboxName, {
        NEMOCLAW_POLICY_MODE: "skip",
      }),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, `${environment.onboarding} resume onboarding`);
    return result;
  }

  private async runOnboard(options: {
    args?: string[];
    artifactName: string;
    env: NodeJS.ProcessEnv;
    redactionValues?: string[];
    timeoutMs: number;
  }): Promise<ShellProbeResult> {
    return await this.host.nemoclaw(options.args ?? ONBOARD_ARGS, {
      artifactName: options.artifactName,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: options.timeoutMs,
    });
  }

  private async withPortHolder<T>(port: number, run: () => Promise<T>): Promise<T> {
    const server = await this.tryStartPortHolder(port);
    try {
      return await run();
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }

  private async tryStartPortHolder(port: number): Promise<Server | null> {
    const server = createServer((socket) => socket.end());
    return await new Promise<Server | null>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          resolve(null);
          return;
        }
        reject(error);
      });
      server.listen(port, "127.0.0.1", () => resolve(server));
    });
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
