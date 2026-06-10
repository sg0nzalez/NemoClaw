// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { type ArtifactSink } from "../framework/artifacts.ts";
import { expect, test } from "../framework/e2e-test.ts";

// Migrated from test/e2e/test-runtime-overrides.sh. This remains a real
// Docker-image boundary test: it builds the NemoClaw sandbox image, runs the
// image entrypoint with runtime override env vars, and reads the patched
// /sandbox/.openclaw/openclaw.json through the entrypoint's fd 3 escape hatch.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const IMAGE = process.env.NEMOCLAW_TEST_IMAGE || "nemoclaw-override-test";
const DOCKER_TIMEOUT_MS = 35 * 60 * 1000;
const RUN_TIMEOUT_MS = 90_000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const runtimeOverridesTest = process.env.NEMOCLAW_RUN_E2E_SCENARIOS === "1" ? test : test.skip;

type JsonObject = Record<string, unknown>;
type DockerEnv = Record<string, string>;

function appendCommandLog(
  artifacts: ArtifactSink,
  label: string,
  command: readonly string[],
  result: ReturnType<typeof spawnSync>,
): void {
  const exit =
    typeof result.status === "number"
      ? String(result.status)
      : result.signal
        ? `signal:${result.signal}`
        : "unknown";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  fs.appendFileSync(
    artifacts.pathFor("docker.log"),
    [
      `## ${label}`,
      `$ ${command.join(" ")}`,
      `exit=${exit}`,
      result.error ? `error=${String(result.error)}` : "",
      stderr ? `stderr:\n${stderr}` : "stderr: <empty>",
      stdout ? `stdout:\n${stdout}` : "stdout: <empty>",
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function runDocker(
  artifacts: ArtifactSink,
  label: string,
  args: readonly string[],
  timeout = RUN_TIMEOUT_MS,
): ReturnType<typeof spawnSync> {
  const result = spawnSync("docker", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT,
    timeout,
  });
  appendCommandLog(artifacts, label, ["docker", ...args], result);
  return result;
}

function expectDockerSuccess(result: ReturnType<typeof spawnSync>, label: string): void {
  expect(result.error, `${label} errored: ${String(result.error)}`).toBeUndefined();
  expect(
    result.status,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function asRecord(value: unknown, label: string): JsonObject {
  expect(value, `${label} must be an object`).toBeTruthy();
  expect(typeof value, `${label} must be an object`).toBe("object");
  expect(Array.isArray(value), `${label} must not be an array`).toBe(false);
  return value as JsonObject;
}

function asString(value: unknown, label: string): string {
  expect(typeof value, `${label} must be a string`).toBe("string");
  expect(value, `${label} must not be empty`).not.toBe("");
  return value as string;
}

function asNumber(value: unknown, label: string): number {
  expect(typeof value, `${label} must be a number`).toBe("number");
  return value as number;
}

function asBoolean(value: unknown, label: string): boolean {
  expect(typeof value, `${label} must be a boolean`).toBe("boolean");
  return value as boolean;
}

function providerModel(config: JsonObject): JsonObject {
  const models = asRecord(config.models, "models");
  const providers = asRecord(models.providers, "models.providers");
  expect(Object.keys(providers).length, "models.providers must not be empty").toBeGreaterThan(0);
  const provider = asRecord(Object.values(providers)[0], "first provider");
  expect(Array.isArray(provider.models), "first provider models must be an array").toBe(true);
  const providerModels = provider.models as unknown[];
  expect(providerModels.length, "first provider models must not be empty").toBeGreaterThan(0);
  return asRecord(providerModels[0], "first provider model");
}

function primaryModel(config: JsonObject): string {
  const agents = asRecord(config.agents, "agents");
  const defaults = asRecord(agents.defaults, "agents.defaults");
  const model = asRecord(defaults.model, "agents.defaults.model");
  return asString(model.primary, "agents.defaults.model.primary");
}

function contextWindow(config: JsonObject): number {
  return asNumber(providerModel(config).contextWindow, "contextWindow");
}

function maxTokens(config: JsonObject): number {
  return asNumber(providerModel(config).maxTokens, "maxTokens");
}

function reasoning(config: JsonObject): boolean {
  return asBoolean(providerModel(config).reasoning, "reasoning");
}

function allowedOrigins(config: JsonObject): string[] {
  const gateway = asRecord(config.gateway, "gateway");
  const controlUi = asRecord(gateway.controlUi, "gateway.controlUi");
  expect(Array.isArray(controlUi.allowedOrigins), "allowedOrigins must be an array").toBe(true);
  return controlUi.allowedOrigins as string[];
}

function expectValidConfig(config: JsonObject): void {
  primaryModel(config);
  contextWindow(config);
  maxTokens(config);
  reasoning(config);
  allowedOrigins(config);
}

function envArgs(env: DockerEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

function ensureImage(artifacts: ArtifactSink): void {
  const inspect = runDocker(artifacts, "inspect image", ["image", "inspect", IMAGE], 30_000);
  if (inspect.status === 0) {
    return;
  }

  const build = runDocker(
    artifacts,
    "build image",
    [
      "build",
      "-t",
      IMAGE,
      "-f",
      DOCKERFILE,
      REPO_ROOT,
      "--build-arg",
      "NEMOCLAW_DISABLE_DEVICE_AUTH=1",
      "--build-arg",
      `NEMOCLAW_BUILD_ID=${String(Date.now())}`,
      "--quiet",
    ],
    DOCKER_TIMEOUT_MS,
  );
  expectDockerSuccess(build, "docker build");
}

function runEntrypointCommand(
  artifacts: ArtifactSink,
  label: string,
  env: DockerEnv,
  command: string,
): ReturnType<typeof spawnSync> {
  return runDocker(
    artifacts,
    label,
    ["run", "--rm", ...envArgs(env), IMAGE, "bash", "-c", command],
    RUN_TIMEOUT_MS,
  );
}

async function captureConfig(
  artifacts: ArtifactSink,
  label: string,
  env: DockerEnv = {},
): Promise<JsonObject> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = runEntrypointCommand(
      artifacts,
      `${label} config capture attempt ${String(attempt)}`,
      env,
      'cat /sandbox/.openclaw/openclaw.json >&3; printf "\\n" >&3',
    );

    try {
      expectDockerSuccess(result, `${label} config capture`);
      const config = JSON.parse(String(result.stdout).trim()) as JsonObject;
      expectValidConfig(config);
      await artifacts.writeJson(`configs/${label.replaceAll(/\W+/g, "-")}.json`, config);
      return config;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(attempt * 1000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} config capture failed after 3 attempts`);
}

function expectConfigHashValid(artifacts: ArtifactSink, label: string, env: DockerEnv = {}): void {
  const result = runEntrypointCommand(
    artifacts,
    `${label} config hash`,
    env,
    'cd /sandbox/.openclaw && if sha256sum -c .config-hash --status; then printf "OK\\n" >&3; else printf "FAIL\\n" >&3; fi',
  );
  expectDockerSuccess(result, `${label} config hash`);
  expect(String(result.stdout).trim(), `${label} config hash stdout`).toBe("OK");
}

function captureOverrideStderr(artifacts: ArtifactSink, label: string, env: DockerEnv): string {
  const result = runEntrypointCommand(artifacts, `${label} stderr`, env, "true");
  return String(result.stderr);
}

runtimeOverridesTest(
  "runtime overrides patch OpenClaw config at container startup",
  {
    timeout: 40 * 60 * 1000,
  },
  async ({ artifacts }) => {
    await artifacts.writeJson("scenario.json", {
      id: "runtime-overrides",
      runner: "vitest",
      boundary: "docker-image-entrypoint",
      migratedFrom: "test/e2e/test-runtime-overrides.sh",
    });

    ensureImage(artifacts);

    const baseline = await captureConfig(artifacts, "baseline");
    const baselineModel = primaryModel(baseline);
    const baselineContext = contextWindow(baseline);
    const baselineOrigins = allowedOrigins(baseline).length;

    expectConfigHashValid(artifacts, "baseline");

    const overrideModel = "anthropic/claude-sonnet-4-6";
    const modelConfig = await captureConfig(artifacts, "model override", {
      NEMOCLAW_MODEL_OVERRIDE: overrideModel,
    });
    expect(primaryModel(modelConfig)).toBe(overrideModel);
    expectConfigHashValid(artifacts, "model override", {
      NEMOCLAW_MODEL_OVERRIDE: overrideModel,
    });

    const contextConfig = await captureConfig(artifacts, "context window override", {
      NEMOCLAW_MODEL_OVERRIDE: overrideModel,
      NEMOCLAW_CONTEXT_WINDOW: "32768",
    });
    expect(contextWindow(contextConfig)).toBe(32768);

    const maxTokensConfig = await captureConfig(artifacts, "max tokens override", {
      NEMOCLAW_MODEL_OVERRIDE: overrideModel,
      NEMOCLAW_MAX_TOKENS: "16384",
    });
    expect(maxTokens(maxTokensConfig)).toBe(16384);

    const reasoningConfig = await captureConfig(artifacts, "reasoning override", {
      NEMOCLAW_MODEL_OVERRIDE: overrideModel,
      NEMOCLAW_REASONING: "true",
    });
    expect(reasoning(reasoningConfig)).toBe(true);

    const corsOrigin = "https://custom.example.com:9999";
    const corsConfig = await captureConfig(artifacts, "cors origin override", {
      NEMOCLAW_CORS_ORIGIN: corsOrigin,
    });
    expect(allowedOrigins(corsConfig)).toContain(corsOrigin);
    expect(allowedOrigins(corsConfig).length).toBeGreaterThan(baselineOrigins);

    const combinedConfig = await captureConfig(artifacts, "combined overrides", {
      NEMOCLAW_MODEL_OVERRIDE: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      NEMOCLAW_CONTEXT_WINDOW: "65536",
      NEMOCLAW_MAX_TOKENS: "8192",
      NEMOCLAW_REASONING: "true",
      NEMOCLAW_CORS_ORIGIN: "https://multi.example.com",
    });
    expect(primaryModel(combinedConfig)).toBe("nvidia/llama-3.3-nemotron-super-49b-v1.5");
    expect(contextWindow(combinedConfig)).toBe(65536);
    expect(maxTokens(combinedConfig)).toBe(8192);
    expect(reasoning(combinedConfig)).toBe(true);
    expect(allowedOrigins(combinedConfig)).toContain("https://multi.example.com");

    expect(
      captureOverrideStderr(artifacts, "model override with control chars", {
        NEMOCLAW_MODEL_OVERRIDE: "bad\u0001model",
      }),
    ).toContain("control characters");
    expect(
      captureOverrideStderr(artifacts, "context window with non-integer", {
        NEMOCLAW_MODEL_OVERRIDE: "test",
        NEMOCLAW_CONTEXT_WINDOW: "notanumber",
      }),
    ).toContain("must be a positive integer");
    expect(
      captureOverrideStderr(artifacts, "max tokens with non-integer", {
        NEMOCLAW_MODEL_OVERRIDE: "test",
        NEMOCLAW_MAX_TOKENS: "abc",
      }),
    ).toContain("must be a positive integer");
    expect(
      captureOverrideStderr(artifacts, "reasoning with invalid value", {
        NEMOCLAW_MODEL_OVERRIDE: "test",
        NEMOCLAW_REASONING: "maybe",
      }),
    ).toContain('must be "true" or "false"');
    expect(
      captureOverrideStderr(artifacts, "cors origin without http", {
        NEMOCLAW_CORS_ORIGIN: "ftp://evil.com",
      }),
    ).toContain("must start with http");
    expect(
      captureOverrideStderr(artifacts, "inference api with invalid type", {
        NEMOCLAW_MODEL_OVERRIDE: "test",
        NEMOCLAW_INFERENCE_API_OVERRIDE: "graphql",
      }),
    ).toContain("openai-completions");

    const rejectedConfig = await captureConfig(artifacts, "rejected override", {
      NEMOCLAW_MODEL_OVERRIDE: "test",
      NEMOCLAW_CONTEXT_WINDOW: "notanumber",
    });
    expect(primaryModel(rejectedConfig)).toBe(baselineModel);
    expect(contextWindow(rejectedConfig)).toBe(baselineContext);

    await artifacts.writeJson("scenario-result.json", {
      status: "passed",
      assertions: [
        "baseline config is valid and hash matches",
        "model override patches agents.defaults.model.primary and recomputes hash",
        "context window, max tokens, reasoning, and CORS overrides patch expected fields",
        "combined overrides apply together",
        "invalid override values emit validation diagnostics",
        "invalid supplemental overrides leave the original config unchanged",
      ],
    });
  },
);
