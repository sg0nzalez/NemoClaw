// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type HostCliClient, resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_PODMAN_E2E_SANDBOX_NAME ?? "e2e-podman-runtime";
const PODMAN_GATEWAY_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "nemoclaw",
  "openshell-podman-gateway",
);
const TEST_TIMEOUT_MS = 75 * 60_000;
const liveTest = shouldRunLiveE2E() ? test : test.skip;

validateSandboxName(SANDBOX_NAME);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_GATEWAY_RUNTIME: "podman",
    NEMOCLAW_SANDBOX_GPU: "0",
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

async function command(
  host: HostCliClient,
  args: string[],
  options: { artifactName: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    artifactName: options.artifactName,
    env: options.env ?? env(),
    timeoutMs: options.timeoutMs,
  });
}

function podmanRequired(): boolean {
  return process.env.GITHUB_ACTIONS === "true" || process.env.NEMOCLAW_E2E_REQUIRE_PODMAN === "1";
}

async function requireRootlessPodman(
  host: HostCliClient,
  skip: (note?: string) => never,
): Promise<void> {
  const info = await host.command(
    "bash",
    [
      "-lc",
      "command -v podman >/dev/null 2>&1 || exit 127; podman info --format '{{.Host.Security.Rootless}} {{.Host.CgroupVersion}}'",
    ],
    {
      artifactName: "prereq-podman-info",
      env: env(),
      timeoutMs: 30_000,
    },
  );
  if (info.exitCode !== 0) {
    if (podmanRequired()) throw new Error(`Podman is required:\n${resultText(info)}`);
    skip(`Podman is required for podman-gateway-runtime E2E: ${resultText(info)}`);
  }
  const text = info.stdout.trim().toLowerCase();
  if (!/^true\s+v?2\b/.test(text)) {
    const message = `Rootless Podman with cgroups v2 is required; got ${JSON.stringify(text)}`;
    if (podmanRequired()) throw new Error(message);
    skip(message);
  }
}

async function cleanupPodmanRuntime(host: HostCliClient): Promise<void> {
  await command(host, [SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"], {
    artifactName: "cleanup-nemoclaw-destroy-podman",
    env: env(),
    timeoutMs: 180_000,
  }).catch(() => undefined);
  await host
    .command("openshell", ["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete-podman",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await host
    .command("openshell", ["gateway", "remove", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-remove-podman",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
}

liveTest(
  "podman gateway runtime onboards a real sandbox through rootless Podman",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, skip }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI targets",
    ).toBe(true);
    await requireRootlessPodman(host, skip);
    cleanup.add("remove Podman gateway runtime sandbox", () => cleanupPodmanRuntime(host));

    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: "dummy",
      host: "0.0.0.0",
      model: "test-model",
      publicHost: "host.openshell.internal",
      requireAuth: false,
    });
    cleanup.add("close Podman fake OpenAI-compatible endpoint", async () => {
      await artifacts.writeJson("fake-openai-requests.json", fake.requests());
      await fake.close();
    });

    await artifacts.writeJson("target.json", {
      id: "podman-gateway-runtime",
      sandboxName: SANDBOX_NAME,
      boundary: "real-nemoclaw-onboard-openshell-podman-driver-rootless-podman",
      contracts: [
        "NEMOCLAW_GATEWAY_RUNTIME=podman selects the Podman gateway runtime",
        "onboard creates a real OpenShell sandbox through the Podman compute driver",
        'generated gateway config uses compute_drivers = ["podman"] with TLS and auth enabled',
      ],
    });

    await cleanupPodmanRuntime(host);

    const onboard = await command(host, ["onboard", "--non-interactive", "--yes", "--no-gpu"], {
      artifactName: "onboard-podman-runtime",
      env: env({
        COMPATIBLE_API_KEY: "dummy",
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
        NEMOCLAW_MODEL: "test-model",
        NEMOCLAW_PREFERRED_API: "openai-completions",
      }),
      timeoutMs: 45 * 60_000,
    });
    expect(onboard.exitCode, resultText(onboard)).toBe(0);
    expect(resultText(onboard)).toContain("Container runtime: podman");
    expect(resultText(onboard)).toMatch(
      /Podman-driver gateway is healthy|Reusing existing Podman-driver gateway/,
    );

    const sandboxStatus = await host.command("openshell", ["sandbox", "status", SANDBOX_NAME], {
      artifactName: "podman-openshell-sandbox-status",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(sandboxStatus.exitCode, resultText(sandboxStatus)).toBe(0);
    expect(resultText(sandboxStatus)).toMatch(/Ready|Running/i);

    const configPath = path.join(PODMAN_GATEWAY_STATE_DIR, "openshell-gateway.toml");
    const runtimePath = path.join(PODMAN_GATEWAY_STATE_DIR, "runtime.json");
    const config = await host.command("bash", ["-lc", `cat ${JSON.stringify(configPath)}`], {
      artifactName: "podman-gateway-config",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(config.exitCode, resultText(config)).toBe(0);
    expect(config.stdout).toContain('compute_drivers = ["podman"]');
    expect(config.stdout).toContain("[openshell.gateway.mtls_auth]");
    expect(config.stdout).toContain("allow_unauthenticated_users = false");

    const marker = await host.command("bash", ["-lc", `cat ${JSON.stringify(runtimePath)}`], {
      artifactName: "podman-gateway-runtime-marker",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(marker.exitCode, resultText(marker)).toBe(0);
    expect(marker.stdout).toContain('"driver": "podman"');
  },
);
