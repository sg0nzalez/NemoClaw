// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

// Migrated from test/e2e/test-strict-tool-call-probe.sh. This hermetic
// regression guard for #4537 exercises the Local Ollama strict Chat
// Completions tool-call validation path against local OpenAI-compatible mocks.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BUILD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 60_000;
const requireFromHere = createRequire(import.meta.url);
const runStrictToolCallProbeTest = shouldRunLiveE2EScenarios() ? test : test.skip;

type JsonObject = Record<string, unknown>;
type ValidationHelpers = {
  validateOpenAiLikeSelection: (
    label: string,
    endpoint: string,
    model: string,
    credentialEnv: string | null,
    recoveryPrompt: string,
    apiKey: string | null,
    options: unknown,
  ) => Promise<unknown>;
};
type ValidationModule = {
  createInferenceSelectionValidationHelpers: (options: {
    isNonInteractive: () => boolean;
    agentProductName: () => string;
    promptValidationRecovery: (_label: string, recovery: unknown) => Promise<string>;
  }) => ValidationHelpers;
};
type LocalInferenceModule = {
  buildOllamaProbeOptions: (skipVerify: boolean) => {
    skipResponsesProbe?: unknown;
    requireChatCompletionsToolCalling?: unknown;
  };
};
type BuiltModules = {
  validation: ValidationModule;
  localInference: LocalInferenceModule;
};
type MockEndpoint = {
  endpoint: string;
  readRequests: () => Array<{ method: string; url: string; body: JsonObject }>;
  stop: () => Promise<void>;
};

let builtModules: BuiltModules | null = null;

function requireDist<T>(...parts: string[]): T {
  return requireFromHere(path.join(REPO_ROOT, "dist", "lib", ...parts)) as T;
}

function loadBuiltModules(): BuiltModules {
  builtModules ??= {
    validation: requireDist<ValidationModule>("onboard", "inference-selection-validation"),
    localInference: requireDist<LocalInferenceModule>("inference", "local"),
  };
  return builtModules;
}

function assertObject(value: unknown, label: string): JsonObject {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
  return value as JsonObject;
}

function assertStrictPayload(payload: JsonObject): void {
  assert.equal(payload.model, "mock-tool-model");
  assert.equal(payload.tool_choice, "required");
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.stream, false);
  assert.equal(payload.temperature, 0);
  assert.ok(Array.isArray(payload.messages), "messages must be present");
  assert.ok(Array.isArray(payload.tools), "tools must be present");
  const tools = payload.tools as unknown[];
  assert.ok(
    tools.some((tool) => {
      const toolObject = assertObject(tool, "tool");
      const functionObject = assertObject(toolObject.function, "tool.function");
      return functionObject.name === "sessions_send";
    }),
    "sessions_send tool must be present",
  );
}

function makeValidationHelpers(recoveryCalls: unknown[]): ValidationHelpers {
  return loadBuiltModules().validation.createInferenceSelectionValidationHelpers({
    isNonInteractive: () => false,
    agentProductName: () => "NemoClaw",
    promptValidationRecovery: async (_label, recovery) => {
      recoveryCalls.push(recovery);
      return "retry";
    },
  });
}

function strictOllamaProbeOptions(): unknown {
  const options = loadBuiltModules().localInference.buildOllamaProbeOptions(false);
  assert.equal(options.skipResponsesProbe, true);
  assert.equal(options.requireChatCompletionsToolCalling, true);
  return options;
}

async function validate(endpoint: string, recoveryCalls: unknown[] = []): Promise<unknown> {
  const helpers = makeValidationHelpers(recoveryCalls);
  return helpers.validateOpenAiLikeSelection(
    "Local Ollama",
    endpoint,
    "mock-tool-model",
    null,
    "Choose a different Ollama model or select Other.",
    null,
    strictOllamaProbeOptions(),
  );
}

