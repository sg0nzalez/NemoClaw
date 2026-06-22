// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DockerProbe, resultText, type DockerCommandResult } from "../fixtures/docker-probe.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

// Migrated from test/e2e/test-hermes-root-entrypoint-smoke.sh. This remains a
// real Docker/root-entrypoint smoke: it builds the Hermes image when no prebuilt
// NEMOCLAW_HERMES_TEST_IMAGE is supplied, starts /usr/local/bin/nemoclaw-start
// as root, and verifies health, gateway privilege separation, runtime layout,
// sticky config protection, and legacy gateway.pid symlink migration.

const HEALTH_ATTEMPTS = 90;
const HEALTH_POLL_MS = 2_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 60_000;

const liveTest = process.env.NEMOCLAW_RUN_E2E_SCENARIOS === "1" ? test : test.skip;

function safeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

async function requireDocker(probe: DockerProbe, skip: (message: string) => void): Promise<void> {
  const result = await probe.run(["info"], { artifactName: "docker-info", timeoutMs: 30_000 });
  if (result.exitCode === 0) return;

  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error(`Docker is required for Hermes root-entrypoint smoke:\n${resultText(result)}`);
  }
  skip("Docker daemon is required for Hermes root-entrypoint smoke");
}

async function buildImageIfNeeded(
  probe: DockerProbe,
  image: string,
  baseImage: string,
): Promise<void> {
  if (process.env.NEMOCLAW_HERMES_TEST_IMAGE) {
    await probe.expect(["image", "inspect", image], {
      artifactName: "inspect-prebuilt-hermes-image",
      timeoutMs: 30_000,
    });
    return;
  }

  await probe.expect(["build", "-f", "agents/hermes/Dockerfile.base", "-t", baseImage, "."], {
    artifactName: "build-hermes-base-image",
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  await probe.expect(
    [
      "build",
      "-f",
      "agents/hermes/Dockerfile",
      "--build-arg",
      `BASE_IMAGE=${baseImage}`,
      "-t",
      image,
      ".",
    ],
    { artifactName: "build-hermes-production-image", timeoutMs: BUILD_TIMEOUT_MS },
  );
}

async function dockerExecSh(
  probe: DockerProbe,
  container: string,
  script: string,
  artifactName: string,
): Promise<DockerCommandResult> {
  return probe.run(["exec", container, "sh", "-lc", script], { artifactName });
}

async function expectContainerSh(
  probe: DockerProbe,
  container: string,
  message: string,
  script: string,
): Promise<DockerCommandResult> {
  const result = await dockerExecSh(probe, container, script, message);
  expect(result.exitCode, `${container}: ${message}\n${resultText(result)}`).toBe(0);
  return result;
}

async function expectContainerShFails(
  probe: DockerProbe,
  container: string,
  message: string,
  script: string,
): Promise<void> {
  const result = await dockerExecSh(probe, container, script, message);
  expect(result.exitCode, `${container}: ${message}\n${resultText(result)}`).not.toBe(0);
}

async function copyStoppedContainerFile(
  probe: DockerProbe,
  artifacts: ArtifactSink,
  redact: (text: string) => string,
  container: string,
  containerPath: string,
  artifactName: string,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-root-smoke-diag-"));
  const dest = path.join(tmp, path.basename(containerPath));
  try {
    const copied = await probe.run(["cp", `${container}:${containerPath}`, dest], {
      artifactName: `diag-${container}-${artifactName}-copy`,
      timeoutMs: 30_000,
    });
    await (copied.exitCode === 0
      ? artifacts.writeText(
          `docker/diag-${container}-${artifactName}.txt`,
          redact(fs.readFileSync(dest, "utf-8")),
        )
      : Promise.resolve());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function dumpContainerDiagnostics(
  probe: DockerProbe,
  artifacts: ArtifactSink,
  redact: (text: string) => string,
  container: string,
): Promise<void> {
  const inspect = await probe.run(["inspect", container], {
    artifactName: `diag-${container}-inspect`,
    timeoutMs: 30_000,
  });
  if (inspect.exitCode !== 0) return;

  await probe.run(
    [
      "ps",
      "-a",
      "--filter",
      `name=^/${container}$`,
      "--format",
      "table {{.Names}}\t{{.Status}}\t{{.Image}}",
    ],
    { artifactName: `diag-${container}-ps`, timeoutMs: 30_000 },
  );
  await probe.run(["logs", container], {
    artifactName: `diag-${container}-logs`,
    timeoutMs: 30_000,
  });
  await copyStoppedContainerFile(
    probe,
    artifacts,
    redact,
    container,
    "/tmp/nemoclaw-start.log",
    "start-log",
  );
  await copyStoppedContainerFile(
    probe,
    artifacts,
    redact,
    container,
    "/tmp/gateway.log",
    "gateway-log",
  );
  await probe.run(
    [
      "exec",
      container,
      "sh",
      "-lc",
      [
        "set +e",
        'echo "== identity =="',
        "id",
        'echo "== hermes tree =="',
        "ls -ld /sandbox/.hermes /sandbox/.hermes/runtime /sandbox/.hermes/logs /sandbox/.hermes/logs/curator /sandbox/.hermes/hooks /sandbox/.hermes/image_cache /sandbox/.hermes/audio_cache 2>&1",
        "ls -l /sandbox/.hermes/gateway.pid /sandbox/.hermes/runtime/gateway.pid /sandbox/.hermes/config.yaml 2>&1",
        'echo "== processes =="',
        'ps -eo user=,pid=,args= | grep -E "hermes|socat" | grep -v grep',
        'echo "== start log =="',
        "tail -n 120 /tmp/nemoclaw-start.log 2>&1",
        'echo "== gateway log =="',
        "tail -n 160 /tmp/gateway.log 2>&1",
      ].join("; "),
    ],
    { artifactName: `diag-${container}-runtime`, timeoutMs: 30_000 },
  );
}

async function waitForHealth(probe: DockerProbe, container: string): Promise<void> {
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++) {
    const health = await dockerExecSh(
      probe,
      container,
      "curl -sf --max-time 2 http://127.0.0.1:8642/health",
      `${container}-health-${attempt}`,
    );
    if (health.exitCode === 0) {
      expect(health.stdout, `${container}: health response did not report status ok`).toMatch(
        /"status"\s*:\s*"ok"/,
      );
      expect(health.stdout, `${container}: health response did not report Hermes platform`).toMatch(
        /"platform"\s*:\s*"hermes-agent"/,
      );
      return;
    }

    const running = await probe.run(["inspect", "-f", "{{.State.Running}}", container], {
      artifactName: `${container}-running-${attempt}`,
      timeoutMs: 30_000,
    });
    if (running.stdout.trim() !== "true") {
      throw new Error(
        `${container}: container exited before health became ready\n${resultText(running)}`,
      );
    }
    await delay(HEALTH_POLL_MS);
  }

  throw new Error(`${container}: Hermes health did not become ready`);
}

async function assertGatewayLogClean(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "gateway log contains PID race failure",
    "test -r /tmp/gateway.log && ! grep -F 'PID file race lost' /tmp/gateway.log",
  );
  await expectContainerSh(
    probe,
    container,
    "gateway log contains config load failure",
    "test -r /tmp/gateway.log && ! grep -F 'Could not load config.yaml' /tmp/gateway.log",
  );
}

async function assertRuntimeLayout(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes config root mode is not 3770",
    "[ \"$(stat -c '%a' /sandbox/.hermes)\" = '3770' ]",
  );
  await expectContainerSh(
    probe,
    container,
    "required Hermes v0.14 directories are missing",
    'for dir in hooks image_cache audio_cache logs/curator; do test -d "/sandbox/.hermes/$dir"; done',
  );
  await expectContainerSh(
    probe,
    container,
    "gateway user cannot write required Hermes v0.14 directories",
    'gosu gateway sh -lc \'for dir in hooks image_cache audio_cache logs/curator; do p="/sandbox/.hermes/$dir/.nemoclaw-write-test"; : >"$p" && rm -f "$p"; done\'',
  );
  await expectContainerSh(
    probe,
    container,
    "gateway.pid is not a regular top-level file",
    "test -f /sandbox/.hermes/gateway.pid && test ! -L /sandbox/.hermes/gateway.pid",
  );
  await expectContainerShFails(
    probe,
    container,
    "gateway user was able to remove config.yaml",
    "gosu gateway rm /sandbox/.hermes/config.yaml",
  );
  await expectContainerSh(
    probe,
    container,
    "config.yaml disappeared after gateway remove attempt",
    "test -f /sandbox/.hermes/config.yaml",
  );
}

async function assertConfigHashContract(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes strict config hash is not a root-owned read-only trust anchor",
    "test \"$(stat -c '%u:%g %a' /etc/nemoclaw/hermes.config-hash)\" = '0:0 444'",
  );
  await expectContainerSh(
    probe,
    container,
    "Hermes strict config hash does not validate as sandbox user",
    "gosu sandbox sha256sum -c /etc/nemoclaw/hermes.config-hash --status",
  );
  await expectContainerSh(
    probe,
    container,
    "Hermes config or env file mode drifted after image startup",
    "test \"$(stat -c '%U:%G %a' /sandbox/.hermes/config.yaml)\" = 'sandbox:sandbox 640' && test \"$(stat -c '%U:%G %a' /sandbox/.hermes/.env)\" = 'sandbox:sandbox 640'",
  );
}

