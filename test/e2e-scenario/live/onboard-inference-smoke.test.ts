// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

// Migrated from test/e2e/test-onboard-inference-smoke.sh. This is a hermetic
// regression guard for #3253: setupInference() must not accept a provider/model
// route merely because gateway metadata was configured. It must reject when the
// real chat/completions smoke probe returns a runtime HTTP 503.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BUILD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 60_000;
const runOnboardInferenceSmokeTest = shouldRunLiveE2EScenarios() ? test : test.skip;

const PROBE_SCRIPT = String.raw`
const Module = require("module");
const path = require("node:path");
const originalLoad = Module._load;
const calls = [];

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./adapters/openshell/resolve" || request.endsWith("/adapters/openshell/resolve")) {
    return { resolveOpenshell: () => "/usr/bin/openshell" };
  }
  if (request === "./runner" || request.endsWith("/runner")) {
    const actualRunner = originalLoad.apply(this, arguments);
    return {
      ...actualRunner,
      run: (cmd, opts = {}) => {
        calls.push(["run", cmd]);
        if (Array.isArray(cmd) && cmd.includes("provider") && cmd.includes("upsert")) {
          return { status: 0, stdout: "Created provider compatible-endpoint\n", stderr: "" };
        }
        if (Array.isArray(cmd) && cmd.includes("inference") && cmd.includes("set")) {
          return { status: 0, stdout: "Inference configured\n", stderr: "" };
        }
        if (Array.isArray(cmd) && cmd.some((part) => String(part).includes("/chat/completions"))) {
          return {
            status: 22,
            stdout: JSON.stringify({ error: { message: "upstream returned HTTP 503 from compatible-endpoint" } }),
            stderr: "curl: (22) The requested URL returned error: 503",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      runCapture: (cmd) => {
        calls.push(["runCapture", cmd]);
        if (Array.isArray(cmd) && cmd.includes("inference") && cmd.includes("get")) {
          return JSON.stringify({ provider: "compatible-endpoint", model: "broken-model" });
        }
        return "";
      },
    };
  }
  if (request === "./onboard/providers" || request.endsWith("/onboard/providers")) {
    return {
      REMOTE_PROVIDER_CONFIG: {
        custom: {
          label: "Other OpenAI-compatible endpoint",
          providerName: "compatible-endpoint",
          providerType: "openai",
          credentialEnv: "COMPATIBLE_API_KEY",
          endpointUrl: "",
          helpUrl: null,
          modelMode: "input",
          defaultModel: "",
          skipVerify: true,
        },
      },
      LOCAL_INFERENCE_PROVIDERS: [],
      providerExistsInGateway: () => true,
      getProviderLabel: (provider) => provider,
      upsertProvider: (...args) => {
        calls.push(["upsertProvider", args]);
        return { ok: true, status: 0, message: "Created provider compatible-endpoint" };
      },
    };
  }
  if (request === "./state/registry" || request.endsWith("/state/registry")) {
    return {
      updateSandbox: (_name, patch) => calls.push(["registry.updateSandbox", patch]),
      getSandbox: () => null,
      getDisabledChannels: () => [],
    };
  }
  return originalLoad.apply(this, arguments);
};

const onboard = require(path.join(process.cwd(), "dist", "lib", "onboard"));
const result = onboard.setupInference(
  "test-sandbox",
  "broken-model",
  "compatible-endpoint",
  "https://broken.example.invalid/v1",
  "BROKEN_API_KEY",
);

Promise.resolve(result)
  .then((value) => {
    console.log("__SETUP_INFERENCE_RESOLVED__");
    console.log(JSON.stringify(value));
    console.log("__CALLS__" + JSON.stringify(calls));
    process.exit(0);
  })
  .catch((error) => {
    console.error("__SETUP_INFERENCE_REJECTED__");
    console.error(error && error.stack ? error.stack : error);
    console.log("__CALLS__" + JSON.stringify(calls));
    process.exit(3);
  });
`;

runOnboardInferenceSmokeTest(
  "setupInference rejects runtime-broken configured inference routes",
  {
    timeout: BUILD_TIMEOUT_MS + PROBE_TIMEOUT_MS,
  },
  async ({ artifacts, host }) => {
    await artifacts.writeJson("scenario.json", {
      id: "onboard-inference-smoke",
      runner: "vitest",
      boundary: "host-onboard-setupInference",
      migratedFrom: "test/e2e/test-onboard-inference-smoke.sh",
    });

    const build = await host.command("npm", ["run", "build:cli"], {
      artifactName: "onboard-inference-smoke-build-cli",
      cwd: REPO_ROOT,
      inheritEnv: true,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    expect(build.exitCode, `build failed\n${build.stderr}`).toBe(0);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-onboard-inference-smoke-"));
    try {
      const probePath = path.join(tmp, "probe.js");
      const traceDir = artifacts.pathFor("traces");
      await fs.mkdir(traceDir, { recursive: true });
      await fs.writeFile(probePath, PROBE_SCRIPT);

      const probe = await host.command("node", [probePath], {
        artifactName: "onboard-inference-smoke-probe",
        cwd: REPO_ROOT,
        inheritEnv: true,
        env: {
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_ONBOARD_INFERENCE_SMOKE_E2E: "1",
          NEMOCLAW_TRACE_DIR: traceDir,
          VITEST: "false",
        },
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      const output = `${probe.stdout}\n${probe.stderr}`;
      expect(
        probe.exitCode,
        [
          "setupInference() accepted a configured route without proving chat/completions",
          "onboard would later print Installation complete while the first real request returns HTTP 503 (#3253)",
          `stdout:\n${probe.stdout}`,
          `stderr:\n${probe.stderr}`,
        ].join("\n"),
      ).not.toBe(0);
      expect(output).not.toContain("__SETUP_INFERENCE_RESOLVED__");
      expect(output).toMatch(
        /503|upstream|compatible-endpoint|broken-model|BROKEN_API_KEY|broken\.example\.invalid/i,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  },
);
