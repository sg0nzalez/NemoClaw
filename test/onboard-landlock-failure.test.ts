// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

// This subprocess test exercises the full onboard FSM wiring with the real
// failure classifier, registry gate, and readiness tracing. Focused helper
// tests cover cleanup decisions so this file can stay at the lifecycle level.
const MESSAGING_ENV_PREFIXES = ["DISCORD_", "SLACK_", "TELEGRAM_", "WHATSAPP_"] as const;

type Scenario = {
  name: string;
  createStatus: number;
  createOutput: string;
  ready: boolean;
};

type Outcome = {
  code: number;
  commands: string[];
  registerCalls: unknown[];
  updateCalls: unknown[];
  sandboxName?: string;
};

function withoutMessagingCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !MESSAGING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  );
}

function runScenario(scenario: Scenario): {
  result: ReturnType<typeof spawnSync>;
  outcome: Outcome;
} {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-landlock-flow-"));
  const scriptPath = path.join(tempDir, "landlock-flow-check.cjs");
  const outputPath = path.join(tempDir, "outcome.json");

  const modulePath = (relativePath: string): string =>
    JSON.stringify(path.join(repoRoot, relativePath));

  const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const scenario = ${JSON.stringify(scenario)};
const runner = require(${modulePath("src/lib/runner.ts")});
const registry = require(${modulePath("src/lib/state/registry.ts")});
const buildContextStage = require(${modulePath("src/lib/onboard/build-context-stage.ts")});
const dockerfilePatchFlow = require(${modulePath("src/lib/onboard/sandbox-dockerfile-patch-flow.ts")});
const sandboxCreateStream = require(${modulePath("src/lib/sandbox/create-stream.ts")});
const readinessTracing = require(${modulePath("src/lib/onboard/sandbox-readiness-tracing.ts")});
const failureDiagnostics = require(${modulePath("src/lib/onboard/sandbox-create-failure.ts")});
const agentDefs = require(${modulePath("src/lib/agent/defs.ts")});
const openshellResolve = require(${modulePath("src/lib/adapters/openshell/resolve.ts")});

const sandboxName = "dcode-landlock-flow";
const commands = [];
const registerCalls = [];
const updateCalls = [];

function writeOutcome(code, extra = {}) {
  fs.writeFileSync(
    ${JSON.stringify(outputPath)},
    JSON.stringify({ code, commands, registerCalls, updateCalls, ...extra }),
    "utf8",
  );
}

function commandText(command) {
  return Array.isArray(command) ? command.join(" ") : String(command);
}

runner.run = (command) => {
  commands.push(commandText(command));
  return { status: 0, stdout: "", stderr: "" };
};
runner.runFile = (file, args = []) => {
  commands.push(commandText([file, ...args]));
  return { status: 0, stdout: "", stderr: "" };
};
runner.runOpenshell = (args) => {
  commands.push(commandText(["openshell", ...args]));
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  commands.push(commandText(command));
  const text = commandText(command);
  if (text.includes("openshell sandbox get") || text.includes("openshell sandbox list")) {
    return "";
  }
  return "5.15.0";
};
runner.runCaptureOpenshell = (args) => {
  commands.push(commandText(["openshell", ...args]));
  return "";
};
openshellResolve.resolveOpenshell = () => "/usr/bin/openshell";

registry.getSandbox = () => null;
registry.listExtraProviders = () => [];
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = (name, updates) => {
  updateCalls.push({ name, updates });
  return true;
};
registry.removeSandbox = () => true;
registry.getDefault = () => null;
registry.setDefault = () => true;

buildContextStage.stageCreateSandboxBuildContext = () => {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-landlock-build-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(stagedDockerfile, "FROM scratch\n", "utf8");
  return {
    buildCtx,
    stagedDockerfile,
    cleanupBuildCtx: () => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    },
  };
};

