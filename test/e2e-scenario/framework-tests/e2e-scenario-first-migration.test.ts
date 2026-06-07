// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 6: Migrate First Scenario - ubuntu-repo-cloud-openclaw.
 * Verifies resolver output, plan printout, and dry-run phase ordering.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadMetadataFromDir } from "../runtime/resolver/load.ts";
import { resolveScenario } from "../runtime/resolver/plan.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_DIR = path.join(REPO_ROOT, "test/e2e-scenario");
const RUN_SCENARIO = path.join(E2E_DIR, "runtime", "run-scenario.sh");
const RUN_SUITES = path.join(E2E_DIR, "runtime", "run-suites.sh");
const SCENARIOS_YAML = path.join(E2E_DIR, "nemoclaw_scenarios", "scenarios.yaml");
const EXPECTED_STATES_YAML = path.join(
  E2E_DIR,
  "nemoclaw_scenarios",
  "expected-states.yaml",
);
const SUITES_YAML = path.join(E2E_DIR, "validation_suites", "suites.yaml");
const PREFLIGHT_PASSED_ASSERTION = path.join(
  E2E_DIR,
  "onboarding_assertions",
  "preflight",
  "00-preflight-passed.sh",
);
const SPAWN_TIMEOUT_MS = Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000);

function runScenario(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [RUN_SCENARIO, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    cwd: REPO_ROOT,
  });
}

function replaceOnce(input: string, search: string, replacement: string): string {
  const output = input.replace(search, replacement);
  expect(output, `fixture edit did not match: ${search}`).not.toBe(input);
  return output;
}

function createMetadataFixture(
  tmp: string,
  transformScenarios: (contents: string) => string,
): string {
  const fixture = path.join(tmp, "metadata");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "scenarios.yaml"),
    transformScenarios(fs.readFileSync(SCENARIOS_YAML, "utf8")),
  );
  fs.copyFileSync(
    EXPECTED_STATES_YAML,
    path.join(fixture, "expected-states.yaml"),
  );
  fs.copyFileSync(SUITES_YAML, path.join(fixture, "suites.yaml"));
  return fixture;
}

