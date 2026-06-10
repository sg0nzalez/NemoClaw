// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, test } from "../framework/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../framework/live-project-gate.ts";
import type { ShellProbeResult } from "../framework/shell-probe.ts";

// Migrated from test/e2e/test-model-router-provider-routed-inference.sh. This
// regression guard for #3255 provisions a real cloud-backed sandbox through the
// Model Router provider and proves inference.local returns a routed completion
// instead of HTTP 503 / "inference service unavailable" after onboard.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const REPO_CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const ONBOARD_TIMEOUT_MS = 1_500_000;
const HEALTH_TIMEOUT_MS = 15_000;
const COMPLETION_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 180_000;
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-model-router";
const runModelRouterProviderRoutedTest = shouldRunLiveE2EScenarios() ? test : test.skip;

process.env.NEMOCLAW_CLI_BIN ??= REPO_CLI;

function resultText(result: ShellProbeResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function baseCommandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    CI: process.env.CI ?? "",
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS ?? "",
    RUNNER_TEMP: process.env.RUNNER_TEMP ?? "",
    RUNNER_TOOL_CACHE: process.env.RUNNER_TOOL_CACHE ?? "",
    NEMOCLAW_CLI_BIN: REPO_CLI,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    ...extra,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHealthyModelRouter(raw: string): boolean {
  return /"healthy_count"\s*:\s*[1-9]/.test(raw);
}

function isServiceUnavailable(raw: string): boolean {
  return /inference service unavailable|HTTP 503|healthy_count.*0/i.test(raw);
}

function isMissingSandboxDelete(result: ShellProbeResult): boolean {
  return /not found|no such sandbox|does not exist/i.test(resultText(result));
}

function isRoutedPongResponse(raw: string): boolean {
  try {
    const data = JSON.parse(raw) as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const model = String(data.model ?? "");
    const content = String(data.choices?.[0]?.message?.content ?? "");
    return (
      (model === "nvidia-routed" || model.startsWith("nvidia-routed")) && /\bPONG\b/i.test(content)
    );
  } catch {
    return false;
  }
}

runModelRouterProviderRoutedTest(
  "model router provider-routed inference answers through inference.local",
  {
    timeout: ONBOARD_TIMEOUT_MS + 6 * 60_000,
  },
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    const apiKey = secrets.optional("NVIDIA_API_KEY") ?? "";
    expect(apiKey, "NVIDIA_API_KEY must be set to a real NVIDIA API key").toMatch(/^nvapi-/);

    expect(
      fs.existsSync(CLI_DIST_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    await artifacts.writeJson("scenario.json", {
      id: "model-router-provider-routed-inference",
      runner: "vitest",
      boundary: "live-model-router-provider",
      migratedFrom: "test/e2e/test-model-router-provider-routed-inference.sh",
      issue: 3255,
      phases: [
        "docker-prerequisite",
        "checkout-install",
        "model-router-onboard",
        "host-router-health",
        "sandbox-inference-local-completion",
      ],
    });

    const nonSecretEnv = baseCommandEnv({
      NVIDIA_API_KEY: "",
      NEMOCLAW_PROVIDER_KEY: "",
    });
    const routedEnv = baseCommandEnv({
      NEMOCLAW_PROVIDER_KEY: apiKey,
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      NEMOCLAW_POLICY_TIER: "open",
      NEMOCLAW_PROVIDER: "routed",
      NVIDIA_API_KEY: apiKey,
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "model-router-provider-routed-docker-info",
      env: nonSecretEnv,
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    expect(docker.exitCode, `Docker is required for this E2E\n${resultText(docker)}`).toBe(0);

    cleanup.add(`destroy NemoClaw sandbox ${SANDBOX_NAME}`, async () => {
      if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1") return;
      const result = await host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "model-router-provider-routed-cleanup-destroy",
        cwd: REPO_ROOT,
        env: nonSecretEnv,
        timeoutMs: CLEANUP_TIMEOUT_MS,
      });
      if (result.exitCode !== 0 && !isMissingSandboxDelete(result)) {
        throw new Error(`cleanup destroy failed\n${resultText(result)}`);
      }
    });

    await host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "model-router-provider-routed-preclean-destroy",
      cwd: REPO_ROOT,
      env: nonSecretEnv,
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });

    const onboard = await host.nemoclaw(
      ["onboard", "--fresh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "model-router-provider-routed-onboard",
        cwd: REPO_ROOT,
        env: routedEnv,
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    expect(onboard.exitCode, `Model Router onboard failed\n${resultText(onboard)}`).toBe(0);

    let health: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      health = await host.command(
        "curl",
        ["-s", "--max-time", "10", "http://127.0.0.1:4000/health"],
        {
          artifactName: `model-router-provider-routed-health-${attempt}`,
          env: nonSecretEnv,
          timeoutMs: HEALTH_TIMEOUT_MS,
        },
      );
      if (isHealthyModelRouter(health.stdout)) {
        break;
      }
      await wait(3_000);
    }
    expect(
      health && isHealthyModelRouter(health.stdout),
      `model-router has no healthy endpoints\n${health ? resultText(health) : ""}`,
    ).toBe(true);

    const payload = JSON.stringify({
      model: "nvidia-routed",
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 50,
    });
    let completion: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      completion = await sandbox.exec(
        SANDBOX_NAME,
        [
          "curl",
          "-sk",
          "--max-time",
          "90",
          "https://inference.local/v1/chat/completions",
          "-H",
          "Content-Type: application/json",
          "-d",
          payload,
        ],
        {
          artifactName: `model-router-provider-routed-completion-${attempt}`,
          env: nonSecretEnv,
          timeoutMs: COMPLETION_TIMEOUT_MS,
        },
      );
      if (isRoutedPongResponse(completion.stdout)) {
        break;
      }
      if (isServiceUnavailable(completion.stdout) || isServiceUnavailable(completion.stderr)) {
        break;
      }
      await wait(5_000);
    }

    expect(
      completion && isRoutedPongResponse(completion.stdout),
      `Model Router inference.local did not return a routed completion\n${
        completion ? resultText(completion) : ""
      }`,
    ).toBe(true);

    await artifacts.writeJson("scenario-result.json", {
      sandboxName: SANDBOX_NAME,
      modelRouterHealthy: health ? isHealthyModelRouter(health.stdout) : false,
      inferenceLocalRoutedCompletion: completion ? isRoutedPongResponse(completion.stdout) : false,
    });
    if (health) {
      await artifacts.writeText("logs/model-router-health.log", resultText(health));
    }
    if (completion) {
      await artifacts.writeText("logs/model-router-response.log", resultText(completion));
    }
  },
);
