// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test as base, expect } from "vitest";

import {
  appendResourcePhaseBaseline,
  collectResourceSnapshot,
} from "../../../tools/e2e/runner-pressure.mts";
import { renderSnapshotLine } from "../../../tools/e2e/runner-pressure-core.mts";

import { type ArtifactSink, createArtifactSink } from "./artifacts.ts";
import { assertCleanupPassed, CleanupRegistry } from "./cleanup.ts";
import {
  GatewayClient,
  HostCliClient,
  ProviderClient,
  SandboxClient,
  StateClient,
} from "./clients/index.ts";
import { DockerPrerequisite, DockerProbe } from "./docker-probe.ts";
import { createE2EInferenceAdapter, type E2EInferenceAdapter } from "./inference-adapter.ts";
import {
  EnvironmentPhaseFixture,
  LifecyclePhaseFixture,
  OnboardingPhaseFixture,
  RuntimePhaseFixture,
  StateValidationPhaseFixture,
} from "./phases/index.ts";
import { startTestProgress, type TestProgress } from "./progress.ts";
import { SecretStore } from "./secrets.ts";
import { ShellProbe } from "./shell-probe.ts";

export interface E2ETargetFixtures {
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  secrets: SecretStore;
  docker: DockerPrerequisite;
  shellProbe: ShellProbe;
  host: HostCliClient;
  gateway: GatewayClient;
  sandbox: SandboxClient;
  provider: ProviderClient;
  inference: E2EInferenceAdapter;
  state: StateClient;
  environment: EnvironmentPhaseFixture;
  onboard: OnboardingPhaseFixture;
  lifecycle: LifecyclePhaseFixture;
  runtime: RuntimePhaseFixture;
  stateValidation: StateValidationPhaseFixture;
  progress: TestProgress;
}

function resourcePhaseLabel(targetId: string, phase: string): string {
  const suffix = phase
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return `${targetId}.${suffix}`;
}

export const test = base.extend<E2ETargetFixtures>({
  secrets: async ({ skip }, use) => {
    await use(new SecretStore(process.env, skip));
  },
  artifacts: async ({ task, secrets }, use) => {
    const artifacts = createArtifactSink(task.name, process.cwd(), secrets.redactionValues());
    await artifacts.ensureRoot();
    try {
      await use(artifacts);
    } finally {
      await artifacts.writeJson("artifact-summary.json", {
        test: task.name,
        rootDir: artifacts.rootDir,
      });
    }
  },
  progress: [
    async ({ artifacts, secrets, task }, use) => {
      const targetId = process.env.E2E_TARGET_ID;
      const baselinePath = process.env.E2E_RESOURCE_PHASE_BASELINES_FILE;
      const progress = startTestProgress(task.name, "test body", {
        logLine:
          process.env.NEMOCLAW_RUN_LIVE_E2E === "1"
            ? (line) => process.stdout.write(`${secrets.redact(line)}\n`)
            : () => {
                // Keep fixture and support tests quiet; live runs need the heartbeat.
              },
        ...(targetId && baselinePath
          ? {
              sampleResourceEvidence: (phase: string) =>
                renderSnapshotLine(collectResourceSnapshot(resourcePhaseLabel(targetId, phase))),
              recordResourceBaseline: (phase: string) =>
                appendResourcePhaseBaseline(baselinePath, resourcePhaseLabel(targetId, phase)),
            }
          : {}),
      });
      try {
        await use(progress);
      } finally {
        progress.stop();
        await artifacts.writeJson("test-progress.json", {
          ...progress.summary(),
          ...(process.env.E2E_TARGET_ID ? { targetId: process.env.E2E_TARGET_ID } : {}),
          ...(process.env.NEMOCLAW_E2E_SHARD ? { shardId: process.env.NEMOCLAW_E2E_SHARD } : {}),
        });
      }
    },
    { auto: true },
  ],
  docker: async ({ artifacts, secrets, skip }, use) => {
    const probe = new DockerProbe(artifacts, (text, extra) => secrets.redact(text, extra));
    await use(new DockerPrerequisite(probe, skip));
  },
  cleanup: async ({ artifacts, secrets }, use) => {
    const cleanup = new CleanupRegistry((text) => secrets.redact(text));
    try {
      await use(cleanup);
    } finally {
      const result = await cleanup.runAll();
      await artifacts.writeJson("cleanup.json", result);
      assertCleanupPassed(result);
    }
  },
  shellProbe: async ({ artifacts, progress, secrets, signal }, use) => {
    await use(
      new ShellProbe({
        artifacts,
        redact: (text, extraValues) => secrets.redact(text, extraValues),
        signal,
        onOutput: progress.onOutput,
        onActivity: progress.activity,
      }),
    );
  },
  host: async ({ shellProbe }, use) => {
    await use(new HostCliClient(shellProbe));
  },
  sandbox: async ({ shellProbe }, use) => {
    await use(new SandboxClient(shellProbe));
  },
  gateway: async ({ host, sandbox }, use) => {
    // GatewayClient depends on `sandbox` for in-sandbox probes
    // (guard-chain inspection, log tailing, gateway-PID polling).
    // The fixture chain is sandbox → gateway so the dependency stays acyclic.
    await use(new GatewayClient(host, sandbox));
  },
  provider: async ({ shellProbe }, use) => {
    await use(new ProviderClient(shellProbe));
  },
  inference: async ({ artifacts, provider, secrets }, use) => {
    const inference = await createE2EInferenceAdapter({ artifacts, provider, secrets });
    try {
      await use(inference);
    } finally {
      await inference.close();
    }
  },
  state: async ({}, use) => {
    await use(new StateClient());
  },
  environment: async ({ artifacts, host }, use) => {
    await use(new EnvironmentPhaseFixture(host, artifacts));
  },
  onboard: async ({ artifacts, cleanup, host, secrets }, use) => {
    await use(new OnboardingPhaseFixture(host, secrets, cleanup, artifacts));
  },
  lifecycle: async ({ cleanup, gateway, host, sandbox }, use) => {
    await use(new LifecyclePhaseFixture(host, sandbox, cleanup, gateway));
  },
  runtime: async ({ provider, sandbox }, use) => {
    await use(new RuntimePhaseFixture(sandbox, provider));
  },
  stateValidation: async ({ artifacts, host, gateway, sandbox }, use) => {
    await use(new StateValidationPhaseFixture(host, gateway, sandbox, {}, artifacts));
  },
});

export { expect };