async function assertBuiltImageRuntimeSurfaces(
  probe: DockerProbe,
  container: string,
): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes API bearer token is missing or does not authenticate /v1/models",
    [
      "key=$(awk -F= '$1 == \"API_SERVER_KEY\" { print $2; exit }' /sandbox/.hermes/.env)",
      'test -n "$key"',
      'curl -sf --max-time 5 -H "Authorization: Bearer ${key}" http://127.0.0.1:8642/v1/models >/tmp/hermes-models.json',
      "grep -q 'object' /tmp/hermes-models.json",
    ].join("; "),
  );
  await expectContainerSh(
    probe,
    container,
    "Hermes dashboard config/env were not seeded from the gateway boundary",
    [
      "test -s /sandbox/.hermes/dashboard-home/config.yaml",
      "grep -F 'custom_providers:' /sandbox/.hermes/dashboard-home/config.yaml",
      "grep -F 'model:' /sandbox/.hermes/dashboard-home/config.yaml",
      "test -s /sandbox/.hermes/dashboard-home/.env",
      "grep -E '^API_SERVER_KEY=' /sandbox/.hermes/dashboard-home/.env",
      'awk -F= \'BEGIN{ok["API_SERVER_HOST"];ok["API_SERVER_PORT"];ok["API_SERVER_KEY"];ok["NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER"];ok["FIRECRAWL_GATEWAY_URL"];ok["OPENAI_AUDIO_GATEWAY_URL"];ok["BROWSER_USE_GATEWAY_URL"];ok["FAL_QUEUE_GATEWAY_URL"];ok["MODAL_GATEWAY_URL"]} /^[A-Za-z_][A-Za-z0-9_]*=/ && !($1 in ok){bad=1} END{exit bad ? 1 : 0}\' /sandbox/.hermes/dashboard-home/.env',
    ].join("; "),
  );
  await expectContainerSh(
    probe,
    container,
    "python-multipart is missing from the Hermes virtualenv",
    "/opt/hermes/.venv/bin/python -c 'import multipart'",
  );
  await expectContainerSh(
    probe,
    container,
    "Hermes image cannot allocate a PTY through /dev/pts",
    "/opt/hermes/.venv/bin/python -c 'import os,pty; pid,fd=pty.fork(); os._exit(0) if pid == 0 else (os.close(fd), os.waitpid(pid, 0))'",
  );
  await expectContainerSh(
    probe,
    container,
    "final Hermes image still contains compiler build tools",
    "! command -v gcc && ! command -v g++ && ! command -v make",
  );
}

