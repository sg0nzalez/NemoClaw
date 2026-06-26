// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBuiltInChannelManifestRegistry } from "../src/lib/messaging";
import { reviewedOpenClawPluginIntegrityByPackageSpec } from "../src/lib/messaging/applier/build/messaging-build-applier.mts";

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
const PRODUCTION_BUILD_ARG_GUARD = path.join(
  REPO_ROOT,
  "scripts",
  "check-production-build-args.sh",
);
const UNPINNED_OPENCLAW_VERSION = "2026.6.10";
const PINNED_OPENCLAW_VERSION = "2026.6.9";
const PINNED_OPENCLAW_INTEGRITY =
  "sha512-y0PGUdE87S8QtQXABPDL0CjNKhH3q/R1h9/WiRQkhVCGSBVhs63/M1iZn2DYVyJCAbDyMz3KNyAE0WzSQIWCRg==";
const PINNED_CODEX_ACP_VERSION = "0.11.1";
const PINNED_CODEX_ACP_INTEGRITY =
  "sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==";
const PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY =
  "sha512-jU2q4L6L3qdZZDEIDXrWgwCWOGUaTSF+YzUlfgHED42TB4N3maF6seYchFpwKLB8neOzIDpnzMagEMjxZ/7Wqw==";
const PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY =
  "sha512-8HawXB5ylo+vkvkmDJZAE9uhOtm0l9YtzrVqJdM4UqwXeF4uGAkVEOrR3Hxy0sI3Moi5ZBzq2Jx/K5ZQKdiWjQ==";
const PINNED_OPENCLAW_DISCORD_INTEGRITY =
  "sha512-esFhwYW0nrFQvBhkPeK/1qmvumlVAY8ddhYBt7geIYLlBriwPJRwtnVLLfp0n1LbS0/XVZ0ORqlvkWq8Vv61vg==";
const PINNED_OPENCLAW_SLACK_INTEGRITY =
  "sha512-JZHc0L3s6s+yBsWowZtE/DWZJOuy4lTE6uTuUbF5QNjUvQQUlCHMFrwPycrXLesVq1il5yAvo82VbERRsIzgxQ==";
const PINNED_OPENCLAW_WHATSAPP_INTEGRITY =
  "sha512-HWz9CryGcSk5ork03DlESVlRcDBnwuXPEKgqdSz/Qt0OnQ2Z1wqNGpwVlAqngvDQDH2AzkNXWuTu2M0C16R8vA==";
const PINNED_OPENCLAW_MSTEAMS_INTEGRITY =
  "sha512-Ye1nf2fZYGM3lqQJ/zGlhToThyz1lLZE7HqR2F31iWcD5pV89+eEyRFNNH2FrwYeDVjw+EyWpQh2RkN1r867qg==";
