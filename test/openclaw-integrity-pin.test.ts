// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");
const BLUEPRINT = path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml");
const DEPENDENCY_REVIEW_NOTE = path.join(
  REPO_ROOT,
  "docs",
  "security",
  "openclaw-2026.6.9-dependency-review.md",
);
const SLACK_API_PROOF_HELPER = path.join(REPO_ROOT, "test", "e2e", "lib", "slack-api-proof.sh");
const UNPINNED_OPENCLAW_VERSION = "2026.6.10";
const PINNED_OPENCLAW_VERSION = "2026.6.9";
const PINNED_OPENCLAW_INTEGRITY =
  "sha512-y0PGUdE87S8QtQXABPDL0CjNKhH3q/R1h9/WiRQkhVCGSBVhs63/M1iZn2DYVyJCAbDyMz3KNyAE0WzSQIWCRg==";
const LEGACY_REBUILD_OPENCLAW_VERSION = "2026.3.11";
const LEGACY_REBUILD_OPENCLAW_INTEGRITY =
  "sha512-bxwiBmHPakwfpY5tqC9lrV5TCu5PKf0c1bHNc3nhrb+pqKcPEWV4zOjDVFLQUHr98ihgWA+3pacy4b3LQ8wduQ==";
const LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY =
  "sha512-W6u4XeIIP4+uG4DYV9G3JeS6QNuKwfhQIej1GIoL4BdcnUFgrnB8kHYNXL3MxiHRKuhZB9OYwUMGs8jKFZR/Vg==";

