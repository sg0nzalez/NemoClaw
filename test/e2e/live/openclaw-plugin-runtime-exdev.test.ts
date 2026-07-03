// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  buildAutoPairApprovalScript,
  readAutoPairApprovalPolicyModule,
} from "../../../src/lib/actions/sandbox/auto-pair-approval.ts";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "../../../src/lib/actions/sandbox/connect-autopair-budget.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { parseJsonFromText } from "./json-envelope.ts";

// Keep this contract as a focused live test: build a deterministic custom plugin
// on top of the complete managed runtime, prove it survives restart/rebuild, then
// run the in-sandbox Node replacement probe that guards #3513/#3127's EXDEV
// cross-device runtime-deps failure mode. No registry or ledger is required.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CUSTOM_DOCKERFILE = path.join(REPO_ROOT, "Dockerfile.e2e-weather-plugin");
const SANDBOX_BASE_IMAGE_REF = "ghcr.io/nvidia/nemoclaw/sandbox-base:v0.0.71";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-openclaw-plugin-exdev";
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const REBUILD_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
validateSandboxName(SANDBOX_NAME);

const EXDEV_PATTERNS = [
  /EXDEV: cross-device link not permitted/i,
  /cross-device link not permitted/i,
];
const GATEWAY_PAIRING_REQUIRED_PATTERN =
  /scope upgrade pending|pairing required|device is not approved/i;
const liveTest = shouldRunLiveE2E() ? test : test.skip;

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function normalizeSandboxStdoutFrames(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\[stdout\]|stdout:)\s*/i, ""))
    .join("\n");
}

function liveEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort: local machines may not have a completed install or an
    // OpenShell gateway yet, and cleanup should not mask the real assertion.
  }
}

type PolicySourcePatch = {
  restore(): void;
  assertRestored(): void;
};

function patchPoliciesForDevShm(): PolicySourcePatch {
  // Test-only source-boundary patch: the default OpenClaw policies intentionally
  // do not grant general /dev access, but this regression needs to create a
  // source tree on tmpfs (/dev/shm) to reproduce #3127's cross-device rename
  // layout. Keep the mutation local, restore and verify the source bytes before
  // writing final artifacts, and remove this patch when OpenShell can mount a
  // dedicated test tmpfs without broadening checked-in production policy.
  const originals = new Map<string, string>();
  for (const policyPath of [
    path.join(REPO_ROOT, "agents", "openclaw", "policy-permissive.yaml"),
    path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
    path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"),
  ]) {
    const text = fs.readFileSync(policyPath, "utf8");
    originals.set(policyPath, text);
    const anchor = "  read_write:\n    - /tmp\n";
    expect(text, `could not find read_write /tmp anchor in ${policyPath}`).toContain(anchor);
    let additions = "";
    for (const entry of ["/dev", "/dev/shm"]) {
      if (!text.includes(`    - ${entry}\n`)) additions += `    - ${entry}\n`;
    }
    if (additions) {
      fs.writeFileSync(policyPath, text.replace(anchor, anchor + additions), "utf8");
    }
  }
  const restore = () => {
    for (const [policyPath, text] of originals) fs.writeFileSync(policyPath, text, "utf8");
  };
  return {
    restore,
    assertRestored: () => {
      for (const [policyPath, text] of originals) {
        expect(fs.readFileSync(policyPath, "utf8"), `${policyPath} was not restored`).toBe(text);
      }
    },
  };
}

