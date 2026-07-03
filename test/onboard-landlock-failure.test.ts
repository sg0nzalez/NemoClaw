// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MESSAGING_ENV_PREFIXES = ["DISCORD_", "SLACK_", "TELEGRAM_", "WHATSAPP_"] as const;

function withoutMessagingCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !MESSAGING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  );
}

describe("DCode Landlock onboarding failure", () => {
  it("removes the failed sandbox without recording it as ready (#5795)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-landlock-failure-"));
    const scriptPath = path.join(tempDir, "landlock-failure-check.cjs");
    const outputPath = path.join(tempDir, "outcome.json");

    const modulePath = (relativePath: string): string =>
      JSON.stringify(path.join(repoRoot, relativePath));

    const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runner = require(${modulePath("src/lib/runner.ts")});
const registry = require(${modulePath("src/lib/state/registry.ts")});
const buildContextStage = require(${modulePath("src/lib/onboard/build-context-stage.ts")});
const dockerfilePatchFlow = require(${modulePath("src/lib/onboard/sandbox-dockerfile-patch-flow.ts")});
const sandboxCreateStream = require(${modulePath("src/lib/sandbox/create-stream.ts")});
const readinessTracing = require(${modulePath("src/lib/onboard/sandbox-readiness-tracing.ts")});
const failureDiagnostics = require(${modulePath("src/lib/onboard/sandbox-create-failure.ts")});
const agentDefs = require(${modulePath("src/lib/agent/defs.ts")});

const sandboxName = "dcode-landlock-fail";
const commands = [];
const registerCalls = [];
const updateCalls = [];

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
runner.runCapture = () => "";
runner.runCaptureOpenshell = (args) => {
  commands.push(commandText(["openshell", ...args]));
  return "";
};

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
  buildId: "landlock-failure-test",
  resolvedBaseImage: null,
});

sandboxCreateStream.streamSandboxCreate = async (command) => {
  commands.push(command);
  return {
    status: 1,
    output:
      "Created sandbox: dcode-landlock-fail\n" +
      "Landlock unavailable in hard_requirement mode: kernel does not support Landlock",
    sawProgress: true,
  };
};

readinessTracing.waitForCreatedSandboxReadyWithTrace = () => ({
  ready: false,
  reason: "terminal_failure_phase",
  failurePhase: "Failed",
});
readinessTracing.printReadinessFailure = () => undefined;
failureDiagnostics.collectSandboxCreateFailureDiagnostics = () => null;

const originalExit = process.exit;
process.exit = (code) => {
  fs.writeFileSync(
    ${JSON.stringify(outputPath)},
    JSON.stringify({ code, commands, registerCalls, updateCalls }),
    "utf8",
  );
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
).catch((error) => {
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_POLICY_TIER: "restricted",
        OPENSHELL_GATEWAY: "nemoclaw",
      },
      timeout: 20_000,
    });

    expect(result.status, result.stderr).toBe(1);
    expect(fs.existsSync(outputPath), result.stderr).toBe(true);
    const outcome = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
      code: number;
      commands: string[];
      registerCalls: unknown[];
      updateCalls: unknown[];
    };

    expect(outcome.code).toBe(1);
    expect(
      outcome.commands.some((command) =>
        command.endsWith("openshell sandbox delete dcode-landlock-fail"),
      ),
    ).toBe(true);
    expect(outcome.registerCalls).toEqual([]);
    expect(outcome.updateCalls).toEqual([]);
  });
});
