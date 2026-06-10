// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { ScenarioEnvironment } from "../scenarios/types.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME || "e2e-openclaw-plugin-exdev";
const DEFAULT_ONBOARD_TIMEOUT_MS = 25 * 60_000;
const DEFAULT_DESTROY_TIMEOUT_MS = 5 * 60_000;
const POLICY_READ_WRITE_TMP_ANCHOR = "  read_write:\n    - /tmp\n";
const SHARED_MEMORY_POLICY_ENTRIES = ["/dev", "/dev/shm"] as const;
const POLICY_PATHS = [
  "agents/openclaw/policy-permissive.yaml",
  "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
  "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
];
const ENVIRONMENT: ScenarioEnvironment = {
  platform: "ubuntu",
  install: "repo-current",
  runtime: "docker-running",
  onboarding: "cloud-openclaw",
};

interface PolicyPatch {
  restore(): Promise<void>;
}

async function stageSharedMemoryPolicyAccess(): Promise<PolicyPatch> {
  const originals = await Promise.all(
    POLICY_PATHS.map(async (relativePath) => ({
      path: path.join(REPO_ROOT, relativePath),
      text: await readFile(path.join(REPO_ROOT, relativePath), "utf8"),
    })),
  );

  const patched = originals.map((entry) => {
    if (!entry.text.includes(POLICY_READ_WRITE_TMP_ANCHOR)) {
      throw new Error(`could not find read_write /tmp anchor in ${entry.path}`);
    }
    const additions = SHARED_MEMORY_POLICY_ENTRIES.filter(
      (sharedPath) => !entry.text.includes(`    - ${sharedPath}\n`),
    )
      .map((sharedPath) => `    - ${sharedPath}\n`)
      .join("");
    return {
      ...entry,
      text: additions
        ? entry.text.replace(POLICY_READ_WRITE_TMP_ANCHOR, POLICY_READ_WRITE_TMP_ANCHOR + additions)
        : entry.text,
    };
  });

  const written: string[] = [];
  try {
    for (const entry of patched) {
      await writeFile(entry.path, entry.text, "utf8");
      written.push(entry.path);
    }
  } catch (error) {
    await Promise.all(
      originals
        .filter((entry) => written.includes(entry.path))
        .map((entry) => writeFile(entry.path, entry.text, "utf8")),
    );
    throw error;
  }

  return {
    restore: async () => {
      await Promise.all(originals.map((entry) => writeFile(entry.path, entry.text, "utf8")));
    },
  };
}

function onboardEnv(apiKey: string): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_PROVIDER: "build",
    NEMOCLAW_PROVIDER_KEY: apiKey,
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NVIDIA_API_KEY: apiKey,
  };
}

function pluginRuntimeDepsReplacementCommand(): string[] {
  const script = `set -eu
rm -rf /sandbox/.openclaw/plugin-runtime-deps/exdev-guard 2>/dev/null || true
rm -rf /dev/shm/nemoclaw-exdev-source 2>/dev/null || true
mkdir -p /dev/shm/nemoclaw-exdev-source
printf 'ok\\n' >/dev/shm/nemoclaw-exdev-source/package.txt
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

function replaceNodeModulesDir(targetDir, sourceDir) {
  const parentDir = path.dirname(sourceDir);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(parentDir, '.openclaw-runtime-deps-copy-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

replaceNodeModulesDir(
  '/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/node_modules',
  '/dev/shm/nemoclaw-exdev-source',
);
console.log('runtime deps replacement completed');
NODE
`;
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return [
    "sh",
    "-lc",
    `printf '%s' '${encoded}' | base64 -d > /tmp/nemoclaw-exdev-guard.sh && sh /tmp/nemoclaw-exdev-guard.sh`,
  ];
}

test("openclaw plugin runtime deps replacement crosses sandbox filesystems", async ({
  artifacts,
  cleanup,
  environment,
  host,
  sandbox,
  secrets,
}) => {
  const apiKey = secrets.required("NVIDIA_API_KEY");
  const policyPatch = await stageSharedMemoryPolicyAccess();
  cleanup.add("restore OpenClaw shared-memory policy test patch", policyPatch.restore);
  cleanup.add(`destroy NemoClaw sandbox ${SANDBOX_NAME}`, async () => {
    try {
      await host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "cleanup-destroy-openclaw-plugin-runtime-exdev",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: DEFAULT_DESTROY_TIMEOUT_MS,
      });
    } catch {
      // Best-effort cleanup: preserve the primary test failure if the CLI is
      // unavailable before onboarding has created anything to destroy.
    }
  });

  await artifacts.writeJson("scenario.json", {
    id: "openclaw-plugin-runtime-exdev",
    runner: "vitest",
    boundary: "openclaw-plugin-runtime-deps-exdev",
    legacyScript: "test/e2e/test-openclaw-plugin-runtime-exdev.sh",
  });

  await environment.assertReady(ENVIRONMENT);
  await rm(path.join(homedir(), ".nemoclaw", "onboard.lock"), { force: true });
  await host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: "preclean-destroy-openclaw-plugin-runtime-exdev",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: DEFAULT_DESTROY_TIMEOUT_MS,
  });

  const onboard = await host.nemoclaw(
    [
      "onboard",
      "--fresh",
      "--non-interactive",
      "--yes",
      "--yes-i-accept-third-party-software",
      "--agent",
      "openclaw",
      "--from",
      DOCKERFILE,
    ],
    {
      artifactName: "openclaw-plugin-runtime-exdev-onboard",
      env: onboardEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: DEFAULT_ONBOARD_TIMEOUT_MS,
    },
  );
  assertExitZero(onboard, "fresh OpenClaw sandbox onboard");

  await sandbox.exec(
    SANDBOX_NAME,
    ["df", "-PT", "/", "/tmp", "/dev/shm", "/sandbox", "/sandbox/.openclaw/plugin-runtime-deps"],
    {
      artifactName: "openclaw-plugin-runtime-exdev-filesystems",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );

  const replacement = await sandbox.exec(SANDBOX_NAME, pluginRuntimeDepsReplacementCommand(), {
    artifactName: "openclaw-plugin-runtime-exdev-replacement",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  const replacementOutput = `${replacement.stdout}\n${replacement.stderr}`;

  expect(replacementOutput).not.toMatch(
    /EXDEV: cross-device link not permitted|cross-device link not permitted/i,
  );
  expect(replacement.exitCode).toBe(0);
  expect(replacementOutput).toContain("runtime deps replacement completed");

  await artifacts.writeJson("scenario-result.json", {
    id: "openclaw-plugin-runtime-exdev",
    sandboxName: SANDBOX_NAME,
    result: "passed",
  });
});