function createCustomPluginDockerfile(): () => void {
  const sourceDockerfile = path.join(REPO_ROOT, "Dockerfile");
  const source = fs.readFileSync(sourceDockerfile, "utf8");
  const baseImageAnchor = "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n";
  const runtimeAnchor = "FROM ${BASE_IMAGE}\n";
  expect(
    source.match(/^ARG BASE_IMAGE=ghcr\.io\/nvidia\/nemoclaw\/sandbox-base:latest$/gm)?.length,
  ).toBe(1);
  expect(source.match(/^FROM \$\{BASE_IMAGE\}$/gm)?.length, "expected one runtime stage").toBe(1);

  const runtime = source
    .replace(baseImageAnchor, `ARG BASE_IMAGE=${SANDBOX_BASE_IMAGE_REF}\n`)
    .replace(runtimeAnchor, "FROM ${BASE_IMAGE} AS nemoclaw-runtime\n");
  const extension = String.raw`

# Build the deterministic custom-plugin fixture used by this live contract.
FROM builder AS weather-plugin-builder
WORKDIR /opt/weather
COPY test/e2e/fixtures/plugins/weather/package.json test/e2e/fixtures/plugins/weather/package-lock.json test/e2e/fixtures/plugins/weather/tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY test/e2e/fixtures/plugins/weather/openclaw.plugin.json ./
COPY test/e2e/fixtures/plugins/weather/src/ ./src/
RUN npm run build \
    && npm prune --omit=dev \
    && sha256sum dist/index.js | cut -d ' ' -f 1 > e2e-weather-plugin.sha256

# Extend the completed managed runtime so its entrypoint, health check, config
# generation, and permissions remain the source of truth.
FROM nemoclaw-runtime AS weather-runtime
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/package.json \
    /opt/weather/package-lock.json \
    /opt/weather/openclaw.plugin.json \
    /opt/weather-plugin/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/dist/ /opt/weather-plugin/dist/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/node_modules/ /opt/weather-plugin/node_modules/
COPY --from=weather-plugin-builder \
    /opt/weather/e2e-weather-plugin.sha256 \
    /usr/local/share/nemoclaw/e2e-weather-plugin.sha256

USER sandbox
RUN HOME=/sandbox openclaw plugins install /opt/weather-plugin \
    && HOME=/sandbox openclaw plugins enable weather \
    && HOME=/sandbox openclaw plugins inspect weather --json > /dev/null

# Enabling the plugin changes openclaw.json after the managed runtime hashes it.
# hadolint ignore=DL3002
USER root
RUN chown sandbox:sandbox /sandbox/.openclaw/openclaw.json \
    && chmod 660 /sandbox/.openclaw/openclaw.json \
    && sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chown sandbox:sandbox /sandbox/.openclaw/.config-hash \
    && chmod 660 /sandbox/.openclaw/.config-hash
`;
  fs.writeFileSync(CUSTOM_DOCKERFILE, runtime.trimEnd() + extension, "utf8");
  return () => fs.rmSync(CUSTOM_DOCKERFILE, { force: true });
}

type WeatherPluginInspect = {
  plugin?: { id?: unknown; status?: unknown; toolNames?: unknown };
  tools?: Array<{ names?: unknown }>;
};

type GatewayToolCatalog = {
  groups?: Array<{ tools?: Array<{ id?: unknown }> }>;
};

type GatewayToolInvocation = {
  ok?: unknown;
  toolName?: unknown;
  source?: unknown;
  output?: { details?: unknown };
};

type WeatherRuntimeProof = {
  imageMarker: string;
  inspectLoaded: boolean;
  catalogToolIds: string[];
  toolInvoked: boolean;
};

function gatewayPairingApprovalScript() {
  const policyModule = readAutoPairApprovalPolicyModule();
  if (!policyModule) {
    throw new Error("OpenClaw device approval policy helper is required for the live plugin test");
  }
  return trustedSandboxShellScript(
    buildAutoPairApprovalScript(Buffer.from(policyModule, "utf8").toString("base64"), {
      emitSummary: true,
      budget: {
        maxApprovals: CONNECT_AUTO_PAIR_MAX_APPROVALS,
        listTimeoutS: CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
        approveTimeoutS: CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
      },
    }),
  );
}

