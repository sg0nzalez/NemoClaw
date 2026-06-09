// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import { type CommandRunner, HostCliClient } from "../framework/clients/index.ts";
import type { E2EScenarioFixtures } from "../framework/e2e-test.ts";
import type { EnvironmentReady } from "../framework/phases/index.ts";
import { OnboardingPhaseFixture, type OnboardingSecrets } from "../framework/phases/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../framework/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

interface CleanupCall {
  name: string;
  run: () => Promise<void> | void;
}

function shellResult(exitCode: number, output = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout: output,
    stderr: exitCode === 0 ? "" : output,
    artifacts: {
      stdout: "/tmp/stdout.txt",
      stderr: "/tmp/stderr.txt",
      result: "/tmp/result.json",
    },
  };
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly responses: ShellProbeResult[] = [];

  enqueue(response: ShellProbeResult): void {
    this.responses.push(response);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(
        `FakeRunner response missing for command: ${command.command} ${command.args.join(" ")}`,
      );
    }
    return response;
  }
}

class FakeCleanup {
  readonly calls: CleanupCall[] = [];

  add(name: string, run: () => Promise<void> | void): void {
    this.calls.push({ name, run });
  }
}

class FakeSecrets implements OnboardingSecrets {
  readonly requiredCalls: string[] = [];

  constructor(private readonly values: Record<string, string | undefined> = {}) {}

  required(name: string): string {
    this.requiredCalls.push(name);
    const value = this.values[name];
    if (!value) throw new Error(`skip: missing required E2E secret: ${name}`);
    return value;
  }

  redact(text: string, extraValues: string[] = []): string {
    const values = [...Object.values(this.values), ...extraValues].filter(
      (value): value is string => Boolean(value),
    );
    return values.reduce((redacted, value) => redacted.split(value).join("[REDACTED]"), text);
  }
}

function ready(overrides: Partial<EnvironmentReady> = {}): EnvironmentReady {
  return {
    platform: "ubuntu-local",
    install: "repo-current",
    runtime: "docker-running",
    onboarding: "cloud-openclaw",
    cliPath: "nemoclaw",
    docker: {
      id: "docker-running",
      expectation: "required",
      available: true,
      result: shellResult(0),
    },
    ...overrides,
  };
}

