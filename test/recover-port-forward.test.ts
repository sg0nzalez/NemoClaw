// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { execTimeout, testTimeoutOptions } from "./helpers/timeouts";

const tmpFixtures: string[] = [];
const SDK_FAKE_EXEC = path.join(import.meta.dirname, "helpers", "sdk-fake-exec.cjs");

// Each fixture grabs a unique high port. Sharing port 18789 across tests
// collides with real nemoclaw installs on the developer's machine: the
// post-#3334 reachability probe sees the real forward answering and
// (correctly) classifies the dead-list entry as healthy, skipping recovery.
// Seed the base with the worker PID so parallel vitest workers (if ever
// enabled for this file) can't reuse the same ports across processes.
let nextFixturePort = 47000 + (process.pid % 10000);

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  tmpDir: string;
  sandboxName: string;
  port: string;
  invocationLog: string;
}

function setupFixture(opts: {
  sandboxName: string;
  gatewayProbe: "RUNNING" | "STOPPED";
  forwardListStatus: "running" | "dead" | "missing" | "occupied";
  port?: string;
}): Fixture {
  const sandboxName = opts.sandboxName;
  const port = opts.port ?? String(nextFixturePort++);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recover-"));
  tmpFixtures.push(tmpDir);
  const homeLocalBin = path.join(tmpDir, ".local", "bin");
  const registryDir = path.join(tmpDir, ".nemoclaw");
  const openshellPath = path.join(homeLocalBin, "openshell");
  const invocationLog = path.join(tmpDir, "openshell-calls.log");
  const forwardDir = path.join(registryDir, "forwards");

  fs.mkdirSync(homeLocalBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(forwardDir, { recursive: true });

  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "nvidia/test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
          dashboardPort: Number(port),
        },
      },
    }),
    { mode: 0o600 },
  );

  const writeForwardState = (
    owner: string,
    pid: number,
  ) => {
    fs.writeFileSync(
      path.join(forwardDir, `${owner}-${port}.json`),
      JSON.stringify({
        sandboxName: owner,
        bind: "127.0.0.1",
        port: Number(port),
        targetHost: "127.0.0.1",
        targetPort: Number(port),
        pid,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  };
  if (opts.forwardListStatus === "running") {
    writeForwardState(sandboxName, 0);
  } else if (opts.forwardListStatus === "dead") {
    writeForwardState(sandboxName, 999999);
  } else if (opts.forwardListStatus === "occupied") {
    writeForwardState("other-sandbox", 0);
  }

  // Fake openshell: emits the requested gateway-probe while logging every
  // invocation so the test can assert that SSH-backed OpenShell forwards are
  // not used by the gRPC bridge path.
  fs.writeFileSync(
    openshellPath,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocationLog)}, args.join(" ") + "\\n");

if (args[0] === "status") {
  process.stdout.write("Gateway: nemoclaw\\nStatus: Connected\\n");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "info") {
  process.stdout.write(
    "Gateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080\\n",
  );
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "get" && args[2] === ${JSON.stringify(sandboxName)}) {
  process.stdout.write(
    "Sandbox:\\n\\n  Id: abc\\n  Name: ${sandboxName}\\n  Phase: Ready\\n",
  );
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "list") {
  process.stdout.write("${sandboxName}   Ready   1m ago\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "exec") {
  // The probe parser drops everything up to and including the start marker,
  // so the fake gateway response must follow it on a new line.
  process.stdout.write("__NEMOCLAW_SANDBOX_EXEC_STARTED__\\n${opts.gatewayProbe}\\n");
  process.exit(0);
}

if (args[0] === "policy" && args[1] === "get") {
  process.exit(1);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write(
    "Gateway inference:\\n  Provider: nvidia-prod\\n  Model: nvidia/test-model\\n",
  );
  process.exit(0);
}

process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, sandboxName, port, invocationLog };
}

function runRecover(fixture: Fixture) {
  const repoRoot = path.join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nemoclaw.js"), fixture.sandboxName, "recover"],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: fixture.tmpDir,
        PATH: "/usr/bin:/bin",
        NEMOCLAW_NO_CONNECT_HINT: "1",
        NEMOCLAW_SDK_TEST_TRANSPORT: "1",
        NEMOCLAW_SDK_TEST_FAKE_EXEC_BIN: SDK_FAKE_EXEC,
      },
      timeout: execTimeout(15_000),
    },
  );
}

function recoverFailureMessage(fixture: Fixture, result: ReturnType<typeof runRecover>): string {
  const calls = fs.existsSync(fixture.invocationLog)
    ? fs.readFileSync(fixture.invocationLog, "utf-8")
    : "";
  return `${result.stderr || ""}${result.stdout || ""}\n--- calls ---\n${calls}`;
}

describe("nemoclaw <name> recover", () => {
  it(
    "re-establishes the dashboard port-forward when the gateway is alive but the forward is dead",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture({
        sandboxName: "alive-sandbox",
        gatewayProbe: "RUNNING",
        forwardListStatus: "dead",
      });
      const result = runRecover(fixture);
      expect(result.status, recoverFailureMessage(fixture, result)).toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "gateway is running in 'alive-sandbox'; restored dashboard port forward",
      );

      const calls = fs.readFileSync(fixture.invocationLog, "utf-8").split("\n");
      expect(calls.some((l) => l.startsWith("forward "))).toBe(false);
    },
  );

  it(
    "leaves an occupied dashboard port-forward unchanged",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture({
        sandboxName: "stuck-sandbox",
        gatewayProbe: "RUNNING",
        forwardListStatus: "occupied",
      });
      const result = runRecover(fixture);
      expect(result.status, recoverFailureMessage(fixture, result)).toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("gateway is running in 'stuck-sandbox'");
      expect(combined).not.toContain("restored dashboard port forward");
      const occupiedState = JSON.parse(
        fs.readFileSync(
          path.join(fixture.tmpDir, ".nemoclaw", "forwards", `other-sandbox-${fixture.port}.json`),
          "utf-8",
        ),
      );
      expect(occupiedState.sandboxName).toBe("other-sandbox");
    },
  );

  it(
    "no-ops when both the gateway and the forward are healthy",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture({
        sandboxName: "healthy-sandbox",
        gatewayProbe: "RUNNING",
        forwardListStatus: "running",
      });
      const result = runRecover(fixture);
      expect(result.status, recoverFailureMessage(fixture, result)).toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("gateway is running in 'healthy-sandbox'");
      expect(combined).not.toContain("Re-establishing");
      expect(combined).not.toContain("restored dashboard port forward");

      const calls = fs.readFileSync(fixture.invocationLog, "utf-8").split("\n");
      expect(calls.some((l) => l.startsWith("forward "))).toBe(false);
    },
  );
});
