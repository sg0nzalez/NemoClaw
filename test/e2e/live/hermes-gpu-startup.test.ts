// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  type HostCliClient,
  resultText,
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import { assertHermesGpuStartupProof } from "./hermes-gpu-startup-proof.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-gpu-startup";
const FAKE_API_KEY = "e2e-hermes-gpu-startup-key";
const FAKE_MODEL = "test-model";
const LIVE_TIMEOUT_MS = 70 * 60_000;
validateSandboxName(SANDBOX_NAME);

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_GPU: "1",
    NEMOCLAW_DOCKER_GPU_PATCH: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS: "60",
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup and failure diagnostics must not mask the primary live-test result.
  }
}

async function cleanupHermes(
  host: HostCliClient,
  sandbox: SandboxClient,
  label: string,
): Promise<void> {
  await bestEffort(() =>
    host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: `${label}-nemoclaw-destroy`,
      env: commandEnv(),
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: `${label}-openshell-sandbox-delete`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${label}-openshell-gateway-destroy`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

test.skipIf(!shouldRunLiveE2E())(
  "hermes-gpu-startup: GPU-recreated OpenShell supervision reaches stable Ready state",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox }) => {
    await artifacts.writeJson("target.json", {
      id: "hermes-gpu-startup",
      runner: "vitest",
      boundary: "install.sh --non-interactive --fresh + Hermes GPU-supervised startup",
      sandboxName: SANDBOX_NAME,
      inference: "hermetic fake OpenAI-compatible endpoint",
    });

    await cleanupHermes(host, sandbox, "pre-cleanup");

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "phase-1-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(dockerInfo.exitCode, resultText(dockerInfo)).toBe(0);

    const hostAddressProbe = await host.command(
      "bash",
      [
        "-lc",
        [
          'ip_addr="$(ip route get 1.1.1.1 2>/dev/null | awk \'{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}\')"',
          'test -n "$ip_addr" || ip_addr="$(hostname -I 2>/dev/null | awk \'{print $1}\')"',
          'test -n "$ip_addr"',
          'printf "%s\\n" "$ip_addr"',
        ].join("\n"),
      ],
      {
        artifactName: "phase-1-sandbox-reachable-host-address",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(hostAddressProbe.exitCode, resultText(hostAddressProbe)).toBe(0);
    const hostAddress = hostAddressProbe.stdout.trim().split(/\s+/)[0];
    expect(hostAddress).toBeTruthy();

    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: FAKE_API_KEY,
      host: "0.0.0.0",
      model: FAKE_MODEL,
      publicHost: hostAddress,
      requireAuth: true,
    });
    cleanup.add("close fake OpenAI-compatible endpoint", async () => {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
      await fake.close();
    });
    cleanup.add(`destroy Hermes sandbox ${SANDBOX_NAME}`, async () => {
      await cleanupHermes(host, sandbox, "cleanup");
    });
    await artifacts.writeJson("fake-openai-compatible.json", {
      baseUrl: fake.baseUrl,
      model: FAKE_MODEL,
      publicHost: hostAddress,
    });

    const env = commandEnv({
      COMPATIBLE_API_KEY: FAKE_API_KEY,
      NEMOCLAW_COMPAT_MODEL: FAKE_MODEL,
      NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
      NEMOCLAW_MODEL: FAKE_MODEL,
      NEMOCLAW_POLICY_MODE: "suggested",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    });
    const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
      artifactName: "phase-2-install-hermes-gpu-startup",
      cwd: REPO_ROOT,
      env,
      redactionValues: [FAKE_API_KEY],
      timeoutMs: 60 * 60_000,
    });
    await (install.exitCode === 0
      ? Promise.resolve()
      : bestEffort(() =>
          sandbox.execShell(
            SANDBOX_NAME,
            trustedSandboxShellScript(
              String.raw`printf '%s\n' '== pid 1 =='; tr '\0' ' ' </proc/1/cmdline 2>/dev/null || true; printf '\n%s\n' '== process tree =='; ps -eo user=,pid=,ppid=,stat=,args= 2>&1 || true; printf '%s\n' '== entrypoint log =='; tail -n 300 /tmp/nemoclaw-start.log 2>&1 || true`,
            ),
            {
              artifactName: "phase-2-hermes-gpu-startup-failure-diagnostics",
              env: commandEnv(),
              redactionValues: [FAKE_API_KEY],
              timeoutMs: 30_000,
            },
          ),
        ));
    expect(install.exitCode, resultText(install)).toBe(0);

    const status = await host.command("nemoclaw", [SANDBOX_NAME, "status"], {
      artifactName: "phase-3-nemoclaw-status",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(status.exitCode, resultText(status)).toBe(0);

    await assertHermesGpuStartupProof({
      env: commandEnv(),
      host,
      install,
      sandbox,
      sandboxName: SANDBOX_NAME,
      status,
    });

    await artifacts.writeJson("target-result.json", {
      id: "hermes-gpu-startup",
      assertions: {
        gpuPatchSelected: true,
        openshellReady: true,
        sandboxCudaVerified: true,
        stableSingleContainer: true,
        startupConfigHashesValid: true,
        supervisorTopologyValid: true,
      },
    });
  },
);