async function runGatewayCallWithPairingRetry(
  sandbox: SandboxClient,
  phase: string,
  operation: "catalog" | "invoke",
  script: string,
): Promise<ShellProbeResult> {
  const run = (attempt: number) =>
    sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
      artifactName: `openclaw-weather-plugin-${operation}-${phase}-attempt-${attempt}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

  let result = await run(1);
  if (result.exitCode === 0 || !GATEWAY_PAIRING_REQUIRED_PATTERN.test(resultText(result))) {
    return result;
  }

  const approval = await sandbox.execShell(SANDBOX_NAME, gatewayPairingApprovalScript(), {
    artifactName: `openclaw-weather-plugin-${operation}-${phase}-pairing-approval`,
    env: liveEnv(),
    timeoutMs: CONNECT_AUTO_PAIR_TIMEOUT_MS + 5_000,
  });
  expect(approval.exitCode, resultText(approval)).toBe(0);
  result = await run(2);
  return result;
}

async function assertWeatherPluginRuntime(
  sandbox: SandboxClient,
  phase: string,
): Promise<WeatherRuntimeProof> {
  const imageProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(`set -eu
test -s /tmp/gateway.log
test -s /usr/local/share/nemoclaw/e2e-weather-plugin.sha256
expected=$(cat /usr/local/share/nemoclaw/e2e-weather-plugin.sha256)
actual=$(sha256sum /sandbox/.openclaw/extensions/weather/dist/index.js | cut -d ' ' -f 1)
[ "$expected" = "$actual" ]
printf '%s\\n' "$actual"`),
    {
      artifactName: `openclaw-weather-plugin-image-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(imageProbe.exitCode, resultText(imageProbe)).toBe(0);
  const imageMarker = normalizeSandboxStdoutFrames(imageProbe.stdout).match(
    /(?:^|\n)([a-f0-9]{64})(?:\r?\n|$)/,
  )?.[1];
  expect(imageMarker).toMatch(/^[a-f0-9]{64}$/);

  const inspectProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript("HOME=/sandbox openclaw plugins inspect weather --runtime --json"),
    {
      artifactName: `openclaw-weather-plugin-inspect-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(inspectProbe.exitCode, resultText(inspectProbe)).toBe(0);
  const inspect = parseJsonFromText(
    normalizeSandboxStdoutFrames(inspectProbe.stdout),
  ) as WeatherPluginInspect;
  expect(inspect.plugin?.id).toBe("weather");
  expect(inspect.plugin?.status).toBe("loaded");
  expect(inspect.plugin?.toolNames).toContain("get_weather");
  expect(inspect.tools?.flatMap((tool) => (Array.isArray(tool.names) ? tool.names : []))).toContain(
    "get_weather",
  );

  // Use the sandbox-local gateway address so OpenClaw can synchronously pair
  // this shared-secret CLI client. Invoke first because operator.write also
  // satisfies the catalog's operator.read scope; the reverse order would
  // create a separate asynchronous scope-upgrade request.
  const invokeProbe = await runGatewayCallWithPairingRetry(
    sandbox,
    phase,
    "invoke",
    `. /tmp/nemoclaw-proxy-env.sh && OPENCLAW_GATEWAY_URL="ws://127.0.0.1:\${OPENCLAW_GATEWAY_PORT:-18789}" HOME=/sandbox openclaw gateway call tools.invoke --params '{"agentId":"main","name":"get_weather","args":{"location":"Santa Clara"}}' --json`,
  );
  expect(invokeProbe.exitCode, resultText(invokeProbe)).toBe(0);
  const invocation = parseJsonFromText(
    normalizeSandboxStdoutFrames(invokeProbe.stdout),
  ) as GatewayToolInvocation;
  expect(invocation).toMatchObject({
    ok: true,
    toolName: "get_weather",
    source: "plugin",
    output: {
      details: { location: "Santa Clara", condition: "clear", temperatureC: 21 },
    },
  });

  const catalogProbe = await runGatewayCallWithPairingRetry(
    sandbox,
    phase,
    "catalog",
    `. /tmp/nemoclaw-proxy-env.sh && OPENCLAW_GATEWAY_URL="ws://127.0.0.1:\${OPENCLAW_GATEWAY_PORT:-18789}" HOME=/sandbox openclaw gateway call tools.catalog --params '{"agentId":"main","includePlugins":true}' --json`,
  );
  expect(catalogProbe.exitCode, resultText(catalogProbe)).toBe(0);
  const catalog = parseJsonFromText(
    normalizeSandboxStdoutFrames(catalogProbe.stdout),
  ) as GatewayToolCatalog;
  const catalogToolIds = (catalog.groups ?? []).flatMap((group) =>
    (group.tools ?? []).map((tool) => tool.id).filter((id): id is string => typeof id === "string"),
  );
  expect(catalogToolIds).toContain("get_weather");
  return { imageMarker: imageMarker ?? "", inspectLoaded: true, catalogToolIds, toolInvoked: true };
}

const runtimeDepsReplacementProbeSource = `set -eu
rm -rf /sandbox/.openclaw/plugin-runtime-deps/exdev-guard 2>/dev/null || true
rm -rf /dev/shm/nemoclaw-exdev-source 2>/dev/null || true
mkdir -p /dev/shm/nemoclaw-exdev-source /sandbox/.openclaw/plugin-runtime-deps/exdev-guard
printf 'ok\n' >/dev/shm/nemoclaw-exdev-source/package.txt
source_device=$(stat -c '%d' /dev/shm/nemoclaw-exdev-source)
target_device=$(stat -c '%d' /sandbox/.openclaw/plugin-runtime-deps/exdev-guard)
printf 'source_device=%s target_device=%s\n' "$source_device" "$target_device"
if [ "$source_device" = "$target_device" ]; then
  printf 'EXDEV guard did not get distinct filesystems for /dev/shm and /sandbox plugin-runtime-deps\n' >&2
  exit 2
fi
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
function assertLegacySourceSideStagingFailsWithExdev(targetDir, sourceDir) {
  const sourceParentDir = path.dirname(sourceDir);
  const tempDir = fs.mkdtempSync(path.join(sourceParentDir, '.openclaw-runtime-deps-source-side-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    const sourceDevice = fs.statSync(sourceDir).dev;
    const stagedDevice = fs.statSync(stagedDir).dev;
    const targetParentDevice = fs.statSync(path.dirname(targetDir)).dev;
    if (stagedDevice !== sourceDevice || stagedDevice === targetParentDevice) {
      throw new Error(
        'legacy self-check lost cross-device layout: source=' +
          sourceDevice +
          ' staged=' +
          stagedDevice +
          ' target_parent=' +
          targetParentDevice,
      );
    }
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(stagedDir, targetDir);
      throw new Error('legacy source-side staging unexpectedly renamed across devices');
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        console.log('source-side staging failure self-check completed');
        return;
      }
      throw error;
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.dirname(targetDir), { recursive: true, force: true }); } catch {}
  }
}
function replaceNodeModulesDir(targetDir, sourceDir) {
  const targetParentDir = path.dirname(targetDir);
  fs.mkdirSync(targetParentDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(targetParentDir, '.openclaw-runtime-deps-copy-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}
assertLegacySourceSideStagingFailsWithExdev(
  '/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/source-side-regression/node_modules',
  '/dev/shm/nemoclaw-exdev-source',
);
replaceNodeModulesDir('/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/node_modules', '/dev/shm/nemoclaw-exdev-source');
console.log('runtime deps replacement completed');
NODE`;

const runtimeDepsReplacementProbe = trustedSandboxShellScript(
  `printf '%s' '${Buffer.from(runtimeDepsReplacementProbeSource).toString("base64")}' | base64 -d > /tmp/nemoclaw-exdev-guard.sh && sh /tmp/nemoclaw-exdev-guard.sh`,
);

liveTest(
  "a custom OpenClaw plugin survives restart and rebuild without EXDEV failures (#6108)",
  { timeout: ONBOARD_TIMEOUT_MS + REBUILD_TIMEOUT_MS + 15 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    await artifacts.writeJson("target.json", {
      id: "openclaw-plugin-runtime-exdev",
      runner: "vitest",
      boundary: "fresh-openclaw-sandbox-exec",
      regressionTargets: ["#6108", "#3513", "#3127"],
      contract: [
        "fresh OpenClaw sandbox onboards from a full managed custom-plugin Dockerfile",
        "gateway log, runtime inspection, tools.catalog, and tools.invoke prove weather/get_weather",
        "custom-plugin image provenance and the gateway tool survive restart and rebuild",
        "sandbox proves /dev/shm and plugin-runtime-deps are distinct devices",
        "legacy source-side staging fails with EXDEV across the same /dev/shm to plugin-runtime-deps boundary",
        "OpenClaw-style target-side plugin runtime-deps replacement completes without EXDEV",
      ],
      sandboxBaseImageRef: SANDBOX_BASE_IMAGE_REF,
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-openclaw-plugin-exdev",
      env: liveEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for the OpenClaw plugin EXDEV live guard: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for the OpenClaw plugin EXDEV live guard");
    }

    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "bin/nemoclaw.js missing — run npm run build:cli before this live target",
    ).toBe(true);

    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      const cleanupEnv = liveEnv();
      await ignoreCleanupError(() =>
        host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-openclaw-plugin-exdev",
          env: cleanupEnv,
          timeoutMs: 120_000,
        }),
      );
      await ignoreCleanupError(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-delete-openclaw-plugin-exdev",
          env: cleanupEnv,
          timeoutMs: 60_000,
        }),
      );
    });

    await ignoreCleanupError(() =>
      host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 120_000,
      }),
    );
    await ignoreCleanupError(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-delete-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 60_000,
      }),
    );

    const policySourcePatch = patchPoliciesForDevShm();
    cleanup.add("restore EXDEV policy fixture edits", policySourcePatch.restore);
    const removeCustomDockerfile = createCustomPluginDockerfile();
    cleanup.add("remove custom weather-plugin Dockerfile", removeCustomDockerfile);

    const sandboxEnv = liveEnv({
      COMPATIBLE_API_KEY: "nemoclaw-exdev-dummy-key",
      NEMOCLAW_ENDPOINT_URL: "http://host.openshell.internal:65535/v1",
      NEMOCLAW_MODEL: "nemoclaw-exdev-probe",
      NEMOCLAW_PROVIDER_KEY: "nemoclaw-exdev-dummy-key",
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      NEMOCLAW_SANDBOX_BASE_IMAGE_REF: SANDBOX_BASE_IMAGE_REF,
      NEMOCLAW_POLICY_MODE: "skip",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    });

    const onboard = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
        "--agent",
        "openclaw",
        "--from",
        CUSTOM_DOCKERFILE,
      ],
      {
        artifactName: "openclaw-plugin-exdev-onboard",
        env: sandboxEnv,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const onboardText = resultText(onboard);
    expect(onboard.exitCode, onboardText).toBe(0);
    expect(onboardText).toMatch(/Creating sandbox|Sandbox '.+' created/);
    expect(onboardText).toContain("Deployment verified");

    const weatherAfterOnboard = await assertWeatherPluginRuntime(sandbox, "after-onboard");

    const restart = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "gateway", "restart"],
      {
        artifactName: "openclaw-weather-plugin-gateway-restart",
        env: sandboxEnv,
        timeoutMs: 180_000,
      },
    );
    expect(restart.exitCode, resultText(restart)).toBe(0);
    const weatherAfterRestart = await assertWeatherPluginRuntime(sandbox, "after-restart");
    expect(weatherAfterRestart.imageMarker).toBe(weatherAfterOnboard.imageMarker);

    const rebuild = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "rebuild", "--yes"], {
      artifactName: "openclaw-weather-plugin-rebuild",
      env: sandboxEnv,
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    expect(rebuild.exitCode, resultText(rebuild)).toBe(0);
    const weatherAfterRebuild = await assertWeatherPluginRuntime(sandbox, "after-rebuild");
    expect(weatherAfterRebuild.imageMarker).toBe(weatherAfterOnboard.imageMarker);

    const df = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "df -PT / /tmp /dev/shm /sandbox /sandbox/.openclaw/plugin-runtime-deps",
      ),
      {
        artifactName: "openclaw-plugin-exdev-filesystem-layout",
        env: liveEnv(),
        timeoutMs: 30_000,
      },
    );
    await artifacts.writeText("filesystem-layout.txt", resultText(df));
    expect(df.exitCode, resultText(df)).toBe(0);
    expect(resultText(df)).toContain("/dev/shm");

    const probe = await sandbox.execShell(SANDBOX_NAME, runtimeDepsReplacementProbe, {
      artifactName: "openclaw-plugin-exdev-runtime-deps-replacement",
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const probeText = resultText(probe);
    expect(
      EXDEV_PATTERNS.some((pattern) => pattern.test(probeText)),
      probeText,
    ).toBe(false);
    expect(probe.exitCode, probeText).toBe(0);
    expect(probeText).toMatch(/source_device=\d+ target_device=\d+/);
    expect(probeText).toContain("source-side staging failure self-check completed");
    expect(probeText).toContain("runtime deps replacement completed");

    policySourcePatch.restore();
    policySourcePatch.assertRestored();

    await artifacts.writeJson("target-result.json", {
      id: "openclaw-plugin-runtime-exdev",
      onboardExitCode: onboard.exitCode,
      restartExitCode: restart.exitCode,
      rebuildExitCode: rebuild.exitCode,
      filesystemProbeExitCode: df.exitCode,
      runtimeDepsProbeExitCode: probe.exitCode,
      assertions: {
        weatherAfterOnboard:
          weatherAfterOnboard.inspectLoaded &&
          weatherAfterOnboard.catalogToolIds.includes("get_weather") &&
          weatherAfterOnboard.toolInvoked,
        weatherAfterRestart:
          weatherAfterRestart.inspectLoaded &&
          weatherAfterRestart.catalogToolIds.includes("get_weather") &&
          weatherAfterRestart.toolInvoked,
        weatherAfterRebuild:
          weatherAfterRebuild.inspectLoaded &&
          weatherAfterRebuild.catalogToolIds.includes("get_weather") &&
          weatherAfterRebuild.toolInvoked,
        imageMarkerStable:
          weatherAfterOnboard.imageMarker === weatherAfterRestart.imageMarker &&
          weatherAfterRestart.imageMarker === weatherAfterRebuild.imageMarker,
        distinctDevices: /source_device=\d+ target_device=\d+/.test(probeText),
        sourceSideExdevSelfCheck: probeText.includes(
          "source-side staging failure self-check completed",
        ),
        noExdevSignature: !EXDEV_PATTERNS.some((pattern) => pattern.test(probeText)),
        successMarker: probeText.includes("runtime deps replacement completed"),
        policySourcesRestored: true,
      },
    });
  },
);