function extractRunBlock(file: string, startMarker: string, endMarker: string): string {
  const source = fs.readFileSync(file, "utf-8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `Expected start marker in ${file}: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `Expected end marker in ${file}: ${endMarker}`).toBeGreaterThan(start);
  const runIndex = source.indexOf("RUN ", start);
  expect(runIndex, `Expected RUN instruction after ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(runIndex, `Expected RUN instruction before ${endMarker}`).toBeLessThanOrEqual(end);
  return source
    .slice(runIndex, end)
    .trim()
    .replace(/^RUN\s+--mount=[^\n]+\\\n\s*/, "")
    .replace(/^RUN\s+/, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .replace(/\\\s*$/, "");
}

function runInstallBlock(
  command: string,
  options: {
    openclawVersion?: string;
    committedIntegrity?: string;
    registryIntegrity?: string;
  } = {},
) {
  const {
    openclawVersion = UNPINNED_OPENCLAW_VERSION,
    committedIntegrity = "sha512-reviewed-pin",
    registryIntegrity = committedIntegrity,
  } = options;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-integrity-"));
  const blueprint = path.join(tmp, "blueprint.yaml");
  const log = path.join(tmp, "calls.log");
  fs.writeFileSync(blueprint, fs.readFileSync(BLUEPRINT, "utf-8"));
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `OPENCLAW_VERSION=${JSON.stringify(openclawVersion)}`,
    `OPENCLAW_2026_6_9_INTEGRITY=${JSON.stringify(committedIntegrity)}`,
    `OPENCLAW_2026_3_11_INTEGRITY=${JSON.stringify(LEGACY_REBUILD_OPENCLAW_INTEGRITY)}`,
    `OPENCLAW_2026_4_24_INTEGRITY=${JSON.stringify(LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY)}`,
    'openclaw() { if [ "${1:-}" = "--version" ]; then printf \'openclaw 2026.3.11\\n\'; else return 127; fi; }',
    "codex-acp() { :; }",
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    '  if [ "${1:-}" = "view" ] && [ "${3:-}" = "version" ]; then printf "%s\\n" "$OPENCLAW_VERSION"; return 0; fi',
    `  if [ "\${1:-}" = "view" ] && [ "\${3:-}" = "dist.integrity" ]; then printf "%s\\n" ${JSON.stringify(registryIntegrity)}; return 0; fi`,
    "}",
    "pip3() { return 0; }",
    command
      .replaceAll("/opt/nemoclaw-blueprint/blueprint.yaml", blueprint)
      .replaceAll("/tmp/blueprint.yaml", blueprint),
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  fs.rmSync(tmp, { recursive: true, force: true });
  return { result, calls };
}

describe("OpenClaw npm integrity pins", () => {
  it("keeps the advisory review note aligned with the committed OpenClaw pin", () => {
    const reviewNote = fs.readFileSync(DEPENDENCY_REVIEW_NOTE, "utf-8");

    expect(reviewNote).toContain(`openclaw@${PINNED_OPENCLAW_VERSION}`);
    expect(reviewNote).toContain(PINNED_OPENCLAW_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/slack@2026.6.9");
    expect(reviewNote).toContain(
      "sha512-JZHc0L3s6s+yBsWowZtE/DWZJOuy4lTE6uTuUbF5QNjUvQQUlCHMFrwPycrXLesVq1il5yAvo82VbERRsIzgxQ==",
    );
    expect(reviewNote).toContain("`0` high");
    expect(reviewNote).toContain("`0` critical");
    expect(reviewNote).toContain(
      "`dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`",
    );
    expect(reviewNote).toContain("openclaw-pipeline-runtime");
    expect(reviewNote).toContain("send-only `openclaw-runtime-api` branch remains");
    expect(reviewNote).toContain("gateway/upstream reporting layer");
    expect(reviewNote).toContain("one-line recovery hint");
    expect(reviewNote).toContain("default 180-second timeout");
  });

  it("keeps the Slack installed-ingress proof aligned with the reviewed plugin shape", () => {
    const proof = fs.readFileSync(SLACK_API_PROOF_HELPER, "utf-8");

    expect(proof).toContain("pipeline-runtime");
    expect(proof).toContain("pipeline.runtime-*.js");
    expect(proof).toContain("createSlackPipelineProofContext");
    expect(proof).toContain(". /tmp/nemoclaw-proxy-env.sh");
    expect(proof).toContain('proof: "openclaw-pipeline-runtime"');
    expect(proof).toContain("deniedFeedbackCount");
  });

  it("installs the reviewed pin when registry integrity matches the committed pin", () => {
    const production = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# OPENCLAW_VERSION is the NemoClaw runtime build target",
        "# Patch OpenClaw media fetch",
      ),
      {
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
      },
    );
    const base = runInstallBlock(
      extractRunBlock(
        DOCKERFILE_BASE,
        "# Install OpenClaw CLI + PyYAML.",
        "# Baseline health check.",
      ),
      {
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
      },
    );

    expect(production.result.status).toBe(0);
    expect(base.result.status).toBe(0);
    expect(production.calls).toContain(
      `npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(production.calls).toContain(
      `npm install -g --no-audit --no-fund --no-progress openclaw@${PINNED_OPENCLAW_VERSION}`,
    );
    expect(production.calls).toContain(
      "npm install -g --no-audit --no-fund --no-progress @zed-industries/codex-acp@0.11.1",
    );
    expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} version`);
    expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
    expect(base.calls).toContain(`npm install -g openclaw@${PINNED_OPENCLAW_VERSION}`);
  });

  it("allows exact legacy fixture pins used by stale-upgrade E2Es", () => {
    const base = runInstallBlock(
      extractRunBlock(
        DOCKERFILE_BASE,
        "# Install OpenClaw CLI + PyYAML.",
        "# Baseline health check.",
      ),
      {
        openclawVersion: LEGACY_REBUILD_OPENCLAW_VERSION,
        registryIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
      },
    );

    expect(base.result.status).toBe(0);
    expect(base.calls).toContain(`npm view openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION} version`);
    expect(base.calls).toContain(
      `npm view openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(base.calls).toContain(`npm install -g openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION}`);
  });

  it("fails closed before npm install when the registry integrity drifts", () => {
    const installBlocks = [
      {
        label: "production Dockerfile",
        file: DOCKERFILE,
        startMarker: "# OPENCLAW_VERSION is the NemoClaw runtime build target",
        endMarker: "# Patch OpenClaw media fetch",
      },
      {
        label: "base Dockerfile",
        file: DOCKERFILE_BASE,
        startMarker: "# Install OpenClaw CLI + PyYAML.",
        endMarker: "# Baseline health check.",
      },
    ];

    for (const block of installBlocks) {
      const { result, calls } = runInstallBlock(
        extractRunBlock(block.file, block.startMarker, block.endMarker),
        {
          openclawVersion: PINNED_OPENCLAW_VERSION,
          committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
          registryIntegrity: "sha512-registry-drift",
        },
      );
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, block.label).not.toBe(0);
      expect(output, block.label).toContain(
        `OpenClaw ${PINNED_OPENCLAW_VERSION} npm integrity mismatch`,
      );
      expect(output, block.label).toContain(`Expected: ${PINNED_OPENCLAW_INTEGRITY}`);
      expect(output, block.label).toContain("Actual:   sha512-registry-drift");
      expect(calls, block.label).toContain(
        `npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`,
      );
      expect(calls, block.label).not.toContain("npm install -g");
    }
  });

  it("fails closed before npm install for unpinned production Dockerfile overrides", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# OPENCLAW_VERSION is the NemoClaw runtime build target",
        "# Patch OpenClaw media fetch",
      ),
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `OpenClaw ${UNPINNED_OPENCLAW_VERSION} has no committed npm integrity pin`,
    );
    expect(calls).not.toContain("npm install -g");
  });

  it("fails closed before npm install for unpinned base Dockerfile overrides", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE_BASE,
        "# Install OpenClaw CLI + PyYAML.",
        "# Baseline health check.",
      ),
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `OpenClaw ${UNPINNED_OPENCLAW_VERSION} has no committed npm integrity pin`,
    );
    expect(calls).not.toContain("npm install -g");
  });
});