dockerfilePatchFlow.prepareSandboxDockerfilePatch = async () => ({
  buildId: "landlock-flow-test",
  resolvedBaseImage: null,
});

sandboxCreateStream.streamSandboxCreate = async (command) => {
  commands.push(command);
  return {
    status: scenario.createStatus,
    output: scenario.createOutput,
    sawProgress: true,
  };
};

readinessTracing.waitForCreatedSandboxReadyWithTrace = () => ({
  ready: scenario.ready,
  reason: scenario.ready ? "ready" : "terminal_failure_phase",
  failurePhase: scenario.ready ? null : "Failed",
});
readinessTracing.printReadinessFailure = () => undefined;
failureDiagnostics.collectSandboxCreateFailureDiagnostics = () => null;

const originalExit = process.exit;
process.exit = (code) => {
  writeOutcome(code);
  originalExit(code);
};

const { createSandbox } = require(${modulePath("src/lib/onboard.ts")});
const agent = agentDefs.loadAgent("langchain-deepagents-code");

createSandbox(
  null,
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia-prod",
  null,
  sandboxName,
  null,
  [],
  null,
  agent,
).then((name) => {
  writeOutcome(0, { sandboxName: name });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  fs.writeFileSync(scriptPath, script, "utf8");

  const env = withoutMessagingCredentials(process.env);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...env,
      HOME: tempDir,
      NEMOCLAW_HOME: path.join(tempDir, ".nemoclaw"),
      NEMOCLAW_DOCKER_GPU_PATCH: "0",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_POLICY_TIER: "restricted",
      NEMOCLAW_SANDBOX_GPU: "0",
      OPENSHELL_GATEWAY: "nemoclaw",
    },
    timeout: 20_000,
  });

  expect(fs.existsSync(outputPath), result.stderr).toBe(true);
  return {
    result,
    outcome: JSON.parse(fs.readFileSync(outputPath, "utf8")) as Outcome,
  };
}

describe("DCode Landlock onboarding flow", () => {
  it.each([
    {
      name: "kernel unsupported",
      createStatus: 1,
      createOutput:
        "Created sandbox: dcode-landlock-flow\n" +
        "Landlock unavailable in hard_requirement mode: kernel does not support Landlock",
      ready: false,
    },
    {
      name: "policy path unavailable",
      createStatus: 1,
      createOutput:
        "Created sandbox: dcode-landlock-flow\n" +
        "Landlock path unavailable in hard_requirement mode: /app (read_only): No such file or directory",
      ready: false,
    },
  ])("removes the failed sandbox without recording it as ready when $name (#5795)", (scenario) => {
    const { result, outcome } = runScenario(scenario);
    const stderr = String(result.stderr);

    expect(result.status, stderr).toBe(1);
    expect(outcome.code).toBe(1);
    expect(stderr).toContain(scenario.createOutput.split("\n").at(-1));
    expect(stderr).toContain("could not apply required Landlock filesystem isolation");
    expect(
      outcome.commands.some((command) =>
        command.endsWith("openshell sandbox delete dcode-landlock-flow"),
      ),
    ).toBe(true);
    expect(outcome.registerCalls).toEqual([]);
    expect(outcome.updateCalls).toEqual([]);
  });

  it("registers a hard-required DCode sandbox after OpenShell reports Ready", () => {
    const { result, outcome } = runScenario({
      name: "success",
      createStatus: 0,
      createOutput: "Created sandbox: dcode-landlock-flow",
      ready: true,
    });
    const stderr = String(result.stderr);

    expect(result.status, stderr).toBe(0);
    expect(outcome.code).toBe(0);
    expect(outcome.sandboxName).toBe("dcode-landlock-flow");
    expect(outcome.registerCalls).toHaveLength(1);
    expect(outcome.updateCalls).toEqual([]);
    expect(
      outcome.commands.some((command) =>
        command.endsWith("openshell sandbox delete dcode-landlock-flow"),
      ),
    ).toBe(false);
  });
});
