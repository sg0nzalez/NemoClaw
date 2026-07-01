// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPolicySelectionPromptHelpers } from "../src/lib/onboard/policy-selection-prompts";
import * as tiers from "../src/lib/policy/tiers";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");
const REPO_ROOT = path.join(import.meta.dirname, "..");
const policies = requireForTest(
  path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));
const POLICY_PROMPTS_PATH = JSON.stringify(
  path.join(REPO_ROOT, "src", "lib", "onboard", "policy-selection-prompts.ts"),
);
const POLICY_SELECTION_PATH = JSON.stringify(
  path.join(REPO_ROOT, "src", "lib", "onboard", "policy-selection.ts"),
);
const POLICY_SYNC_PATH = JSON.stringify(
  path.join(REPO_ROOT, "src", "lib", "onboard", "policy-preset-sync.ts"),
);
const TIERS_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "tiers.ts"));
const SOURCE_NODE_ARGS = ["--import", "tsx"];
const DOCUMENTED_OPEN_PRESETS = [
  "npm",
  "pypi",
  "huggingface",
  "brew",
  "brave",
  "weather",
  "public-reference",
  "slack",
  "discord",
  "telegram",
  "wechat",
  "whatsapp",
  "jira",
  "outlook",
];

function createNonInteractivePolicySelector() {
  return createPolicySelectionPromptHelpers({
    tiers,
    policyTierEnv: { resolvePolicyTierFromEnv: () => "open" },
    isNonInteractive: () => true,
    note: vi.fn(),
    prompt: vi.fn(),
    selectFromNumberedMenuOrExit: vi.fn(),
    makeOnboardCancelExit: vi.fn(() => vi.fn()),
    sandboxCancelRollback: { markCancelled: vi.fn() },
    useColor: false,
  });
}

function parseResultPayload(stdout: string): Record<string, unknown> {
  const marker = "__RESULT__";
  const markerIndex = stdout.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(markerIndex + marker.length));
}

describe("Open-tier Jira and Outlook presets", () => {
  it("keeps every documented preset selected by default (#6123)", async () => {
    const selector = createNonInteractivePolicySelector();
    const resolved = await selector.selectTierPresetsAndAccess("open", policies.listPresets());
    const selectedNames = new Set(resolved.map((preset) => preset.name));

    expect(DOCUMENTED_OPEN_PRESETS.filter((name) => !selectedNames.has(name))).toEqual([]);
  });

  it("resolves Jira and Outlook into standalone gateway policy keys (#6123)", () => {
    const result = policies.mergePresetNamesIntoPolicy("", ["jira", "outlook"]);
    const parsed = YAML.parse(result.policy);

    expect(result.missingPresets).toEqual([]);
    expect(result.appliedPresets).toEqual(["jira", "outlook"]);
    expect(parsed.network_policies).toHaveProperty("atlassian");
    expect(parsed.network_policies).toHaveProperty("outlook_graph");
  });

  it("carries interactive Open-tier defaults through sync and policy-list reconciliation (#6123)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-open-tier-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const gatewayPolicy = path.join(tmpDir, "gateway-policy.yaml");
    fs.copyFileSync(
      path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
      gatewayPolicy,
    );
    const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const tiers = require(${TIERS_PATH});
const { createPolicySelectionPromptHelpers } = require(${POLICY_PROMPTS_PATH});
const { setupPoliciesWithSelection } = require(${POLICY_SELECTION_PATH});
const { syncPresetSelection } = require(${POLICY_SYNC_PATH});
registry.registerSandbox({
  name: "open-tier-sandbox",
  agent: "openclaw",
  policyTier: "open",
  policies: [],
});
const promptHelpers = createPolicySelectionPromptHelpers({
  tiers,
  policyTierEnv: { resolvePolicyTierFromEnv: () => "open" },
  isNonInteractive: () => true,
  note: () => {},
  prompt: async () => "",
  selectFromNumberedMenuOrExit: () => { throw new Error("unexpected menu"); },
  makeOnboardCancelExit: () => () => {},
  sandboxCancelRollback: { markCancelled: () => {} },
  useColor: false,
});
(async () => {
  const selected = await setupPoliciesWithSelection(
    {
      policies,
      tiers,
      localInferenceProviders: [],
      step: () => {},
      note: () => {},
      isNonInteractive: () => false,
      waitForSandboxReady: () => true,
      syncPresetSelection,
      selectPolicyTier: async () => "open",
      setPolicyTier: (name, policyTier) => registry.updateSandbox(name, { policyTier }),
      getRecordedPolicyTier: (name) => registry.getSandbox(name)?.policyTier ?? null,
      selectTierPresetsAndAccess: promptHelpers.selectTierPresetsAndAccess,
      parsePolicyPresetEnv: () => [],
      env: {},
    },
    "open-tier-sandbox",
    { agent: "openclaw", disabledChannels: ["teams"] },
  );
  process.stdout.write("\n__RESULT__" + JSON.stringify({
    selected,
    gatewayPresets: policies.getGatewayPresets("open-tier-sandbox"),
    registryPresets: policies.getAppliedPresets("open-tier-sandbox"),
  }));
})().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(1);
});
`;
    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\n'
  cat ${JSON.stringify(gatewayPolicy)}
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      cp "$2" ${JSON.stringify(gatewayPolicy)}
      printf 'Policy version submitted and loaded\n'
      exit 0
    fi
    shift
  done
fi
exit 1
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
        },
      });

      expect(result.status).toBe(0);
      const payload = parseResultPayload(result.stdout);
      expect(payload.selected).toEqual(expect.arrayContaining(DOCUMENTED_OPEN_PRESETS));
      expect(payload.registryPresets).toEqual(expect.arrayContaining(DOCUMENTED_OPEN_PRESETS));
      expect(payload.gatewayPresets).toEqual(expect.arrayContaining(DOCUMENTED_OPEN_PRESETS));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
