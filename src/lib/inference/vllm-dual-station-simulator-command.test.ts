// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertDualStationSimulationPlatform,
  buildDualStationSimulationInvocation,
  createSimulationPoisonBin,
  DUAL_STATION_SIMULATION_POISON_EXECUTABLES,
  DUAL_STATION_SIMULATION_SUITES,
  dualStationSimulationEnvironment,
  main,
} from "../../../scripts/simulate-dual-station.mts";

describe("dual-Station simulator command", () => {
  it("selects only the audited non-live source simulation suites", () => {
    expect(DUAL_STATION_SIMULATION_SUITES).toHaveLength(8);
    expect(DUAL_STATION_SIMULATION_SUITES).toContain(
      "src/lib/inference/vllm-dual-station-simulator.test.ts",
    );
    expect(
      DUAL_STATION_SIMULATION_SUITES.every(
        (suite) =>
          suite.startsWith("src/lib/inference/") &&
          suite.endsWith(".test.ts") &&
          !suite.includes("/e2e/") &&
          !suite.includes("/live/"),
      ),
    ).toBe(true);
  });

  it("poisons commands that could reach a live host or external service", () => {
    expect(DUAL_STATION_SIMULATION_POISON_EXECUTABLES).toEqual(
      expect.arrayContaining(["curl", "docker", "nvidia-smi", "ping", "python3", "ssh"]),
    );

    const poisonBin = createSimulationPoisonBin();
    try {
      expect(fs.readFileSync(path.join(poisonBin.directory, "docker"), "utf8")).toContain(
        "exit 97",
      );
      expect(fs.statSync(poisonBin.homeDirectory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(poisonBin.cacheDirectory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(poisonBin.tempDirectory).mode & 0o777).toBe(0o700);
    } finally {
      poisonBin.cleanup();
    }
    expect(fs.existsSync(poisonBin.directory)).toBe(false);
  });

  it("inherits only local process basics and forces live projects off", () => {
    const env = dualStationSimulationEnvironment({
      PATH: "/fixture/bin",
      HOME: "/real/home",
      XDG_CACHE_HOME: "/real/cache",
      XDG_RUNTIME_DIR: "/real/runtime",
      ACME_SECRET: "should-not-leak",
      DOCKER_HOST: "ssh://should-not-run",
      GIT_ASKPASS: "/should/not/run",
      GITHUB_TOKEN: "should-not-leak",
      HF_TOKEN: "should-not-leak",
      NEMOCLAW_DGX_STATION_PEER: "should-not-run",
      NEMOCLAW_DGX_STATION_SSH_BINDING: "should-not-run",
      NEMOCLAW_RUN_BRANCH_VALIDATION_E2E: "1",
      NEMOCLAW_RUN_LIVE_E2E: "1",
      UNRELATED_AMBIENT_VALUE: "should-not-inherit",
    });

    expect(env).toEqual({
      PATH: "/fixture/bin",
      NEMOCLAW_RUN_BRANCH_VALIDATION_E2E: "0",
      NEMOCLAW_RUN_LIVE_E2E: "0",
    });
  });

  it("pins the repository-local Vitest CLI and the non-live project", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const invocation = buildDualStationSimulationInvocation(root, {});

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      path.join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--project",
      "cli",
      ...DUAL_STATION_SIMULATION_SUITES,
      "--reporter=dot",
    ]);
  });

  it("fails clearly on native Windows instead of weakening POSIX fixture checks", () => {
    expect(() => assertDualStationSimulationPlatform("win32")).toThrow("requires a POSIX host");
    expect(() => assertDualStationSimulationPlatform("darwin")).not.toThrow();
    expect(() => assertDualStationSimulationPlatform("linux")).not.toThrow();
  });

  it("rejects arguments instead of forwarding them to another test project", () => {
    expect(() => main(["--project", "e2e-live"])).toThrow(
      "Unknown dual-Station simulator argument",
    );
  });
});