async function assertGatewayProcess(probe: DockerProbe, container: string): Promise<void> {
  await expectContainerSh(
    probe,
    container,
    "Hermes gateway process is not running as gateway user",
    'ps -eo user=,args= | awk \'$1 == "gateway" && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { found = 1 } END { exit found ? 0 : 1 }\'',
  );
  await expectContainerSh(
    probe,
    container,
    "start log does not show gateway privilege separation",
    "grep -F \"hermes gateway launched as 'gateway' user\" /tmp/nemoclaw-start.log",
  );
}

async function runCleanVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
): Promise<void> {
  const container = `nemoclaw-hermes-root-clean-${runId}`;
  await probe.expect(["run", "-d", "--name", container, image, "/usr/local/bin/nemoclaw-start"], {
    artifactName: "start-clean-root-entrypoint-container",
    timeoutMs: RUN_TIMEOUT_MS,
  });
  containers.push(container);

  await waitForHealth(probe, container);
  await assertGatewayProcess(probe, container);
  await assertGatewayLogClean(probe, container);
  await assertRuntimeLayout(probe, container);
  await assertConfigHashContract(probe, container);
  await assertBuiltImageRuntimeSurfaces(probe, container);
}

async function runLegacyVariant(
  probe: DockerProbe,
  image: string,
  runId: string,
  containers: string[],
): Promise<void> {
  const container = `nemoclaw-hermes-root-legacy-${runId}`;
  const legacyBootstrap = `set -euo pipefail
rm -f /sandbox/.hermes/gateway.pid
printf "stale pid\n" >/sandbox/.hermes/runtime/gateway.pid
printf "stale lock\n" >/sandbox/.hermes/runtime/gateway.lock
ln -s runtime/gateway.pid /sandbox/.hermes/gateway.pid
chmod 750 /sandbox/.hermes
rm -rf /sandbox/.hermes/hooks /sandbox/.hermes/image_cache /sandbox/.hermes/audio_cache /sandbox/.hermes/logs/curator
exec /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-start`;

  await probe.expect(
    ["run", "-d", "--name", container, "--entrypoint", "/bin/bash", image, "-lc", legacyBootstrap],
    { artifactName: "start-legacy-layout-root-entrypoint-container", timeoutMs: RUN_TIMEOUT_MS },
  );
  containers.push(container);

  await waitForHealth(probe, container);
  await assertGatewayProcess(probe, container);
  await assertGatewayLogClean(probe, container);
  await assertRuntimeLayout(probe, container);
  await assertConfigHashContract(probe, container);
  await expectContainerSh(
    probe,
    container,
    "legacy gateway.pid symlink migration was not logged",
    "grep -F 'Removing unsafe stale Hermes legacy PID file symlink' /tmp/nemoclaw-start.log",
  );
}