function serverSource(): string {
  return String.raw`
const fs = require("node:fs");
const http = require("node:http");

const mode = process.env.MOCK_MODE;
const requestsFile = process.env.REQUESTS_FILE;
let count = 0;

function toolCallResponse() {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: "sessions_send",
                arguments: JSON.stringify({ message: "hello" }),
              },
            },
          ],
        },
      },
    ],
  };
}

function plainTextResponse() {
  return { choices: [{ message: { role: "assistant", content: "OK" } }] };
}

function responseForRequest() {
  if (mode === "success") return { status: 200, body: toolCallResponse() };
  if (mode === "transient-502") {
    return count === 1
      ? { status: 502, body: { error: { message: "transient upstream failure" } } }
      : { status: 200, body: toolCallResponse() };
  }
  if (mode === "plain-text") return { status: 200, body: plainTextResponse() };
  return { status: 500, body: { error: { message: "unknown mock mode" } } };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    count += 1;
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let parsedBody = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch (error) {
      parsedBody = { parseError: error.message, rawBody };
    }
    fs.appendFileSync(
      requestsFile,
      JSON.stringify({ count, method: req.method, url: req.url, body: parsedBody }) + "\n",
    );
    const response = responseForRequest();
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
}

async function waitForMockPort(
  child: ChildProcessByStdio<null, Readable, Readable>,
  mode: string,
  stderr: () => string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      reject(new Error(`mock ${mode} did not report a port; stderr=${stderr()}`));
    }, 5000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`mock ${mode} exited before ready with ${String(code)}; stderr=${stderr()}`),
      );
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split(/\r?\n/).find(Boolean);
      if (!line) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(line).port as number);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startMockEndpoint(mode: string): Promise<MockEndpoint> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-strict-probe-${mode}-`));
  const requestsFile = path.join(dir, "requests.jsonl");
  fs.writeFileSync(requestsFile, "");
  const child = spawn(process.execPath, ["-e", serverSource()], {
    env: { ...process.env, MOCK_MODE: mode, REQUESTS_FILE: requestsFile },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const port = await waitForMockPort(child, mode, () => stderr);

  return {
    endpoint: `http://127.0.0.1:${String(port)}/v1`,
    readRequests() {
      const raw = fs.readFileSync(requestsFile, "utf8").trim();
      return raw ? raw.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withMockEndpoint(
  artifacts: ArtifactSink,
  mode: string,
  label: string,
  exercise: (endpoint: string, readRequests: MockEndpoint["readRequests"]) => Promise<void>,
): Promise<void> {
  const mock = await startMockEndpoint(mode);
  try {
    await exercise(mock.endpoint, () => mock.readRequests());
  } finally {
    await artifacts.writeJson(`requests/${label}.json`, mock.readRequests()).catch(() => undefined);
    await mock.stop();
  }
}

function onboardingCallerScript(): string {
  return String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");

function fromDist(...parts) {
  return require(path.join(process.cwd(), "dist", "lib", ...parts));
}

process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_PROVIDER = "ollama";
process.env.NEMOCLAW_MODEL = "mock-tool-model";
process.env.NEMOCLAW_TEST_NO_SLEEP = "1";

const runner = fromDist("runner");
runner.run = () => ({ status: 0 });
runner.runShell = () => ({ status: 0 });
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : String(command);
  if (cmd.includes("command -v") && cmd.includes("ollama")) return "";
  if (cmd.includes("/api/tags")) {
    return JSON.stringify({ models: [{ name: "mock-tool-model" }] });
  }
  if (cmd.includes("/api/show")) {
    return JSON.stringify({ capabilities: ["completion", "tools"] });
  }
  if (cmd.includes("/api/ps")) {
    return JSON.stringify({ models: [{ name: "mock-tool-model", context_length: 4096 }] });
  }
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};
runner.runCaptureEx = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : String(command);
  if (cmd.includes("/api/generate")) {
    return { stdout: JSON.stringify({ response: "hello" }), stderr: "", exitCode: 0, timedOut: false };
  }
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
};

fromDist("onboard", "ollama-systemd").ensureOllamaLoopbackSystemdOverride = () => "ready";
fromDist("onboard", "local-inference-topology").shouldFrontOllamaWithProxy = () => false;

const credentials = fromDist("credentials", "store");
credentials.prompt = async (message) => {
  throw new Error("Unexpected prompt during non-interactive Ollama onboarding: " + message);
};
credentials.ensureApiKey = async () => {
  throw new Error("Unexpected API key request during Local Ollama onboarding");
};

const lines = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => lines.push(args.join(" "));
console.error = (...args) => lines.push(args.join(" "));

(async () => {
  try {
    const { setupNim } = fromDist("onboard");
    const result = await setupNim(null, null);
    originalLog(JSON.stringify({ result, lines }));
  } catch (error) {
    originalError(lines.join("\n"));
    originalError(error && error.stack ? error.stack : error);
    process.exit(1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
})();
`;
}

function runOnboardingCallerAgainstMock(endpoint: string): void {
  const port = new URL(endpoint).port;
  const result = spawnSync(process.execPath, ["-e", onboardingCallerScript()], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NEMOCLAW_OLLAMA_PORT: port },
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? "{}") as {
    result?: { provider?: string; model?: string; preferredInferenceApi?: string };
  };
  assert.equal(payload.result?.provider, "ollama-local");
  assert.equal(payload.result?.model, "mock-tool-model");
  assert.equal(payload.result?.preferredInferenceApi, "openai-completions");
}

runStrictToolCallProbeTest(
  "strict Chat Completions tool-call probe uses bounded payloads and fails closed",
  {
    timeout: BUILD_TIMEOUT_MS + PROBE_TIMEOUT_MS,
  },
  async ({ artifacts, host }) => {
    await artifacts.writeJson("scenario.json", {
      id: "strict-tool-call-probe",
      runner: "vitest",
      boundary: "host-openai-compatible-mock",
      migratedFrom: "test/e2e/test-strict-tool-call-probe.sh",
    });

    const previousEnv = {
      NEMOCLAW_TEST_NO_SLEEP: process.env.NEMOCLAW_TEST_NO_SLEEP,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    };
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"]
      .filter(Boolean)
      .join(",");
    process.env.no_proxy = [process.env.no_proxy, "127.0.0.1", "localhost"]
      .filter(Boolean)
      .join(",");

    try {
      const build = await host.command("npm", ["run", "build:cli"], {
        artifactName: "strict-tool-call-probe-build-cli",
        cwd: REPO_ROOT,
        inheritEnv: true,
        timeoutMs: BUILD_TIMEOUT_MS,
      });
      expect(build.exitCode, `build failed\n${build.stderr}`).toBe(0);

      await withMockEndpoint(
        artifacts,
        "success",
        "strict-success",
        async (endpoint, readRequests) => {
          const result = await validate(endpoint);
          expect(result).toEqual({ ok: true, api: "openai-completions" });
          const requests = readRequests();
          assert.equal(requests.length, 1);
          assert.equal(requests[0].method, "POST");
          assert.equal(requests[0].url, "/v1/chat/completions");
          assertStrictPayload(requests[0].body);
        },
      );

      await withMockEndpoint(
        artifacts,
        "success",
        "onboarding-caller",
        async (endpoint, readRequests) => {
          runOnboardingCallerAgainstMock(endpoint);
          const requests = readRequests();
          assert.equal(requests.length, 1);
          assert.equal(requests[0].method, "POST");
          assert.equal(requests[0].url, "/v1/chat/completions");
          assertStrictPayload(requests[0].body);
        },
      );

      await withMockEndpoint(
        artifacts,
        "transient-502",
        "transient-502",
        async (endpoint, readRequests) => {
          const result = await validate(endpoint);
          expect(result).toEqual({ ok: true, api: "openai-completions" });
          const requests = readRequests();
          assert.equal(requests.length, 2);
          assertStrictPayload(requests[0].body);
          assertStrictPayload(requests[1].body);
        },
      );

      await withMockEndpoint(
        artifacts,
        "plain-text",
        "plain-text-fails-closed",
        async (endpoint, readRequests) => {
          const recoveryCalls: unknown[] = [];
          const result = await validate(endpoint, recoveryCalls);
          expect(result).toEqual({ ok: false, retry: "retry" });
          const requests = readRequests();
          assert.equal(requests.length, 1);
          assertStrictPayload(requests[0].body);
          assert.equal(recoveryCalls.length, 1);
        },
      );
    } finally {
      if (previousEnv.NEMOCLAW_TEST_NO_SLEEP === undefined) {
        delete process.env.NEMOCLAW_TEST_NO_SLEEP;
      } else {
        process.env.NEMOCLAW_TEST_NO_SLEEP = previousEnv.NEMOCLAW_TEST_NO_SLEEP;
      }
      if (previousEnv.NO_PROXY === undefined) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = previousEnv.NO_PROXY;
      }
      if (previousEnv.no_proxy === undefined) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = previousEnv.no_proxy;
      }
      await fsp.rm(artifacts.pathFor("tmp"), { recursive: true, force: true });
    }
  },
);