describe("Phase 6: ubuntu-repo-cloud-openclaw migration", () => {
  it("ubuntu_repo_cloud_openclaw_should_resolve_to_cloud_openclaw_ready", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const plan = resolveScenario("ubuntu-repo-cloud-openclaw", meta);
    expect(plan.expected_state.id).toBe("cloud-openclaw-ready");
    const suiteIds = plan.suites.map((s) => s.id);
    expect(suiteIds).toContain("smoke");
    expect(suiteIds).toContain("inference");
    expect(plan.onboarding_assertion_steps).toEqual([
      {
        id: "base-installed",
        stage: "base",
        script: "onboarding_assertions/base/00-cli-installed.sh",
        assertion_id: "onboarding.base.cli-installed",
      },
      {
        id: "preflight-passed",
        stage: "onboarding",
        script: "onboarding_assertions/preflight/00-preflight-passed.sh",
        assertion_id: "onboarding.preflight.passed",
      },
    ]);
  });

  it("ubuntu_repo_cloud_openclaw_plan_should_include_setup_install_onboard", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-first-"));
    try {
      const r = runScenario(["ubuntu-repo-cloud-openclaw", "--plan-only"], {
        E2E_CONTEXT_DIR: tmp,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/install=repo-current/);
      expect(r.stdout).toMatch(/runtime=docker-running/);
      expect(r.stdout).toMatch(/onboarding=cloud-openclaw/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ubuntu_repo_cloud_openclaw_dry_run_should_execute_phases_in_order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-first-"));
    try {
      const trace = path.join(tmp, "trace.log");
      const r = runScenario(["ubuntu-repo-cloud-openclaw", "--dry-run"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_TRACE_FILE: trace,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(fs.existsSync(trace)).toBe(true);
      const contents = fs.readFileSync(trace, "utf8");
      const order = [
        "env:noninteractive",
        "install:repo-current",
        "onboard:cloud-openclaw",
        "gateway:check",
        "sandbox:check",
        "onboarding-assertion:base-installed",
        "onboarding-assertion:preflight-passed",
      ];
      let pos = 0;
      for (const marker of order) {
        const idx = contents.indexOf(marker, pos);
        expect(idx, `missing marker ${marker}. trace:\n${contents}`).toBeGreaterThanOrEqual(0);
        pos = idx + marker.length;
      }
      // The run should also seed the context and produce plan.json.
      expect(fs.existsSync(path.join(tmp, "context.env"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, "plan.json"))).toBe(true);
      expect(r.stdout).toContain("== onboarding assertions ==");
      expect(r.stdout).toContain("PASS: onboarding.base.cli-installed (dry-run skipped)");
      expect(r.stdout).toContain("PASS: onboarding.preflight.passed (dry-run skipped)");
      // After dry-run, suite runner should be able to execute the full
      // suite sequence against the emitted context.
      const suites = spawnSync(
        "bash",
        [RUN_SUITES, "smoke", "inference"],
        {
          env: { ...process.env, E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" },
          encoding: "utf8",
          timeout: SPAWN_TIMEOUT_MS,
          cwd: REPO_ROOT,
        },
      );
      expect(suites.status, `suite stderr:${suites.stderr}\nstdout:${suites.stdout}`).toBe(0);
      expect(suites.stdout).toMatch(/PASS smoke\/cli-available/);
      expect(suites.stdout).toMatch(/PASS inference\/models-health/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ubuntu_no_docker_preflight_negative_dry_run_should_execute_expected_failure_assertions", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-negative-"));
    try {
      const trace = path.join(tmp, "trace.log");
      const r = runScenario(["ubuntu-no-docker-preflight-negative", "--dry-run"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_TRACE_FILE: trace,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("== onboarding assertions ==");
      expect(r.stdout).toContain("PASS: onboarding.base.cli-installed (dry-run skipped)");
      expect(r.stdout).toContain("PASS: onboarding.preflight.expected-failed (dry-run skipped)");
      expect(r.stdout).toContain("run-scenario: negative scenario passed");
      const contents = fs.readFileSync(trace, "utf8");
      expect(contents).toContain("onboarding-assertion:base-installed");
      expect(contents).toContain("onboarding-assertion:preflight-expected-failed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_scenario_should_reject_unknown_onboarding_assertion_ids", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-assertion-id-"));
    try {
      const metadataDir = createMetadataFixture(tmp, (contents) =>
        replaceOnce(
          contents,
          "    - base-installed\n    - preflight-passed",
          "    - missing-id\n    - preflight-passed",
        ),
      );
      const r = runScenario(["ubuntu-repo-cloud-openclaw", "--dry-run"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_METADATA_DIR: metadataDir,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("references unknown onboarding assertion 'missing-id'");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_scenario_should_reject_onboarding_assertion_scripts_outside_the_assertion_root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-assertion-path-"));
    try {
      const metadataDir = createMetadataFixture(tmp, (contents) =>
        replaceOnce(
          contents,
          "script: onboarding_assertions/base/00-cli-installed.sh",
          "script: ../outside.sh",
        ),
      );
      const r = runScenario(["ubuntu-repo-cloud-openclaw", "--dry-run"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_METADATA_DIR: metadataDir,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(
        "onboarding assertion base-installed script escapes onboarding_assertions/",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_scenario_should_reject_missing_onboarding_assertion_scripts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-assertion-missing-"));
    try {
      const metadataDir = createMetadataFixture(tmp, (contents) =>
        replaceOnce(
          contents,
          "script: onboarding_assertions/base/00-cli-installed.sh",
          "script: onboarding_assertions/base/missing.sh",
        ),
      );
      const r = runScenario(["ubuntu-repo-cloud-openclaw", "--dry-run"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_METADATA_DIR: metadataDir,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("onboarding assertion base-installed script not found");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_scenario_should_execute_onboarding_assertion_scripts_when_requested_in_dry_run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-assertion-exec-"));
    try {
      const metadataDir = createMetadataFixture(tmp, (contents) =>
        replaceOnce(
          contents,
          "    - base-installed\n    - preflight-passed",
          "    - preflight-passed",
        ),
      );
      const r = runScenario(["ubuntu-repo-cloud-openclaw", "--dry-run"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_DRY_RUN_EXECUTE_ONBOARDING_ASSERTIONS: "1",
        E2E_METADATA_DIR: metadataDir,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("PASS: onboarding.preflight.passed");
      expect(r.stdout).not.toContain("PASS: onboarding.preflight.passed (dry-run skipped)");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_scenario_should_propagate_onboarding_assertion_script_failures_when_executed", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-assertion-fail-"));
    try {
      const metadataDir = createMetadataFixture(tmp, (contents) =>
        replaceOnce(
          contents,
          "    - base-installed\n    - preflight-passed",
          "    - preflight-expected-failed",
        ),
      );
      const r = runScenario(["ubuntu-repo-cloud-openclaw", "--dry-run"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_DRY_RUN_EXECUTE_ONBOARDING_ASSERTIONS: "1",
        E2E_METADATA_DIR: metadataDir,
      });
      expect(r.status).toBe(3);
      expect(r.stdout).toContain("FAIL: onboarding.preflight.expected-failed");
      expect(r.stderr).toContain(
        "run-scenario: onboarding assertion preflight-expected-failed failed",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preflight_passed_assertion_should_ignore_benign_docker_mentions", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-preflight-ok-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "onboard.log"),
        "Preflight passed\nDocker container image already available\n",
      );
      const r = spawnSync("bash", [PREFLIGHT_PASSED_ASSERTION], {
        env: { ...process.env, E2E_CONTEXT_DIR: tmp },
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("PASS: onboarding.preflight.passed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preflight_passed_assertion_should_fail_on_docker_daemon_preflight_errors", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-preflight-fail-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "onboard.log"),
        "Cannot connect to the Docker daemon during preflight\n",
      );
      const r = spawnSync("bash", [PREFLIGHT_PASSED_ASSERTION], {
        env: { ...process.env, E2E_CONTEXT_DIR: tmp },
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL: onboarding.preflight.passed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