liveTest(
  "hermes root-entrypoint smoke preserves runtime layout and legacy pid migration",
  async ({ artifacts, cleanup, secrets, skip }) => {
    const probe = new DockerProbe(artifacts, (text, extraValues) =>
      secrets.redact(text, extraValues),
    );
    const runId = safeTag(`${process.env.GITHUB_RUN_ID ?? "local"}-${process.pid}-${Date.now()}`);
    const image =
      process.env.NEMOCLAW_HERMES_TEST_IMAGE ?? `nemoclaw-hermes-root-entrypoint-smoke:${runId}`;
    const baseImage = `nemoclaw-hermes-root-entrypoint-base:${runId}`;
    const containers: string[] = [];

    await artifacts.writeJson("scenario.json", {
      id: "hermes-root-entrypoint-smoke",
      runner: "vitest",
      boundary: "docker-root-entrypoint",
      legacySource: "test/e2e/test-hermes-root-entrypoint-smoke.sh",
      image,
      prebuiltImage: Boolean(process.env.NEMOCLAW_HERMES_TEST_IMAGE),
      contract: [
        "clean root-entrypoint startup reaches Hermes health",
        "gateway process runs as gateway user",
        "gateway log has no PID race or config load failure",
        "Hermes v0.14 writable runtime directories are present",
        "Hermes strict config hash validates against generated config.yaml and .env",
        "Hermes API bearer token authenticates a local OpenAI-compatible request",
        "Hermes dashboard home is seeded with routing and allowed env keys",
        "python-multipart, PTY allocation, and final-image toolchain hardening are present",
        "gateway.pid is migrated to a regular top-level file",
        "gateway user cannot remove config.yaml from sticky config root",
        "legacy gateway.pid symlink/state shape is repaired and booted",
      ],
    });

    cleanup.add("remove Hermes root-entrypoint smoke containers", async () => {
      await Promise.all(
        containers.map((container) =>
          probe.run(["rm", "-f", container], {
            artifactName: `cleanup-${container}`,
            timeoutMs: 30_000,
          }),
        ),
      );
    });

    await requireDocker(probe, skip);

    try {
      await buildImageIfNeeded(probe, image, baseImage);
      await runCleanVariant(probe, image, runId, containers);
      await runLegacyVariant(probe, image, runId, containers);
    } catch (error) {
      for (const container of containers) {
        await dumpContainerDiagnostics(probe, artifacts, (text) => secrets.redact(text), container);
      }
      throw error;
    }

    await artifacts.writeJson("scenario-result.json", {
      id: "hermes-root-entrypoint-smoke",
      image,
      assertions: {
        cleanStartupHealthy: true,
        legacyStartupHealthy: true,
        runtimeLayoutVerified: true,
        configHashContractVerified: true,
        gatewayPrivilegeSeparationVerified: true,
        legacyPidSymlinkMigrationVerified: true,
      },
    });
  },
);