describe("onboarding phase fixture", () => {
  it("runs cloud OpenClaw onboarding with explicit non-interactive inputs", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "onboarded\n"));
    const secrets = new FakeSecrets({ NVIDIA_API_KEY: "secret-token" });
    const onboard = new OnboardingPhaseFixture(new HostCliClient(runner), secrets);

    const instance = await onboard.from(ready(), { sandboxName: "e2e-ubuntu-repo-cloud-openclaw" });

    expect(instance).toMatchObject({
      onboarding: "cloud-openclaw",
      sandboxName: "e2e-ubuntu-repo-cloud-openclaw",
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      gatewayUrl: "http://127.0.0.1:18789",
    });
    expect(secrets.requiredCalls).toEqual(["NVIDIA_API_KEY"]);
    expect(runner.calls).toEqual([
      {
        command: "nemoclaw",
        args: ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
        options: {
          artifactName: "onboard-cloud-openclaw",
          env: expect.objectContaining({
            NEMOCLAW_AGENT: "openclaw",
            NEMOCLAW_PROVIDER: "cloud",
            NEMOCLAW_SANDBOX_NAME: "e2e-ubuntu-repo-cloud-openclaw",
            NVIDIA_API_KEY: "secret-token",
            PATH: expect.any(String),
          }),
          redactionValues: ["secret-token"],
          timeoutMs: 900_000,
        },
      },
    ]);
  });

  it("fails cloud OpenClaw onboarding on non-zero exit", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(42, "provider rejected credential"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
    );

    await expect(onboard.from(ready())).rejects.toThrow(
      /cloud-openclaw onboarding failed: provider rejected/,
    );
  });

  it("keeps sandbox cleanup registered when cloud OpenClaw onboarding fails", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(42, "provider rejected credential"));
    const cleanup = new FakeCleanup();
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
      cleanup,
    );

    await expect(onboard.from(ready(), { sandboxName: "e2e-partial-onboard" })).rejects.toThrow(
      /cloud-openclaw onboarding failed: provider rejected/,
    );

    expect(cleanup.calls).toHaveLength(1);
    expect(cleanup.calls[0]?.name).toBe("destroy NemoClaw sandbox e2e-partial-onboard");
    runner.enqueue(shellResult(1, "Error: sandbox e2e-partial-onboard not found"));
    await cleanup.calls[0]?.run();
    expect(runner.calls[1]).toMatchObject({
      command: "nemoclaw",
      args: ["e2e-partial-onboard", "destroy", "--yes"],
      options: {
        artifactName: "cleanup-destroy-e2e-partial-onboard",
        timeoutMs: 900_000,
      },
    });
  });

  it("requires NVIDIA API key before spawning cloud OpenClaw onboarding", async () => {
    const runner = new FakeRunner();
    const onboard = new OnboardingPhaseFixture(new HostCliClient(runner), new FakeSecrets());

    await expect(onboard.from(ready())).rejects.toThrow(
      /missing required E2E secret: NVIDIA_API_KEY/,
    );
    expect(runner.calls).toEqual([]);
  });

  it("requires Docker for cloud OpenClaw onboarding", async () => {
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(new FakeRunner()),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
    );

    await expect(
      onboard.from(
        ready({
          docker: { id: "docker-running", expectation: "required", available: false },
        }),
      ),
    ).rejects.toThrow(/requires an available Docker runtime/);
  });

  it("rejects invalid sandbox names before cloud OpenClaw side effects", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const secrets = new FakeSecrets({ NVIDIA_API_KEY: "secret" });
    const onboard = new OnboardingPhaseFixture(new HostCliClient(runner), secrets, cleanup);

    await expect(onboard.from(ready(), { sandboxName: "bad name" })).rejects.toThrow(
      /sandbox name is invalid for fixture client/,
    );

    expect(secrets.requiredCalls).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(cleanup.calls).toEqual([]);
  });

  it("registers sandbox cleanup after successful cloud OpenClaw onboarding", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "onboarded\n"));
    const cleanup = new FakeCleanup();
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
      cleanup,
    );

    await onboard.from(ready(), { sandboxName: "e2e-cleanup" });

    expect(cleanup.calls).toHaveLength(1);
    expect(cleanup.calls[0]?.name).toBe("destroy NemoClaw sandbox e2e-cleanup");
    runner.enqueue(shellResult(0, "destroyed\n"));
    await cleanup.calls[0]?.run();
    expect(runner.calls[1]).toMatchObject({
      command: "nemoclaw",
      args: ["e2e-cleanup", "destroy", "--yes"],
      options: {
        artifactName: "cleanup-destroy-e2e-cleanup",
        timeoutMs: 900_000,
      },
    });
    expect(runner.calls[1]?.options?.env).toMatchObject({
      PATH: expect.any(String),
    });
  });

  it("runs cloud OpenClaw onboarding with custom model and policy presets", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "onboarded\n"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
    );

    const instance = await onboard.from(ready({ onboarding: "cloud-openclaw-custom-policies" }), {
      sandboxName: "e2e-custom-policies",
    });

    expect(instance).toMatchObject({
      onboarding: "cloud-openclaw-custom-policies",
      model: "nvidia/nemotron-3-super-120b-a12b",
      policyPresets: ["npm", "pypi"],
    });
    expect(runner.calls[0]).toMatchObject({
      command: "nemoclaw",
      args: ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      options: {
        artifactName: "onboard-cloud-openclaw-custom-policies",
        env: expect.objectContaining({
          NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
          NEMOCLAW_POLICY_MODE: "custom",
          NEMOCLAW_POLICY_PRESETS: "npm,pypi",
          NEMOCLAW_SANDBOX_NAME: "e2e-custom-policies",
          NVIDIA_API_KEY: "secret-token",
        }),
        redactionValues: ["secret-token"],
        timeoutMs: 900_000,
      },
    });
  });

  it("injects the invalid NVIDIA key fixture without requiring a live secret", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Invalid NVIDIA API key. Must start with nvapi-"));
    const secrets = new FakeSecrets();
    const cleanup = new FakeCleanup();
    const onboard = new OnboardingPhaseFixture(new HostCliClient(runner), secrets, cleanup);

    const instance = await onboard.from(
      ready({ onboarding: "cloud-openclaw-invalid-nvidia-key" }),
      { sandboxName: "e2e-invalid-key" },
    );

    expect(instance.expectedFailure).toEqual({
      phase: "onboarding",
      errorClass: "invalid-nvidia-api-key",
    });
    expect(secrets.requiredCalls).toEqual([]);
    expect(cleanup.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      command: "nemoclaw",
      args: ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      options: {
        artifactName: "onboard-cloud-openclaw-invalid-nvidia-key",
        env: expect.objectContaining({
          NEMOCLAW_POLICY_MODE: "skip",
          NEMOCLAW_SANDBOX_NAME: "e2e-invalid-key",
          NVIDIA_API_KEY: "not-a-nvidia-key",
        }),
        redactionValues: ["not-a-nvidia-key"],
        timeoutMs: 900_000,
      },
    });
  });

  it("rejects invalid NVIDIA key failures that include a stack trace", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Invalid NVIDIA API key\n    at validateKey"));
    const onboard = new OnboardingPhaseFixture(new HostCliClient(runner), new FakeSecrets());

    await expect(
      onboard.from(ready({ onboarding: "cloud-openclaw-invalid-nvidia-key" })),
    ).rejects.toThrow(/printed a stack trace/);
  });

  it("runs the gateway port conflict negative path with a local port holder", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "listen tcp 127.0.0.1:18080: bind: address already in use"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
    );

    const instance = await onboard.from(
      ready({ onboarding: "cloud-openclaw-gateway-port-conflict" }),
      { sandboxName: "e2e-port-conflict" },
    );

    expect(instance).toMatchObject({
      onboarding: "cloud-openclaw-gateway-port-conflict",
      gatewayPort: 18_080,
      expectedFailure: {
        phase: "onboarding",
        errorClass: "gateway-port-conflict",
      },
    });
    expect(runner.calls[0]).toMatchObject({
      command: "nemoclaw",
      args: ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      options: {
        artifactName: "onboard-cloud-openclaw-gateway-port-conflict",
        env: expect.objectContaining({
          NEMOCLAW_GATEWAY_PORT: "18080",
          NEMOCLAW_SANDBOX_NAME: "e2e-port-conflict",
          NVIDIA_API_KEY: "secret-token",
        }),
        redactionValues: ["secret-token"],
        timeoutMs: 900_000,
      },
    });
  });

  it("runs resume onboarding after an injected policy-step interruption", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Forced onboarding failure at step 'policies'"));
    runner.enqueue(shellResult(0, "resumed\n"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
    );

    const instance = await onboard.from(
      ready({ onboarding: "cloud-nvidia-openclaw-resume-after-interrupt" }),
      { sandboxName: "e2e-resume" },
    );

    expect(instance.result).toBe(instance.results?.resume);
    expect(instance.results?.initial?.exitCode).toBe(1);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toMatchObject({
      command: "nemoclaw",
      args: ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      options: {
        artifactName: "onboard-cloud-nvidia-openclaw-resume-after-interrupt-interrupted",
        env: expect.objectContaining({
          NEMOCLAW_E2E_FAILURE_INJECTION: "1",
          NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
          NEMOCLAW_POLICY_MODE: "suggested",
          NEMOCLAW_SANDBOX_NAME: "e2e-resume",
          NVIDIA_API_KEY: "secret-token",
        }),
      },
    });
    expect(runner.calls[1]).toMatchObject({
      command: "nemoclaw",
      args: [
        "onboard",
        "--resume",
        "--non-interactive",
        "--yes",
        "--yes-i-accept-third-party-software",
      ],
      options: {
        artifactName: "onboard-cloud-nvidia-openclaw-resume-after-interrupt-resume",
        env: expect.objectContaining({
          NEMOCLAW_POLICY_MODE: "skip",
          NEMOCLAW_SANDBOX_NAME: "e2e-resume",
        }),
      },
    });
    expect(runner.calls[1]?.options?.env).not.toHaveProperty("NVIDIA_API_KEY");
  });

  it("repairs existing onboarding config before resuming", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Forced onboarding failure at step 'policies'"));
    runner.enqueue(shellResult(0, "sandbox deleted\n"));
    runner.enqueue(shellResult(0, "forward stopped\n"));
    runner.enqueue(shellResult(0, "resumed\n"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
    );

    const instance = await onboard.from(
      ready({ onboarding: "cloud-nvidia-openclaw-repair-existing-config" }),
      { sandboxName: "e2e-repair" },
    );

    expect(instance.result).toBe(instance.results?.resume);
    expect(instance.results?.repairDelete?.stdout).toContain("sandbox deleted");
    expect(instance.results?.repairForwardStop?.stdout).toContain("forward stopped");
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      [
        "nemoclaw",
        ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      ],
      ["openshell", ["sandbox", "delete", "e2e-repair"]],
      ["openshell", ["forward", "stop", "18789"]],
      [
        "nemoclaw",
        [
          "onboard",
          "--resume",
          "--non-interactive",
          "--yes",
          "--yes-i-accept-third-party-software",
        ],
      ],
    ]);
    expect(runner.calls[1]?.options).toMatchObject({
      artifactName: "onboard-cloud-nvidia-openclaw-repair-delete-sandbox",
      timeoutMs: 60_000,
    });
    expect(runner.calls[2]?.options).toMatchObject({
      artifactName: "onboard-cloud-nvidia-openclaw-repair-stop-forward",
      timeoutMs: 30_000,
    });
  });

  it("fails repair onboarding before resume when sandbox deletion fails unexpectedly", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Forced onboarding failure at step 'policies'"));
    runner.enqueue(shellResult(2, "permission denied"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
    );

    await expect(
      onboard.from(ready({ onboarding: "cloud-nvidia-openclaw-repair-existing-config" }), {
        sandboxName: "e2e-repair-delete-fail",
      }),
    ).rejects.toThrow(/delete sandbox failed: permission denied/);

    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      [
        "nemoclaw",
        ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      ],
      ["openshell", ["sandbox", "delete", "e2e-repair-delete-fail"]],
    ]);
  });

  it("fails repair onboarding before resume when forward stop fails unexpectedly", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Forced onboarding failure at step 'policies'"));
    runner.enqueue(shellResult(0, "sandbox deleted\n"));
    runner.enqueue(shellResult(2, "permission denied"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
    );

    await expect(
      onboard.from(ready({ onboarding: "cloud-nvidia-openclaw-repair-existing-config" }), {
        sandboxName: "e2e-repair-forward-fail",
      }),
    ).rejects.toThrow(/stop forward failed: permission denied/);

    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      [
        "nemoclaw",
        ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      ],
      ["openshell", ["sandbox", "delete", "e2e-repair-forward-fail"]],
      ["openshell", ["forward", "stop", "18789"]],
    ]);
  });

  it("tolerates already-missing repair cleanup before resuming", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Forced onboarding failure at step 'policies'"));
    runner.enqueue(shellResult(1, "sandbox e2e-repair-missing not found"));
    runner.enqueue(shellResult(1, "no active forward for port 18789"));
    runner.enqueue(shellResult(0, "resumed\n"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
    );

    const instance = await onboard.from(
      ready({ onboarding: "cloud-nvidia-openclaw-repair-existing-config" }),
      { sandboxName: "e2e-repair-missing" },
    );

    expect(instance.result).toBe(instance.results?.resume);
    expect(instance.results?.repairDelete?.exitCode).toBe(1);
    expect(instance.results?.repairForwardStop?.exitCode).toBe(1);
    expect(runner.calls).toHaveLength(4);
  });

  it("reruns OpenClaw onboarding for the same provider with sandbox recreation enabled", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "onboarded\n"));
    runner.enqueue(shellResult(0, "recreated\n"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
    );

    const instance = await onboard.from(
      ready({ onboarding: "cloud-nvidia-openclaw-double-same-provider" }),
      { sandboxName: "e2e-double" },
    );

    expect(instance.result).toBe(instance.results?.second);
    expect(instance.results?.initial?.stdout).toContain("onboarded");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.options?.env).toMatchObject({
      NEMOCLAW_POLICY_MODE: "skip",
      NEMOCLAW_SANDBOX_NAME: "e2e-double",
      NVIDIA_API_KEY: "secret-token",
    });
    expect(runner.calls[1]).toMatchObject({
      command: "nemoclaw",
      args: ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      options: {
        artifactName: "onboard-cloud-nvidia-openclaw-double-same-provider-recreate",
        env: expect.objectContaining({
          NEMOCLAW_POLICY_MODE: "skip",
          NEMOCLAW_RECREATE_SANDBOX: "1",
          NEMOCLAW_SANDBOX_NAME: "e2e-double",
          NVIDIA_API_KEY: "secret-token",
        }),
        redactionValues: ["secret-token"],
        timeoutMs: 900_000,
      },
    });
  });

  it("runs the no-Docker negative path with a failing Docker shim", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(7, "Cannot connect to the Docker daemon"));
    const secrets = new FakeSecrets({ NVIDIA_API_KEY: "secret-token" });
    const cleanup = new FakeCleanup();
    const onboard = new OnboardingPhaseFixture(new HostCliClient(runner), secrets, cleanup);

    const instance = await onboard.from(
      ready({
        runtime: "docker-missing",
        onboarding: "cloud-openclaw-no-docker",
        docker: { id: "docker-missing", expectation: "missing", available: true },
      }),
      { sandboxName: "e2e-no-docker" },
    );

    expect(instance).toMatchObject({
      onboarding: "cloud-openclaw-no-docker",
      sandboxName: "e2e-no-docker",
      expectedFailure: {
        phase: "preflight",
        errorClass: "docker-missing",
      },
    });
    expect(runner.calls[0]).toMatchObject({
      command: "nemoclaw",
      args: ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      options: {
        artifactName: "onboard-cloud-openclaw-no-docker",
        timeoutMs: 900_000,
      },
    });
    expect(runner.calls[0]?.options?.inheritEnv).toBeUndefined();
    expect(runner.calls[0]?.options?.redactionValues).toEqual(["secret-token"]);
    expect(runner.calls[0]?.options?.env).toMatchObject({
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_PROVIDER: "cloud",
      NEMOCLAW_SANDBOX_NAME: "e2e-no-docker",
      NVIDIA_API_KEY: "secret-token",
    });
    expect(runner.calls[0]?.options?.env?.PATH).toContain("e2e-no-docker-");
    expect(secrets.requiredCalls).toEqual(["NVIDIA_API_KEY"]);
    expect(cleanup.calls).toHaveLength(1);
    expect(cleanup.calls[0]?.name).toBe("destroy NemoClaw sandbox e2e-no-docker");
  });

  it("publishes redacted legacy preflight evidence for the no-Docker negative path", async () => {
    const previousContextDir = process.env.E2E_CONTEXT_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-typed-no-docker-"));
    process.env.E2E_CONTEXT_DIR = tmp;
    try {
      const runner = new FakeRunner();
      runner.enqueue(shellResult(7, "Docker is required before onboarding with secret-token"));
      const onboard = new OnboardingPhaseFixture(
        new HostCliClient(runner),
        new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
      );

      await onboard.from(
        ready({
          runtime: "docker-missing",
          onboarding: "cloud-openclaw-no-docker",
          docker: { id: "docker-missing", expectation: "missing", available: true },
        }),
      );

      const logBody = fs.readFileSync(path.join(tmp, "negative-preflight.log"), "utf8");
      expect(logBody).toContain("Docker is required before onboarding");
      expect(logBody).toContain("[REDACTED]");
      expect(logBody).not.toContain("secret-token");
    } finally {
      if (previousContextDir === undefined) {
        delete process.env.E2E_CONTEXT_DIR;
      } else {
        process.env.E2E_CONTEXT_DIR = previousContextDir;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts current Docker-unreachable wording for the no-Docker negative path", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(7, "Docker is not reachable. Please fix Docker and try again."));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
    );

    const instance = await onboard.from(
      ready({
        runtime: "docker-missing",
        onboarding: "cloud-openclaw-no-docker",
        docker: { id: "docker-missing", expectation: "missing", available: false },
      }),
    );

    expect(instance.expectedFailure).toEqual({
      phase: "preflight",
      errorClass: "docker-missing",
    });
  });

  it("requires the docker-missing runtime expectation for the no-Docker negative path", async () => {
    const runner = new FakeRunner();
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
    );

    await expect(onboard.from(ready({ onboarding: "cloud-openclaw-no-docker" }))).rejects.toThrow(
      /requires the docker-missing runtime expectation/,
    );
    expect(runner.calls).toEqual([]);
  });

  it("does not add an empty PATH segment when the no-Docker base env has no PATH", async () => {
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    delete process.env.HOME;
    delete process.env.PATH;
    try {
      const runner = new FakeRunner();
      runner.enqueue(shellResult(7, "Docker is required before onboarding"));
      const onboard = new OnboardingPhaseFixture(
        new HostCliClient(runner),
        new FakeSecrets({ NVIDIA_API_KEY: "secret-token" }),
      );

      await onboard.from(
        ready({
          runtime: "docker-missing",
          onboarding: "cloud-openclaw-no-docker",
          docker: { id: "docker-missing", expectation: "missing", available: false },
        }),
      );

      const pathValue = runner.calls[0]?.options?.env?.PATH;
      expect(pathValue).toContain("e2e-no-docker-");
      expect(pathValue?.split(":")).not.toContain("");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("fails the no-Docker path when onboarding unexpectedly succeeds", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "onboarded\n"));
    const cleanup = new FakeCleanup();
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
      cleanup,
    );

    await expect(
      onboard.from(
        ready({
          runtime: "docker-missing",
          onboarding: "cloud-openclaw-no-docker",
          docker: { id: "docker-missing", expectation: "missing", available: false },
        }),
        { sandboxName: "e2e-no-docker-success" },
      ),
    ).rejects.toThrow(/unexpectedly succeeded/);

    expect(cleanup.calls).toHaveLength(1);
    expect(cleanup.calls[0]?.name).toBe("destroy NemoClaw sandbox e2e-no-docker-success");
    runner.enqueue(shellResult(0, "destroyed\n"));
    await cleanup.calls[0]?.run();
    expect(runner.calls[1]).toMatchObject({
      command: "nemoclaw",
      args: ["e2e-no-docker-success", "destroy", "--yes"],
      options: {
        artifactName: "cleanup-destroy-e2e-no-docker-success",
        timeoutMs: 900_000,
      },
    });
  });

  it("rejects unrelated no-Docker onboarding failures", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(9, "provider rejected credential"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
    );

    await expect(
      onboard.from(
        ready({
          runtime: "docker-missing",
          onboarding: "cloud-openclaw-no-docker",
          docker: { id: "docker-missing", expectation: "missing", available: false },
        }),
      ),
    ).rejects.toThrow(/without Docker-missing preflight signature/);
  });

  it("rejects no-Docker onboarding failures that include a stack trace", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(9, "Docker is required before onboarding\n    at preflight"));
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(runner),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
    );

    await expect(
      onboard.from(
        ready({
          runtime: "docker-missing",
          onboarding: "cloud-openclaw-no-docker",
          docker: { id: "docker-missing", expectation: "missing", available: false },
        }),
      ),
    ).rejects.toThrow(/printed a stack trace/);
  });

  it("requires Docker before running resume, repair, and double-onboard variants", async () => {
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(new FakeRunner()),
      new FakeSecrets({ NVIDIA_API_KEY: "secret" }),
    );

    for (const onboarding of [
      "cloud-nvidia-openclaw-resume-after-interrupt",
      "cloud-nvidia-openclaw-repair-existing-config",
      "cloud-nvidia-openclaw-double-same-provider",
    ]) {
      await expect(
        onboard.from(
          ready({
            onboarding,
            docker: { id: "docker-running", expectation: "required", available: false },
          }),
        ),
      ).rejects.toThrow(/requires an available Docker runtime/);
    }
  });

  it("rejects unexpected success for negative onboarding variants", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "onboarded\n"));
    const onboard = new OnboardingPhaseFixture(new HostCliClient(runner), new FakeSecrets());

    await expect(
      onboard.from(ready({ onboarding: "cloud-openclaw-invalid-nvidia-key" })),
    ).rejects.toThrow(/unexpectedly succeeded/);
  });

  it("rejects unsupported onboarding profiles", async () => {
    const onboard = new OnboardingPhaseFixture(
      new HostCliClient(new FakeRunner()),
      new FakeSecrets(),
    );

    await expect(onboard.from(ready({ onboarding: "cloud-hermes" }))).rejects.toThrow(
      /Unsupported onboarding profile 'cloud-hermes'/,
    );
  });

  it("exposes the onboarding phase on the Vitest scenario context", () => {
    expectTypeOf<E2EScenarioFixtures["onboard"]>().toEqualTypeOf<OnboardingPhaseFixture>();
  });
});