const PINNED_WECHAT_PLUGIN_INTEGRITY =
  "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==";
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
    codexAcpCommittedIntegrity?: string;
    codexAcpRegistryIntegrity?: string;
    allowLegacyFixture?: boolean;
  } = {},
) {
  const {
    openclawVersion = UNPINNED_OPENCLAW_VERSION,
    committedIntegrity = "sha512-reviewed-pin",
    registryIntegrity = committedIntegrity,
    codexAcpCommittedIntegrity = PINNED_CODEX_ACP_INTEGRITY,
    codexAcpRegistryIntegrity = codexAcpCommittedIntegrity,
    allowLegacyFixture = false,
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
    `NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=${allowLegacyFixture ? "1" : "0"}`,
    `OPENCLAW_2026_3_11_INTEGRITY=${JSON.stringify(LEGACY_REBUILD_OPENCLAW_INTEGRITY)}`,
    `OPENCLAW_2026_4_24_INTEGRITY=${JSON.stringify(LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY)}`,
    `CODEX_ACP_0_11_1_INTEGRITY=${JSON.stringify(codexAcpCommittedIntegrity)}`,
    'openclaw() { if [ "${1:-}" = "--version" ]; then printf \'openclaw 2026.3.11\\n\'; else return 127; fi; }',
    "codex-acp() { :; }",
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    '  if [ "${1:-}" = "view" ] && [ "${3:-}" = "version" ]; then printf "%s\\n" "$OPENCLAW_VERSION"; return 0; fi',
    `  if [ "\${1:-}" = "view" ] && [ "\${2:-}" = "@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}" ] && [ "\${3:-}" = "dist.integrity" ]; then printf "%s\\n" ${JSON.stringify(codexAcpRegistryIntegrity)}; return 0; fi`,
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

function runProductionBuildArgGuard(
  args: string[],
  env: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [PRODUCTION_BUILD_ARG_GUARD, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

function runOptionalOpenClawPluginBlock(
  options: {
    openclawVersion?: string;
    otel?: boolean;
    webSearch?: boolean;
    diagnosticsRegistryIntegrity?: string;
    braveRegistryIntegrity?: string;
  } = {},
) {
  const {
    openclawVersion = PINNED_OPENCLAW_VERSION,
    otel = true,
    webSearch = true,
    diagnosticsRegistryIntegrity = PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY,
    braveRegistryIntegrity = PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY,
  } = options;
  const command = extractRunBlock(
    DOCKERFILE,
    "# Install non-messaging OpenClaw plugins that need to match the runtime.",
    "RUN node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-integrity-"));
  const log = path.join(tmp, "calls.log");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `OPENCLAW_VERSION=${JSON.stringify(openclawVersion)}`,
    `OPENCLAW_DIAGNOSTICS_OTEL_2026_6_9_INTEGRITY=${JSON.stringify(PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY)}`,
    `OPENCLAW_BRAVE_PLUGIN_2026_6_9_INTEGRITY=${JSON.stringify(PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY)}`,
    `NEMOCLAW_OPENCLAW_OTEL=${otel ? "1" : "0"}`,
    `NEMOCLAW_WEB_SEARCH_ENABLED=${webSearch ? "1" : "0"}`,
    'openclaw() { printf \'openclaw %s\\n\' "$*" >> "$call_log"; }',
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    '  if [ "${1:-}" != "view" ] || [ "${3:-}" != "dist.integrity" ]; then exit 1; fi',
    '  case "${2:-}" in',
    `    "@openclaw/diagnostics-otel@${PINNED_OPENCLAW_VERSION}") printf "%s\\n" ${JSON.stringify(diagnosticsRegistryIntegrity)}; return 0 ;;`,
    `    "@openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION}") printf "%s\\n" ${JSON.stringify(braveRegistryIntegrity)}; return 0 ;;`,
    "  esac",
    "  return 1",
    "}",
    command,
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
    expect(reviewNote).toContain(`@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}`);
    expect(reviewNote).toContain(PINNED_CODEX_ACP_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/diagnostics-otel@2026.6.9");
    expect(reviewNote).toContain(PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/brave-plugin@2026.6.9");
    expect(reviewNote).toContain(PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/discord@2026.6.9");
    expect(reviewNote).toContain(PINNED_OPENCLAW_DISCORD_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/slack@2026.6.9");
    expect(reviewNote).toContain(PINNED_OPENCLAW_SLACK_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/whatsapp@2026.6.9");
    expect(reviewNote).toContain(PINNED_OPENCLAW_WHATSAPP_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/msteams@2026.6.9");
    expect(reviewNote).toContain(PINNED_OPENCLAW_MSTEAMS_INTEGRITY);
    expect(reviewNote).toContain("@tencent-weixin/openclaw-weixin@2.4.3");
    expect(reviewNote).toContain(PINNED_WECHAT_PLUGIN_INTEGRITY);
    expect(reviewNote).toContain("each reviewed npm plugin registry integrity");
    expect(reviewNote).toContain("not lockfile-style artifact binding");
    expect(reviewNote).toContain(
      "Accepted residual risk: a compromised or inconsistent registry mirror",
    );
    expect(reviewNote).toContain("Do not treat these checks as proving lockfile-enforced");
    expect(reviewNote).toContain("add a split-registry fake test");
    expect(reviewNote).toContain("OpenClaw Compiled-Dist Patch Runtime Boundary");
    expect(reviewNote).toContain(
      "The long-term source of truth for these behaviors remains upstream OpenClaw",
    );
    expect(reviewNote).toContain("built-image runtime smoke on the exact head");
    expect(reviewNote).toContain("does not add a separate checked-in real-package runtime harness");
    expect(reviewNote).toContain("@openclaw/diagnostics-otel@2026.6.9");
    expect(reviewNote).toContain("@openclaw/brave-plugin@2026.6.9");
    expect(reviewNote).toContain("@tencent-weixin/openclaw-weixin@2.4.3");
    expect(reviewNote).toContain("`0` high");
    expect(reviewNote).toContain("`0` critical");
    expect(reviewNote).toContain("`763` total dependencies");
    expect(reviewNote).toContain(
      "`dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`",
    );
    expect(reviewNote).toContain("imports the hashed pipeline runtime for `prepareSlackMessage`");
    expect(reviewNote).toContain("only reports `openclaw-pipeline-runtime` after allowed prepare");
    expect(reviewNote).toContain("`dist/extensions/telegram/runtime-api.js`");
    expect(reviewNote).toContain("which exports `sendMessageTelegram`");
    expect(reviewNote).toContain("fails closed if the installed runtime file is missing");
    expect(reviewNote).toContain("NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1");
    expect(reviewNote).toContain("scripts/check-production-build-args.sh");
    expect(reviewNote).toContain("production build args");
    expect(reviewNote).toContain("claiming `openclaw-pipeline-runtime` inbound proof");
    expect(reviewNote).toContain("imports `dist/extensions/telegram/test-api.js`");
    expect(reviewNote).toContain("gateway/upstream reporting layer");
    expect(reviewNote).toContain("one-line recovery hint");
    expect(reviewNote).toContain("default 180-second timeout");
  });

  it("keeps the Teams OpenClaw plugin manifest pinned to the reviewed 2026.6.9 integrity", () => {
    const teamsManifest = createBuiltInChannelManifestRegistry().get("teams");
    const teamsPackage = teamsManifest?.agentPackages?.find(
      (agentPackage) =>
        agentPackage.agent === "openclaw" &&
        agentPackage.manager === "openclaw-plugin" &&
        agentPackage.id === "openclawPluginPackage",
    );

    expect(teamsPackage).toMatchObject({
      spec: "npm:@openclaw/msteams@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        [PINNED_OPENCLAW_VERSION]: PINNED_OPENCLAW_MSTEAMS_INTEGRITY,
      },
    });
  });

  it("keeps reviewed OpenClaw messaging plugin integrity pins aligned with built-in manifests", () => {
    const registry = createBuiltInChannelManifestRegistry();
    const expectedEntries: [string, string][] = registry.list().flatMap((manifest) =>
      (manifest.agentPackages ?? [])
        .filter(
          (agentPackage) =>
            agentPackage.agent === "openclaw" && agentPackage.manager === "openclaw-plugin",
        )
        .map((agentPackage) => {
          const packageSpec = agentPackage.spec
            .replace(/^npm:/, "")
            .replaceAll("{{openclaw.version}}", PINNED_OPENCLAW_VERSION);
          const integrity =
            agentPackage.integrity ?? agentPackage.integrityByVersion?.[PINNED_OPENCLAW_VERSION];

          expect(agentPackage.pin, `${manifest.id}:${agentPackage.id}`).toBe(true);
          expect(integrity, `${manifest.id}:${packageSpec}`).toBeDefined();
          return [packageSpec, integrity as string] as [string, string];
        }),
    );

    const sortedEntries = (entries: [string, string][]) =>
      Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));

    expect(
      sortedEntries(
        Object.entries(
          reviewedOpenClawPluginIntegrityByPackageSpec({
            OPENCLAW_VERSION: PINNED_OPENCLAW_VERSION,
          }),
        ),
      ),
    ).toEqual(sortedEntries(expectedEntries));
  });

  it("verifies optional non-messaging OpenClaw plugin integrity before install", () => {
    const { result, calls } = runOptionalOpenClawPluginBlock();

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(calls).toContain(
      `npm view @openclaw/diagnostics-otel@${PINNED_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(calls).toContain(
      `openclaw plugins install npm:@openclaw/diagnostics-otel@${PINNED_OPENCLAW_VERSION} --pin`,
    );
    expect(calls).toContain(
      `npm view @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(calls).toContain(
      `openclaw plugins install npm:@openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} --pin`,
    );
  });

  it("fails closed before optional OpenClaw plugin install when registry integrity drifts", () => {
    const { result, calls } = runOptionalOpenClawPluginBlock({
      otel: false,
      braveRegistryIntegrity: "sha512-brave-drift",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `OpenClaw plugin @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} npm integrity mismatch`,
    );
    expect(`${result.stdout}${result.stderr}`).toContain(
      `Expected: ${PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY}`,
    );
    expect(`${result.stdout}${result.stderr}`).toContain("Actual:   sha512-brave-drift");
    expect(calls).toContain(
      `npm view @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(calls).not.toContain("openclaw plugins install npm:@openclaw/brave-plugin");
  });

  it("fails closed for optional OpenClaw plugin version overrides without committed pins", () => {
    const { result, calls } = runOptionalOpenClawPluginBlock({
      openclawVersion: UNPINNED_OPENCLAW_VERSION,
      webSearch: false,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `OpenClaw plugin @openclaw/diagnostics-otel@${UNPINNED_OPENCLAW_VERSION} has no committed npm integrity pin`,
    );
    expect(calls).not.toContain("openclaw plugins install npm:@openclaw/diagnostics-otel");
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
    const codexAcp = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# Pre-install the codex-acp package",
        "# Upgrade OpenClaw if the base image is stale.",
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
    expect(codexAcp.result.status).toBe(0);
    expect(base.result.status).toBe(0);
    expect(production.calls).toContain(
      `npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(codexAcp.calls).toContain(
      `npm view @zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} dist.integrity`,
    );
    expect(production.calls).toContain(
      `npm install -g --no-audit --no-fund --no-progress openclaw@${PINNED_OPENCLAW_VERSION}`,
    );
    expect(codexAcp.calls).toContain(
      `npm install -g --no-audit --no-fund --no-progress @zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}`,
    );
    expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} version`);
    expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
    expect(base.calls).toContain(`npm install -g openclaw@${PINNED_OPENCLAW_VERSION}`);
  });

  it("rejects legacy fixture pins unless stale-upgrade fixture mode is explicit", () => {
    const production = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# OPENCLAW_VERSION is the NemoClaw runtime build target",
        "# Patch OpenClaw media fetch",
      ),
      {
        openclawVersion: LEGACY_REBUILD_OPENCLAW_VERSION,
        registryIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
      },
    );
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
    const fixtureBase = runInstallBlock(
      extractRunBlock(
        DOCKERFILE_BASE,
        "# Install OpenClaw CLI + PyYAML.",
        "# Baseline health check.",
      ),
      {
        openclawVersion: LEGACY_REBUILD_OPENCLAW_VERSION,
        registryIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
        allowLegacyFixture: true,
      },
    );

    for (const rejected of [production, base]) {
      expect(rejected.result.status).not.toBe(0);
      expect(`${rejected.result.stdout}${rejected.result.stderr}`).toContain(
        `OpenClaw ${LEGACY_REBUILD_OPENCLAW_VERSION} is a legacy E2E fixture pin`,
      );
      expect(rejected.calls).not.toContain("npm install -g");
    }
    expect(fixtureBase.result.status).toBe(0);
    expect(fixtureBase.calls).toContain(
      `npm view openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION} version`,
    );
    expect(fixtureBase.calls).toContain(
      `npm view openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(fixtureBase.calls).toContain(
      `npm install -g openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION}`,
    );
  });

  it("guards production Docker build args from the legacy OpenClaw fixture flag", () => {
    expect(runProductionBuildArgGuard(["--build-arg", "BASE_IMAGE=base"]).status).toBe(0);
    expect(
      runProductionBuildArgGuard(["--build-arg=NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=0"]).status,
    ).toBe(0);

    for (const args of [
      ["--build-arg", "NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1"],
      ["--build-arg=NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1"],
      ["NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1"],
    ]) {
      const result = runProductionBuildArgGuard(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("only allowed in explicit stale-upgrade E2E fixture builds");
    }

    const envResult = runProductionBuildArgGuard([], {
      NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW: "1",
    });
    expect(envResult.status).toBe(1);
    expect(envResult.stderr).toContain("production Docker image build args");
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

  it("fails closed before installing codex-acp when its registry integrity drifts", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# Pre-install the codex-acp package",
        "# Upgrade OpenClaw if the base image is stale.",
      ),
      {
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        codexAcpCommittedIntegrity: PINNED_CODEX_ACP_INTEGRITY,
        codexAcpRegistryIntegrity: "sha512-codex-acp-drift",
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} npm integrity mismatch`,
    );
    expect(`${result.stdout}${result.stderr}`).toContain(`Expected: ${PINNED_CODEX_ACP_INTEGRITY}`);
    expect(`${result.stdout}${result.stderr}`).toContain("Actual:   sha512-codex-acp-drift");
    expect(calls).toContain(
      `npm view @zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} dist.integrity`,
    );
    expect(calls).not.toContain(
      `npm install -g --no-audit --no-fund --no-progress @zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}`,
    );
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
