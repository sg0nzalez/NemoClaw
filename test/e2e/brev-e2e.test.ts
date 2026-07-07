// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Branch Validation E2E — installs NemoClaw FROM SOURCE on a fresh Brev instance.
 *
 * Answers: "Does this branch work if you install from source on a clean machine?"
 *
 * Creates a fresh Brev instance, rsyncs the checked-out branch code, runs
 * install.sh from source, onboards a sandbox, then executes the selected test
 * suite against the live environment. Tears down the instance when done.
 *
 * NOTE: This does NOT test the community Launchable install path
 * (launch-plugin.sh). For that, run e2e-launchable-smoke in
 * e2e.yaml.
 *
 * Intended to be run from CI via:
 *   npx vitest run --project e2e-branch-validation
 *
 * Required env vars:
 *   NVIDIA_INFERENCE_API_KEY   — passed to VM for inference config during onboarding
 *   GITHUB_TOKEN     — passed to VM for OpenShell binary download
 *   INSTANCE_NAME    — Brev instance name (e.g. pr-156-test)
 *
 * Prerequisite:
 *   The local `brev` CLI must already be authenticated before this suite runs.
 *
 * Optional env vars:
 *   TEST_SUITE             — which test to run: full (default), deploy-cli, gpu,
 *                             credential-sanitization, telegram-injection, messaging-providers,
 *                             messaging-compatible-endpoint, dashboard-remote-bind,
 *                             tool-disclosure-performance-smoke, all
 *   BREV_MIN_VCPU          — Minimum vCPUs for CPU instance (default: 4)
 *   BREV_MIN_RAM           — Minimum RAM in GB for CPU instance (default: 16)
 *   BREV_PROVIDER          — Cloud provider filter for brev search (default: gcp for CPU, any for GPU)
 *   BREV_MIN_DISK          — Minimum disk size in GB (default: 50)
 *   BREV_GPU_TYPE          — Optional GPU instance type for TEST_SUITE=gpu
 *   BREV_GPU_NAME          — GPU name filter when BREV_GPU_TYPE is unset (default: any GPU)
 *   BREV_GPU_MIN_VRAM      — Minimum total VRAM GB when BREV_GPU_TYPE is unset (default: 20)
 *   BREV_CREATE_TIMEOUT_SECONDS — Brev create timeout, seconds (default: 1200 for GPU)
 *   BREV_SSH_READY_TIMEOUT_SECONDS — SSH readiness timeout, seconds (default: 900 CPU, 1800 GPU)
 *   TELEGRAM_BOT_TOKEN       — Telegram bot token for messaging-providers test (fake OK)
 *   DISCORD_BOT_TOKEN        — Discord bot token for messaging-providers test (fake OK)
 *   SLACK_BOT_TOKEN          — Slack bot token for messaging-providers test (fake OK)
 *   SLACK_APP_TOKEN          — Slack app token for messaging-providers test (fake OK)
 *   SLACK_BOT_TOKEN_REVOKED  — Revoked xoxb- token to test auth pre-validation (#2340)
 *   SLACK_APP_TOKEN_REVOKED  — Paired xapp- token for the revoked bot token
 *   TELEGRAM_BOT_TOKEN_REAL  — Real Telegram token for optional live round-trip
 *   DISCORD_BOT_TOKEN_REAL   — Real Discord token for optional live round-trip
 *   TELEGRAM_CHAT_ID_E2E     — Telegram chat ID for optional sendMessage test
 */

import {
  type ChildProcess,
  execFileSync,
  execSync,
  type StdioOptions,
  spawn,
  spawnSync,
} from "node:child_process";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type QuickTunnel,
  startQuickTunnel,
} from "../../scripts/performance/tool-disclosure/quick-tunnel";
import {
  PERFORMANCE_SMOKE_MCP_PORT_ENV,
  PERFORMANCE_SMOKE_MCP_URL_ENV,
} from "../../scripts/performance/tool-disclosure/smoke-mcp-transport";
import { shellQuote } from "../../src/lib/core/shell-quote";
import {
  BREV_MESSAGING_COMPAT_TIMEOUT_MS,
  BREV_MESSAGING_PROVIDER_TIMEOUT_MS,
  BREV_REMOTE_WRAPPER_GRACE_MS,
  BREV_SECURITY_SUITE_TIMEOUT_MS,
  BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_ARTIFACT_DIR,
  BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_MCP_PORT,
  BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE,
  BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_TIMEOUT_MS,
  brevSuiteHarnessSandboxName,
  brevSuiteNeedsHarnessSandbox,
  brevWorkflowOwnsInstance,
  buildBrevMcpSshForwardArgs,
  buildBrevRemoteVitestCommand,
  buildBrevSshForwardEnvironment,
} from "../../tools/e2e/brev-remote-vitest.mts";

// Instance configuration
const BREV_MIN_VCPU = parseInt(process.env.BREV_MIN_VCPU || "4", 10);
const BREV_MIN_RAM = parseInt(process.env.BREV_MIN_RAM || "16", 10);
const BREV_MIN_DISK = parseInt(process.env.BREV_MIN_DISK || "50", 10);
const BREV_GPU_TYPE = process.env.BREV_GPU_TYPE || "";
const BREV_GPU_NAME = process.env.BREV_GPU_NAME || "";
const BREV_GPU_MIN_VRAM = process.env.BREV_GPU_MIN_VRAM || "20";
const INSTANCE_NAME = process.env.INSTANCE_NAME;
const TEST_SUITE = process.env.TEST_SUITE || "full";
const REPO_DIR = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(REPO_DIR, "bin", "nemoclaw.js");
const GPU_TEST_SUITE = TEST_SUITE === "gpu";
const TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE =
  TEST_SUITE === BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE;
const BREV_PROVIDER = process.env.BREV_PROVIDER || (GPU_TEST_SUITE ? "" : "gcp");
const BREV_CREATE_TIMEOUT_SECONDS = parseInt(
  process.env.BREV_CREATE_TIMEOUT_SECONDS || (GPU_TEST_SUITE ? "1200" : "180"),
  10,
);
const BREV_CREATE_TIMEOUT_MS =
  (Number.isFinite(BREV_CREATE_TIMEOUT_SECONDS) && BREV_CREATE_TIMEOUT_SECONDS > 0
    ? BREV_CREATE_TIMEOUT_SECONDS
    : GPU_TEST_SUITE
      ? 1200
      : 180) * 1000;
const BREV_SSH_READY_TIMEOUT_SECONDS = parseInt(
  process.env.BREV_SSH_READY_TIMEOUT_SECONDS || (GPU_TEST_SUITE ? "1800" : "900"),
  10,
);
const BREV_SSH_READY_TIMEOUT_MS =
  (Number.isFinite(BREV_SSH_READY_TIMEOUT_SECONDS) && BREV_SSH_READY_TIMEOUT_SECONDS > 0
    ? BREV_SSH_READY_TIMEOUT_SECONDS
    : GPU_TEST_SUITE
      ? 1800
      : 900) * 1000;
const OPENSHELL_GATEWAY_PORT = 8080;
const OLLAMA_AUTH_PROXY_PORT = 11435;
const DOCKER_DEFAULT_BRIDGE_POOL_CIDR = "172.16.0.0/12";

function requireInstanceName(): string {
  if (!INSTANCE_NAME) {
    throw new Error("INSTANCE_NAME is required for Brev E2E tests");
  }
  return INSTANCE_NAME;
}

// Launchable configuration
// CI-Ready CPU setup script: pre-bakes Docker, Node.js, OpenShell CLI, and npm deps.
// The Brev CLI (v0.6.322+) uses `brev search cpu | brev create --startup-script @file`.
// Use the repo-local script so secret-bearing branch validation cannot execute
// mutable setup code selected outside the reviewed checkout.
const SETUP_SCRIPT_PATH = path.join(REPO_DIR, "scripts", "brev-launchable-ci-cpu.sh");
// Sentinel file written by brev-launchable-ci-cpu.sh when setup is complete.
// More reliable than grepping log files.
const LAUNCHABLE_SENTINEL = "/var/run/nemoclaw-launchable-ready";
const PERFORMANCE_SMOKE_MCP_PLACEHOLDER_PID_FILE =
  "/tmp/nemoclaw-tool-disclosure-performance-mcp-placeholder.pid";
const PERFORMANCE_SMOKE_MCP_PLACEHOLDER_LOG_FILE =
  "/tmp/nemoclaw-tool-disclosure-performance-mcp-placeholder.log";

let remoteDir = "";
let instanceCreated = false;
let performanceSmokeMcpForward: ChildProcess | undefined;
let performanceSmokeMcpTunnel: QuickTunnel | undefined;

const STREAM_STDIO: StdioOptions = ["inherit", "inherit", "inherit"];
const CAPTURE_STDIO: StdioOptions = ["pipe", "pipe", "pipe"];
const CAPTURE_OUTPUT_STDIO: StdioOptions = ["ignore", "pipe", "inherit"];
const PIPE_INPUT_STDIO: StdioOptions = ["pipe", "inherit", "inherit"];

// --- low-level helpers ------------------------------------------------------

function brev(...args: string[]): string {
  return execFileSync("brev", args, {
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

type BrevInstance = { name: string; status?: string };

function normalizeBrevInstance(raw: unknown): BrevInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = record.name ?? record.workspaceName ?? record.instanceName ?? record.Name;
  if (typeof name !== "string" || !name.trim()) return null;
  const status = record.status ?? record.state ?? record.lifecycleStatus ?? record.Status;
  return {
    name: name.trim(),
    status: typeof status === "string" ? status.trim().toUpperCase() : undefined,
  };
}

function parseBrevListOutput(output: string): BrevInstance[] {
  const instances: BrevInstance[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/);
    const [name] = fields;
    if (!name || /^(NAME|TYPE|Usage:|Error:|no)$/i.test(name)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
    const status = fields.find((field) =>
      /^(CREATING|DELETING|FAILED|OFF|ON|READY|RUNNING|STARTING|STOPPED|STOPPING)$/i.test(field),
    );
    instances.push({
      name,
      status: status?.toUpperCase(),
    });
  }
  return instances;
}

function listBrevInstances(): BrevInstance[] {
  try {
    const parsed = JSON.parse(brev("ls", "--json"));
    const rawInstances = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.workspaces)
        ? parsed.workspaces
        : [];
    return rawInstances.flatMap((instance: unknown) => {
      const normalized = normalizeBrevInstance(instance);
      return normalized ? [normalized] : [];
    });
  } catch {
    try {
      return parseBrevListOutput(brev("ls"));
    } catch {
      return [];
    }
  }
}

function hasBrevInstance(instanceName: string): boolean {
  return listBrevInstances().some((instance) => instance.name === instanceName);
}

function isBrevInstanceDeleting(instanceName: string): boolean {
  const instances = listBrevInstances();
  const instance = instances.find(
    (i: { name: string; status?: string }) => i.name === instanceName,
  );
  return Boolean(instance && (instance.status === "DELETING" || instance.status === "STOPPING"));
}

function deleteBrevInstance(instanceName: string): boolean {
  if (!hasBrevInstance(instanceName)) {
    return true;
  }

  let deleteRequested = false;
  try {
    brev("delete", instanceName);
    deleteRequested = true;
  } catch {
    // Best-effort delete
  }

  // If the instance is gone or in DELETING/STOPPING state, that's success —
  // Brev will finish the teardown asynchronously.
  if (!hasBrevInstance(instanceName) || isBrevInstanceDeleting(instanceName)) {
    return true;
  }

  return deleteRequested;
}

function waitForBrevInstanceRemoved(
  instanceName: string,
  elapsed: () => string,
  maxWaitMs = 300_000,
): void {
  const deadline = Date.now() + maxWaitMs;
  let polls = 0;
  while (hasBrevInstance(instanceName)) {
    if (Date.now() > deadline) {
      throw new Error(`Brev instance "${instanceName}" was not removed within ${maxWaitMs}ms`);
    }
    polls += 1;
    if (polls === 1 || polls % 3 === 0) {
      console.log(`[${elapsed()}] Waiting for Brev instance "${instanceName}" to disappear...`);
    }
    execSync("sleep 10");
  }
}

function ssh(
  cmd: string,
  { timeout = 120_000, stream = false }: { timeout?: number; stream?: boolean } = {},
): string {
  const stdio = stream ? STREAM_STDIO : CAPTURE_STDIO;
  const result = execFileSync(
    "ssh",
    ["-o", "StrictHostKeyChecking=no", "-o", "LogLevel=ERROR", requireInstanceName(), cmd],
    { encoding: "utf-8", timeout, stdio },
  );
  return stream ? "" : result.trim();
}

/**
 * Escape a value for safe inclusion in a single-quoted shell string.
 * Replaces single quotes with the shell-safe sequence: '\''
 */
function shellEscape(value: string | null | undefined): string {
  return String(value).replace(/'/g, "'\\''");
}

/** Run a command on the remote VM with env vars set for NemoClaw. */
function sshEnv(
  cmd: string,
  { timeout = 600_000, stream = false }: { timeout?: number; stream?: boolean } = {},
): string {
  const gpuE2eModel = process.env.NEMOCLAW_GPU_E2E_MODEL || "qwen3.5:9b";
  const harnessSandboxName = brevSuiteHarnessSandboxName(TEST_SUITE);
  const envParts = [
    `export NVIDIA_INFERENCE_API_KEY='${shellEscape(process.env.NVIDIA_INFERENCE_API_KEY)}'`,
    `export GITHUB_TOKEN='${shellEscape(process.env.GITHUB_TOKEN)}'`,
    `export NEMOCLAW_NON_INTERACTIVE=1`,
    `export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1`,
    ...(harnessSandboxName
      ? [`export NEMOCLAW_SANDBOX_NAME='${shellEscape(harnessSandboxName)}'`]
      : []),
    `export NEMOCLAW_TRACE_DIR=/tmp/nemoclaw-traces`,
  ];
  if (GPU_TEST_SUITE) {
    // This suite validates Docker GPU passthrough and sandbox inference wiring.
    // Pin a small model so Brev's cheaper GPU shapes do not fail before
    // sandbox creation while auto-loading a very large default Ollama model.
    envParts.push(`export NEMOCLAW_MODEL='${shellEscape(gpuE2eModel)}'`);
  }
  if (TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE) {
    if (!performanceSmokeMcpTunnel) {
      throw new Error("Brev performance smoke MCP tunnel is not ready");
    }
    const testedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_DIR,
      encoding: "utf8",
    }).trim();
    if (!/^[a-f0-9]{40}$/u.test(testedSha)) {
      throw new Error("Brev performance smoke requires an exact local git SHA");
    }
    envParts.push(
      `export E2E_ARTIFACT_DIR='${shellEscape(BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_ARTIFACT_DIR)}'`,
      `export GITHUB_SHA='${testedSha}'`,
      `export ${PERFORMANCE_SMOKE_MCP_PORT_ENV}='${BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_MCP_PORT}'`,
      `export ${PERFORMANCE_SMOKE_MCP_URL_ENV}='${shellEscape(performanceSmokeMcpTunnel.mcpUrl)}'`,
    );
  }
  // Forward optional messaging tokens for the messaging-providers test
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN_REVOKED",
    "SLACK_APP_TOKEN_REVOKED",
    "TELEGRAM_BOT_TOKEN_REAL",
    "DISCORD_BOT_TOKEN_REAL",
    "TELEGRAM_CHAT_ID_E2E",
  ]) {
    if (process.env[key]) {
      envParts.push(`export ${key}='${shellEscape(process.env[key])}'`);
    }
  }
  const envPrefix = envParts.join(" && ");

  return ssh(`${envPrefix} && ${cmd}`, { timeout, stream });
}

function waitForSsh(maxWaitMs = BREV_SSH_READY_TIMEOUT_MS, intervalMs = 5_000): void {
  const deadline = Date.now() + maxWaitMs;
  let attempts = 0;
  let dnsFailures = 0;
  let lastError = "";
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      ssh("echo ok", { timeout: 10_000 });
      return;
    } catch (error) {
      lastError = commandErrorOutput(error);
      if (
        /Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i.test(
          lastError,
        )
      ) {
        dnsFailures += 1;
      } else {
        dnsFailures = 0;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      console.log(`  SSH attempt ${attempts} failed, retrying in ${intervalMs / 1000}s...`);
      if (attempts % 5 === 0) {
        console.log(`  Refreshing brev SSH config...`);
        try {
          brev("refresh");
        } catch {
          /* ignore */
        }
      }
      execSync(`sleep ${Math.max(1, Math.ceil(Math.min(intervalMs, remainingMs) / 1000))}`);
    }
  }
  throw new Error(
    `SSH not ready after ${Math.round(maxWaitMs / 60_000)} min ` +
      `(${attempts} attempts, ${dnsFailures} hostname-resolution failures). ` +
      `Last SSH error: ${lastError}`,
  );
}

/**
 * Wait for the launchable setup script to finish by checking a sentinel file.
 * Much more reliable than grepping log files.
 */
function waitForLaunchableReady(maxWaitMs = 1_200_000, pollIntervalMs = 15_000): void {
  const start = Date.now();
  const elapsed = () => `${Math.round((Date.now() - start) / 1000)}s`;
  let consecutiveSshFailures = 0;

  while (Date.now() - start < maxWaitMs) {
    try {
      const result = ssh(`test -f ${LAUNCHABLE_SENTINEL} && echo READY || echo PENDING`, {
        timeout: 15_000,
      });
      consecutiveSshFailures = 0; // reset on success
      if (result.includes("READY")) {
        console.log(`[${elapsed()}] Launchable setup complete (sentinel file found)`);
        return;
      }
      // Show progress from the setup log
      try {
        const tail = ssh("tail -2 /tmp/launch-plugin.log 2>/dev/null || echo '(no log yet)'", {
          timeout: 10_000,
        });
        console.log(`[${elapsed()}] Setup still running... ${tail.replace(/\n/g, " | ")}`);
      } catch {
        /* ignore */
      }
    } catch {
      consecutiveSshFailures++;
      console.log(
        `[${elapsed()}] Setup poll: SSH command failed (${consecutiveSshFailures} consecutive), retrying...`,
      );
      // Brev VMs sometimes reboot during setup (kernel upgrades, etc.)
      // Refresh the SSH config every 3 consecutive failures to pick up
      // new IP/port assignments after a reboot.
      if (consecutiveSshFailures % 3 === 0) {
        console.log(
          `[${elapsed()}] Refreshing brev SSH config after ${consecutiveSshFailures} failures...`,
        );
        try {
          brev("refresh");
        } catch {
          /* ignore */
        }
      }
    }
    execSync(`sleep ${pollIntervalMs / 1000}`);
  }

  throw new Error(
    `Launchable setup did not complete within ${maxWaitMs / 60_000} minutes. ` +
      `Sentinel file ${LAUNCHABLE_SENTINEL} not found.`,
  );
}

function runRemoteCommand(
  command: string,
  timeoutMs = GPU_TEST_SUITE ? 1_800_000 : 900_000,
): string {
  const dockerGroupCommand = shellQuote(`${command} 2>&1 | tee /tmp/test-output.log`);
  const cmd = [
    `set -o pipefail`,
    `source ~/.nvm/nvm.sh 2>/dev/null || true`,
    `cd ${remoteDir}`,
    `export npm_config_prefix=$HOME/.local`,
    `export PATH=$HOME/.local/bin:$PATH`,
    // The setup adds this user to the docker group without weakening the
    // host-root-equivalent socket. `sg` also handles a session created before
    // that group membership became visible.
    `sg docker -c ${dockerGroupCommand}`,
  ].join(" && ");

  // Stream test output to CI log AND capture it for assertions
  try {
    sshEnv(cmd, { timeout: timeoutMs, stream: true });
  } catch (error) {
    printRemoteFailureDiagnostics();
    throw error;
  }
  // Retrieve the captured output for assertion checking
  return ssh("cat /tmp/test-output.log", { timeout: 30_000 });
}

function runRemoteVitest(project: "cli" | "e2e-live", target: string, timeoutMs?: number): string {
  return runRemoteCommand(buildBrevRemoteVitestCommand(project, target), timeoutMs);
}

function expectVitestPassed(output: string): void {
  expect(output).toContain("Test Files");
  expect(output).toMatch(/\bpassed\b/);
  expect(output).not.toMatch(/\bfailed\b/i);
}

function printRemoteFailureDiagnostics(): void {
  try {
    const diagnostics = ssh(
      [
        `set +e`,
        `echo "===== remote failure diagnostics ====="`,
        `echo "--- openshell sandbox list ---"`,
        `PATH=$HOME/.local/bin:$PATH openshell sandbox list 2>&1 || true`,
        `echo "--- docker ps ---"`,
        `sg docker -c 'docker ps -a --filter label=openshell.ai/managed-by=openshell' 2>&1 || true`,
        `echo "--- openshell gateway log ---"`,
        `tail -200 "$HOME/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.log" 2>&1 || true`,
        `latest="$(find "$HOME/.nemoclaw/onboard-failures" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)"`,
        `if [ -n "$latest" ]; then`,
        `  echo "--- latest onboard failure: $latest ---"`,
        `  for file in summary.txt docker-network-summary.txt docker-ps.txt openshell-sandbox-list.txt openshell-sandbox-get.txt; do`,
        `    if [ -s "$latest/$file" ]; then`,
        `      echo "--- $file ---"`,
        `      sed -n '1,160p' "$latest/$file"`,
        `    fi`,
        `  done`,
        `  for file in docker-logs.txt openshell-logs.txt; do`,
        `    if [ -s "$latest/$file" ]; then`,
        `      echo "--- tail $file ---"`,
        `      tail -160 "$latest/$file"`,
        `    fi`,
        `  done`,
        `fi`,
      ].join("\n"),
      { timeout: 60_000 },
    );
    console.log(diagnostics);
  } catch (diagnosticsError) {
    console.log(`Failed to collect remote diagnostics: ${String(diagnosticsError)}`);
  }
}

function runLocalDeploy(instanceName: string): void {
  const env = {
    ...process.env,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: "e2e-test",
    NEMOCLAW_PROVIDER: process.env.NEMOCLAW_PROVIDER || "build",
    NEMOCLAW_DEPLOY_NO_CONNECT: "1",
    NEMOCLAW_DEPLOY_NO_START_SERVICES: "1",
  };

  execFileSync("node", [CLI_PATH, "deploy", instanceName], {
    timeout: 2_700_000,
    env,
    stdio: "inherit",
  });
}

// --- beforeAll orchestration helpers ----------------------------------------

/**
 * Delete any leftover instance with the same name.
 * This can happen when a previous run's create succeeded on the backend
 * but the CLI got a network error (unexpected EOF) before confirming,
 * then the retry/fallback fails with "duplicate workspace".
 */
function cleanupLeftoverInstance(elapsed: () => string): void {
  const instanceName = requireInstanceName();
  if (hasBrevInstance(instanceName)) {
    if (!deleteBrevInstance(instanceName)) {
      throw new Error(`Failed to delete leftover instance "${instanceName}"`);
    }
    console.log(`[${elapsed()}] Requested deletion of leftover instance "${instanceName}"`);
    waitForBrevInstanceRemoved(instanceName, elapsed);
    console.log(`[${elapsed()}] Deleted leftover instance "${instanceName}"`);
  }
}

/**
 * Refresh brev SSH config and wait for SSH connectivity.
 * Shared by both the deploy-cli and launchable paths.
 */
function refreshAndWaitForSsh(elapsed: () => string): void {
  try {
    brev("refresh");
  } catch {
    /* ignore */
  }
  waitForSsh();
  console.log(`[${elapsed()}] SSH is up`);
}

function createBrevInstanceAndWaitForSsh(elapsed: () => string): void {
  const configuredAttempts = Number(process.env.BREV_PROVISION_ATTEMPTS || 2);
  const maxAttempts = GPU_TEST_SUITE
    ? Math.max(1, Number.isFinite(configuredAttempts) ? configuredAttempts : 2)
    : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.log(`[${elapsed()}] Retrying Brev provisioning (${attempt}/${maxAttempts})...`);
      cleanupLeftoverInstance(elapsed);
    }
    try {
      createBrevInstance(elapsed);
      instanceCreated = true;
      refreshAndWaitForSsh(elapsed);
      return;
    } catch (error) {
      lastError = error;
      console.log(`[${elapsed()}] Brev provisioning attempt ${attempt}/${maxAttempts} failed.`);
      const details = commandErrorOutput(error);
      if (details) console.log(details);
      if (hasBrevInstance(requireInstanceName())) {
        if (deleteBrevInstance(requireInstanceName())) {
          console.log(`[${elapsed()}] Requested deletion after failed provisioning attempt`);
          waitForBrevInstanceRemoved(requireInstanceName(), elapsed);
        }
      }
      instanceCreated = false;
    }
  }
  throw new Error(`Brev instance did not become SSH-ready after ${maxAttempts} attempt(s).`, {
    cause: lastError,
  });
}

function commandErrorOutput(error: unknown): string {
  const err = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
  return [err.message, err.stdout?.toString(), err.stderr?.toString()]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n")
    .trim();
}

function summarizeBrevCandidates(output: string, maxLines = 10): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "(none)";
  const shown = lines.slice(0, maxLines);
  const suffix = lines.length > shown.length ? `\n... ${lines.length - shown.length} more` : "";
  return `${shown.join("\n")}${suffix}`;
}

/**
 * Create a Brev launchable instance with a startup script.
 *
 * The Brev API sometimes returns "unexpected EOF" after the instance is actually
 * created server-side. The CLI then falls back to the next instance type, which
 * fails with "duplicate workspace". To handle this, we catch create failures and
 * check if the instance exists anyway.
 */
function createBrevInstance(elapsed: () => string): void {
  const instanceKind = GPU_TEST_SUITE ? "gpu" : "cpu";
  console.log(`[${elapsed()}] Creating ${instanceKind} instance via launchable...`);
  console.log(`[${elapsed()}]   setup-script: ${SETUP_SCRIPT_PATH}`);
  console.log(`[${elapsed()}]   create timeout: ${Math.round(BREV_CREATE_TIMEOUT_MS / 1000)}s`);
  if (GPU_TEST_SUITE) {
    if (BREV_GPU_TYPE) {
      console.log(`[${elapsed()}]   gpu type: ${BREV_GPU_TYPE}`);
    } else {
      console.log(
        `[${elapsed()}]   gpu: ${BREV_GPU_NAME ? `name ${BREV_GPU_NAME}, ` : ""}min ${BREV_GPU_MIN_VRAM} GB VRAM${BREV_PROVIDER ? `, provider: ${BREV_PROVIDER}` : ""}`,
      );
    }
  } else {
    console.log(
      `[${elapsed()}]   cpu: min ${BREV_MIN_VCPU} vCPU, ${BREV_MIN_RAM} GB RAM, ${BREV_MIN_DISK} GB disk, provider: ${BREV_PROVIDER}`,
    );
  }

  const setupScriptPath = SETUP_SCRIPT_PATH;
  console.log(`[${elapsed()}] Using repo-local setup script`);

  try {
    if (GPU_TEST_SUITE) {
      const createArgs = [
        "create",
        requireInstanceName(),
        "--startup-script",
        `@${setupScriptPath}`,
        "--detached",
        "--timeout",
        String(Math.round(BREV_CREATE_TIMEOUT_MS / 1000)),
      ];
      if (BREV_GPU_TYPE) {
        createArgs.push("--type", BREV_GPU_TYPE);
        execFileSync("brev", createArgs, {
          encoding: "utf-8",
          timeout: BREV_CREATE_TIMEOUT_MS + 180_000,
          stdio: STREAM_STDIO,
        });
      } else {
        const gpuSearchArgs = [
          "search",
          "gpu",
          ...(BREV_GPU_NAME ? ["--gpu-name", BREV_GPU_NAME] : []),
          "--min-total-vram",
          BREV_GPU_MIN_VRAM,
          "--min-disk",
          String(Math.max(BREV_MIN_DISK, 100)),
          "--sort",
          "price",
          ...(BREV_PROVIDER ? ["--provider", BREV_PROVIDER] : []),
        ];
        let gpuCandidates: string;
        try {
          gpuCandidates = execFileSync("brev", gpuSearchArgs, {
            encoding: "utf-8",
            timeout: 120_000,
            stdio: CAPTURE_OUTPUT_STDIO,
          });
        } catch (searchErr) {
          throw new Error(
            `brev GPU search failed before provisioning. ${commandErrorOutput(searchErr)}`,
            { cause: searchErr },
          );
        }
        if (!gpuCandidates.trim()) {
          throw new Error(`brev GPU search returned no candidates for: ${gpuSearchArgs.join(" ")}`);
        }
        console.log(
          `[${elapsed()}] Brev GPU candidates:\n${summarizeBrevCandidates(gpuCandidates)}`,
        );
        execFileSync("brev", createArgs, {
          encoding: "utf-8",
          input: gpuCandidates,
          timeout: BREV_CREATE_TIMEOUT_MS + 180_000,
          stdio: PIPE_INPUT_STDIO,
        });
      }
    } else {
      const cpuCandidates = execFileSync(
        "brev",
        [
          "search",
          "cpu",
          "--min-vcpu",
          String(BREV_MIN_VCPU),
          "--min-ram",
          String(BREV_MIN_RAM),
          "--min-disk",
          String(BREV_MIN_DISK),
          "--provider",
          BREV_PROVIDER,
          "--sort",
          "price",
        ],
        { encoding: "utf-8", timeout: 120_000, stdio: CAPTURE_OUTPUT_STDIO },
      );
      execFileSync(
        "brev",
        ["create", requireInstanceName(), "--startup-script", `@${setupScriptPath}`, "--detached"],
        {
          encoding: "utf-8",
          input: cpuCandidates,
          timeout: 180_000,
          stdio: PIPE_INPUT_STDIO,
        },
      );
    }
  } catch (createErr) {
    console.log(
      `[${elapsed()}] brev create exited with error — checking if instance was created anyway...`,
    );
    try {
      brev("refresh");
    } catch {
      /* ignore */
    }
    const lsOutput = execSync(`brev ls 2>&1 || true`, { encoding: "utf-8", timeout: 30_000 });
    const instanceName = requireInstanceName();
    if (!lsOutput.includes(instanceName)) {
      const createMessage = createErr instanceof Error ? createErr.message : String(createErr);
      throw new Error(
        `brev create failed and instance "${instanceName}" not found in brev ls. ` +
          `Original error: ${createMessage}`,
        { cause: createErr },
      );
    }
    console.log(
      `[${elapsed()}] Instance "${INSTANCE_NAME}" found in brev ls despite create error — proceeding`,
    );
  }
  console.log(`[${elapsed()}] brev create returned (instance provisioning in background)`);
}

/**
 * GPU Brev instances provide the host driver, but Docker may still need the
 * NVIDIA container runtime configured before sandbox containers can use GPUs.
 */
function gpuDockerRuntimeSetupCommands(): string[] {
  return [
    `set -euo pipefail`,
    `nvidia-smi`,
    `sudo apt-get update -qq`,
    `sudo apt-get install -y -qq ca-certificates curl gnupg >/dev/null`,
    `sudo rm -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg`,
    `curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg`,
    `curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null`,
    `sudo apt-get update -qq`,
    `sudo apt-get install -y -qq nvidia-container-toolkit >/dev/null`,
    `sudo nvidia-ctk runtime configure --runtime=docker`,
    `sudo systemctl restart docker`,
    // Brev GPU branch-validation VMs are single-use CI hosts. The
    // openshell-docker network is created later by gateway startup, so this
    // setup cannot know the exact future bridge subnet. Allow Docker's default
    // local bridge pool to the OpenShell host-service ports needed by the GPU
    // path; product-side reachability checks still fail closed if the sandbox
    // route is actually broken (#3959).
    `if command -v ufw >/dev/null 2>&1; then sudo ufw allow from ${DOCKER_DEFAULT_BRIDGE_POOL_CIDR} to any port ${OPENSHELL_GATEWAY_PORT} proto tcp >/dev/null || echo "warning: could not add UFW OpenShell gateway allow rule" >&2; fi`,
    `if command -v ufw >/dev/null 2>&1; then sudo ufw allow from ${DOCKER_DEFAULT_BRIDGE_POOL_CIDR} to any port ${OLLAMA_AUTH_PROXY_PORT} proto tcp >/dev/null || echo "warning: could not add UFW Ollama auth proxy allow rule" >&2; fi`,
    `sg docker -c 'docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi'`,
  ];
}

function prepareGpuDockerRuntime(elapsed: () => string): void {
  console.log(`[${elapsed()}] Preparing NVIDIA Docker runtime on Brev GPU instance...`);
  ssh(gpuDockerRuntimeSetupCommands().join(" && "), { timeout: 900_000, stream: true });
  console.log(`[${elapsed()}] NVIDIA Docker runtime ready`);
}

function performanceSmokePlaceholderSource(): string {
  return [
    "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
    "class Handler(BaseHTTPRequestHandler):",
    "    def do_HEAD(self):",
    "        self.send_response(405)",
    "        self.end_headers()",
    "    def do_GET(self):",
    "        self.send_response(405)",
    "        self.end_headers()",
    "    def log_message(self, format, *args):",
    "        pass",
    `ThreadingHTTPServer((\"127.0.0.1\", ${BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_MCP_PORT}), Handler).serve_forever()`,
  ].join("\n");
}

function startPerformanceSmokeMcpPlaceholder(): void {
  ssh(
    [
      "set -euo pipefail",
      `rm -f ${PERFORMANCE_SMOKE_MCP_PLACEHOLDER_PID_FILE} ${PERFORMANCE_SMOKE_MCP_PLACEHOLDER_LOG_FILE}`,
      `nohup python3 -c ${shellQuote(performanceSmokePlaceholderSource())} </dev/null >${PERFORMANCE_SMOKE_MCP_PLACEHOLDER_LOG_FILE} 2>&1 &`,
      "placeholder_pid=$!",
      `printf '%s\\n' \"$placeholder_pid\" >${PERFORMANCE_SMOKE_MCP_PLACEHOLDER_PID_FILE}`,
      "sleep 1",
      'kill -0 "$placeholder_pid"',
    ].join("\n"),
    { timeout: 15_000 },
  );
}

function stopPerformanceSmokeMcpPlaceholder(): void {
  ssh(
    [
      "set +e",
      `if test -s ${PERFORMANCE_SMOKE_MCP_PLACEHOLDER_PID_FILE}; then`,
      `placeholder_pid=\"$(cat ${PERFORMANCE_SMOKE_MCP_PLACEHOLDER_PID_FILE})\"`,
      'kill "$placeholder_pid" 2>/dev/null',
      "for attempt in 1 2 3 4 5; do",
      'if ! kill -0 "$placeholder_pid" 2>/dev/null; then break; fi',
      "sleep 1",
      "done",
      'kill -9 "$placeholder_pid" 2>/dev/null',
      "fi",
      `rm -f ${PERFORMANCE_SMOKE_MCP_PLACEHOLDER_PID_FILE}`,
    ].join("\n"),
    { timeout: 15_000 },
  );
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback port for the Brev MCP forward"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function canConnectLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function stopManagedChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function startPerformanceSmokeSshForward(localPort: number): Promise<ChildProcess> {
  const child = spawn("ssh", buildBrevMcpSshForwardArgs(requireInstanceName(), localPort), {
    env: buildBrevSshForwardEnvironment(process.env),
    stdio: ["ignore", "ignore", "inherit"],
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Brev MCP SSH forward exited before readiness");
    }
    if (await canConnectLoopback(localPort)) return child;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stopManagedChild(child);
  throw new Error("Brev MCP SSH forward did not become ready");
}

async function prepareToolDisclosurePerformanceSmoke(elapsed: () => string): Promise<void> {
  console.log(`[${elapsed()}] Preparing runner-relayed MCP tunnel...`);
  startPerformanceSmokeMcpPlaceholder();
  const localPort = await reserveLoopbackPort();
  try {
    performanceSmokeMcpForward = await startPerformanceSmokeSshForward(localPort);
    performanceSmokeMcpTunnel = await startQuickTunnel({ port: localPort, timeoutMs: 90_000 });
  } catch (error) {
    await stopManagedChild(performanceSmokeMcpForward);
    performanceSmokeMcpForward = undefined;
    stopPerformanceSmokeMcpPlaceholder();
    throw error;
  }
  console.log(`[${elapsed()}] Runner-relayed MCP tunnel ready`);
}

/**
 * Bootstrap the launchable environment on the remote VM:
 * rsync branch code, install deps, build plugin, and npm link the CLI.
 *
 * Returns { remoteDir, needsOnboard } so the caller can see what was
 * resolved without relying on hidden side-effects.
 */
function bootstrapLaunchable(elapsed: () => string): { remoteDir: string; needsOnboard: boolean } {
  // The launchable clones NemoClaw to ~/NemoClaw
  const remoteHome = ssh("echo $HOME");
  const resolvedRemoteDir = `${remoteHome}/NemoClaw`;

  // Rsync PR branch code over the launchable's clone
  console.log(`[${elapsed()}] Syncing PR branch code over launchable's clone...`);
  execFileSync(
    "rsync",
    [
      "-az",
      "--delete",
      "--exclude",
      "node_modules",
      "--exclude",
      ".git",
      "--exclude",
      "dist",
      "--exclude",
      ".venv",
      `${REPO_DIR}/`,
      `${requireInstanceName()}:${resolvedRemoteDir}/`,
    ],
    { encoding: "utf-8", timeout: 120_000 },
  );
  console.log(`[${elapsed()}] Code synced`);

  // Re-install deps for our branch (most already cached by launchable).
  // Use `npm install` instead of `npm ci` because the rsync'd branch code
  // may have a package.json/package-lock.json that are slightly out of sync
  // (e.g. new transitive deps). npm install is more forgiving and still
  // benefits from the launchable's pre-cached node_modules.
  // Always run this even for TEST_SUITE=full — it primes the cache so
  // install.sh's npm install is a fast no-op.
  console.log(`[${elapsed()}] Running npm install to sync dependencies...`);
  ssh(
    [
      `set -o pipefail`,
      `source ~/.nvm/nvm.sh 2>/dev/null || true`,
      `cd ${resolvedRemoteDir}`,
      `npm install --ignore-scripts 2>&1 | tail -5`,
    ].join(" && "),
    { timeout: 300_000, stream: true },
  );
  console.log(`[${elapsed()}] Dependencies synced`);

  // When TEST_SUITE=full or gpu, the shell test runs install.sh which handles
  // plugin build, npm link, and onboard from scratch. Skip those steps
  // to avoid ~8 min of redundant work.
  if (TEST_SUITE === "full" || GPU_TEST_SUITE) {
    console.log(
      `[${elapsed()}] Skipping plugin build, npm link, and onboard (TEST_SUITE=${TEST_SUITE} — install.sh handles it)`,
    );
    return { remoteDir: resolvedRemoteDir, needsOnboard: false };
  }

  // Rebuild CLI dist/ for our branch. The rsync above excludes dist/, so
  // without this step bin/nemoclaw.js would `require("../dist/nemoclaw")`
  // against the launchable's main-branch build and crash with
  // MODULE_NOT_FOUND if main differs from the PR branch. `npm install
  // --ignore-scripts` skipped the `prepare` lifecycle that normally runs
  // `build:cli`, so do it explicitly.
  console.log(`[${elapsed()}] Building CLI (dist/) for PR branch...`);
  ssh(`source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${resolvedRemoteDir} && npm run build:cli`, {
    timeout: 120_000,
    stream: true,
  });
  console.log(`[${elapsed()}] CLI built`);

  // Rebuild TS plugin for our branch (reinstall plugin deps in case they changed)
  console.log(`[${elapsed()}] Building TypeScript plugin...`);
  ssh(
    `source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${resolvedRemoteDir}/nemoclaw && npm install && npm run build`,
    {
      timeout: 120_000,
      stream: true,
    },
  );
  console.log(`[${elapsed()}] Plugin built`);

  // Expose the nemoclaw CLI on PATH. The launchable setup script already
  // creates /usr/local/bin/nemoclaw → $NEMOCLAW_CLONE_DIR/bin/nemoclaw.js
  // as a direct symlink, and rsync above preserves that path, so this is
  // an idempotent re-link to make local dev runs (that skip the launchable)
  // still work. Avoid `sudo npm link` on cold CPU Brev — it routinely
  // hangs inside npm's global-prefix housekeeping.
  console.log(`[${elapsed()}] Linking nemoclaw CLI (direct symlink)...`);
  ssh(
    `sudo ln -sf ${resolvedRemoteDir}/bin/nemoclaw.js /usr/local/bin/nemoclaw && sudo chmod +x ${resolvedRemoteDir}/bin/nemoclaw.js`,
    {
      timeout: 30_000,
      stream: true,
    },
  );
  console.log(`[${elapsed()}] nemoclaw CLI linked`);

  return {
    remoteDir: resolvedRemoteDir,
    // The composite security suite provisions and tears down its own sandbox
    // in each live target. Seeding a second harness-owned registry here leaves
    // stale state after the first target destroys the shared gateway.
    needsOnboard: brevSuiteNeedsHarnessSandbox(TEST_SUITE),
  };
}

/**
 * Launch nemoclaw onboard in background and poll until the sandbox is Ready.
 *
 * The `nemoclaw onboard` process hangs after sandbox creation because
 * `openshell sandbox create` keeps a long-lived SSH connection to the sandbox
 * entrypoint, and the dashboard port-forward also blocks. We launch it in
 * background, poll for sandbox readiness via `openshell sandbox list`, then
 * hand off to writeManualRegistry() to kill the hung process.
 */
function pollForSandboxReady(elapsed: () => string): void {
  // Launch onboard fully detached inside a docker-group shell. nohup plus
  // redirected descriptors lets the SSH session exit cleanly while retaining
  // least-privilege Docker socket ownership.
  console.log(`[${elapsed()}] Starting nemoclaw onboard in background...`);
  // Launch onboard in background. The SSH command may exit with code 255
  // (SSH error) because background processes keep file descriptors open.
  // That's fine — we just need the process to start; we'll poll for
  // sandbox readiness separately.
  try {
    sshEnv(
      [
        `source ~/.nvm/nvm.sh 2>/dev/null || true`,
        `cd ${remoteDir}`,
        `sg docker -c ${shellQuote("nohup nemoclaw onboard --non-interactive </dev/null >/tmp/nemoclaw-onboard.log 2>&1 &")}`,
        `sleep 2`,
        `echo "onboard launched"`,
      ].join(" && "),
      { timeout: 30_000 },
    );
  } catch (bgErr) {
    // SSH exit 255 or ETIMEDOUT is expected when backgrounding processes.
    // Verify the process actually started by checking the log file.
    try {
      const check = ssh("test -f /tmp/nemoclaw-onboard.log && echo OK || echo MISSING", {
        timeout: 10_000,
      });
      if (check.includes("OK")) {
        console.log(
          `[${elapsed()}] Background launch returned non-zero but log file exists — continuing`,
        );
      } else {
        throw bgErr;
      }
    } catch {
      throw bgErr;
    }
  }
  console.log(`[${elapsed()}] Onboard launched in background`);

  // Poll until openshell reports the sandbox as Ready (or onboard fails).
  // The sandbox step is the slow part (~5-10 min for image build + upload).
  const maxOnboardWaitMs = 1_200_000; // 20 min
  const onboardPollMs = 15_000;
  const onboardStart = Date.now();
  const onboardElapsed = () => `${Math.round((Date.now() - onboardStart) / 1000)}s`;

  while (Date.now() - onboardStart < maxOnboardWaitMs) {
    try {
      const sandboxList = ssh(`openshell sandbox list 2>/dev/null || true`, {
        timeout: 15_000,
      });
      if (sandboxList.includes("e2e-test") && sandboxList.includes("Ready")) {
        console.log(`[${onboardElapsed()}] Sandbox e2e-test is Ready!`);
        break;
      }
      // Show onboard progress from the log
      try {
        const tail = ssh("tail -2 /tmp/nemoclaw-onboard.log 2>/dev/null || echo '(no log yet)'", {
          timeout: 10_000,
        });
        console.log(`[${onboardElapsed()}] Onboard in progress... ${tail.replace(/\n/g, " | ")}`);
      } catch {
        /* ignore */
      }
    } catch {
      console.log(`[${onboardElapsed()}] Poll: SSH command failed, retrying...`);
    }

    // Check if onboard failed (process exited and no sandbox)
    try {
      const session = ssh("cat ~/.nemoclaw/onboard-session.json 2>/dev/null || echo '{}'", {
        timeout: 10_000,
      });
      const parsed = JSON.parse(session);
      if (parsed.status === "failed") {
        const failLog = ssh("cat /tmp/nemoclaw-onboard.log 2>/dev/null || echo 'no log'", {
          timeout: 10_000,
        });
        throw new Error(`Onboard failed: ${parsed.failure || "unknown"}\n${failLog}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Onboard failed")) throw e;
      /* ignore parse errors */
    }

    execSync(`sleep ${onboardPollMs / 1000}`);
  }

  // Verify sandbox is actually ready
  const finalList = ssh(`openshell sandbox list 2>/dev/null`, { timeout: 15_000 });
  if (!finalList.includes("e2e-test") || !finalList.includes("Ready")) {
    const failLog = ssh("cat /tmp/nemoclaw-onboard.log 2>/dev/null || echo 'no log'", {
      timeout: 10_000,
    });
    throw new Error(`Sandbox not ready after ${maxOnboardWaitMs / 60_000} min.\n${failLog}`);
  }
}

/**
 * Kill the hung onboard process tree and write the sandbox registry manually.
 *
 * The onboard hangs on the dashboard port-forward step and never writes
 * sandboxes.json. We kill it and write the registry ourselves.
 *
 * Note: The registry shape matches SandboxRegistry from src/lib/state/registry.ts
 * (sandboxes + defaultSandbox only — no version field).
 */
function writeManualRegistry(elapsed: () => string): void {
  console.log(`[${elapsed()}] Sandbox ready — killing hung onboard and writing registry...`);
  // Kill hung onboard processes. pkill may kill the SSH connection itself
  // if the pattern matches too broadly, so wrap in try/catch.
  try {
    ssh(
      `pkill -f "nemoclaw onboard" 2>/dev/null; pkill -f "openshell sandbox create" 2>/dev/null; sleep 1; true`,
      { timeout: 15_000 },
    );
  } catch {
    // SSH exit 255 is expected — pkill may terminate the connection
    console.log(
      `[${elapsed()}] pkill returned non-zero (expected — SSH connection may have been affected)`,
    );
  }
  // Write the sandbox registry using printf to avoid heredoc quoting issues over SSH
  const registryJson = JSON.stringify(
    {
      defaultSandbox: "e2e-test",
      sandboxes: {
        "e2e-test": {
          name: "e2e-test",
          createdAt: new Date().toISOString(),
          model: null,
          nimContainer: null,
          provider: null,
          gpuEnabled: false,
          policies: ["pypi", "npm"],
        },
      },
    },
    null,
    2,
  );
  ssh(
    `mkdir -p ~/.nemoclaw && printf '%s' '${shellEscape(registryJson)}' > ~/.nemoclaw/sandboxes.json`,
    { timeout: 15_000 },
  );
  console.log(`[${elapsed()}] Registry written, onboard workaround complete`);
}

// --- suite ------------------------------------------------------------------

const REQUIRED_VARS = ["NVIDIA_INFERENCE_API_KEY", "GITHUB_TOKEN", "INSTANCE_NAME"];
const hasRequiredVars = REQUIRED_VARS.every((key) => process.env[key]);
const hasAuthenticatedBrev = (() => {
  try {
    brev("ls");
    return true;
  } catch {
    return false;
  }
})();

describe("Brev deploy input validation", () => {
  it("rejects invalid sandbox names before provisioning or remote work", () => {
    const result = spawnSync(process.execPath, [CLI_PATH, "deploy", "brev-target"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: process.env.HOME,
        NEMOCLAW_SANDBOX_NAME: "bad name",
        NEMOCLAW_PROVIDER: "build",
        NEMOCLAW_DEPLOY_NO_CONNECT: "1",
        NEMOCLAW_DEPLOY_NO_START_SERVICES: "1",
      },
      timeout: 60_000,
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("Invalid sandbox name: 'bad name'");
    expect(output).toContain("Sandbox names cannot contain spaces.");
    expect(output).toContain(
      "Allowed format: 1-63 characters, lowercase, starts with a letter, letters/numbers/internal hyphens only, ends with letter/number.",
    );
    expect(output).not.toContain("brev CLI not found");
    expect(output).not.toContain("Creating Brev instance");
    expect(output).not.toContain("Waiting for Brev instance readiness");
    expect(output).not.toContain("Waiting for SSH");
    expect(output).not.toContain("bash scripts/install.sh");
  }, 65_000);
});

describe("Brev GPU runtime setup", () => {
  it("allows Docker bridge traffic to reach OpenShell host-service ports", () => {
    const setup = gpuDockerRuntimeSetupCommands().join("\n");

    expect(setup).toContain(
      `if command -v ufw >/dev/null 2>&1; then sudo ufw allow from ${DOCKER_DEFAULT_BRIDGE_POOL_CIDR} to any port ${OPENSHELL_GATEWAY_PORT} proto tcp >/dev/null || echo "warning: could not add UFW OpenShell gateway allow rule" >&2; fi`,
    );
    expect(setup).toContain(
      `if command -v ufw >/dev/null 2>&1; then sudo ufw allow from ${DOCKER_DEFAULT_BRIDGE_POOL_CIDR} to any port ${OLLAMA_AUTH_PROXY_PORT} proto tcp >/dev/null || echo "warning: could not add UFW Ollama auth proxy allow rule" >&2; fi`,
    );
  });
});

describe.runIf(hasRequiredVars && hasAuthenticatedBrev)("Brev E2E", () => {
  beforeAll(async () => {
    const bootstrapStart = Date.now();
    const elapsed = () => `${Math.round((Date.now() - bootstrapStart) / 1000)}s`;

    cleanupLeftoverInstance(elapsed);

    if (TEST_SUITE === "deploy-cli") {
      console.log(`[${elapsed()}] Running nemoclaw deploy end to end...`);
      instanceCreated = true;
      runLocalDeploy(requireInstanceName());
      refreshAndWaitForSsh(elapsed);
      const remoteHome = ssh("echo $HOME");
      remoteDir = `${remoteHome}/nemoclaw`;
    } else {
      // ── Launchable path: pre-baked CI environment ──────────────────
      // Uses brev create with --startup-script.
      // The script pre-installs Docker, Node.js, OpenShell CLI, and npm deps.
      // We just need to rsync branch code and run onboard.
      createBrevInstanceAndWaitForSsh(elapsed);

      // Wait for launchable setup to finish (sentinel file)
      console.log(`[${elapsed()}] Waiting for launchable setup to complete...`);
      waitForLaunchableReady();

      if (GPU_TEST_SUITE) {
        prepareGpuDockerRuntime(elapsed);
      }

      const result = bootstrapLaunchable(elapsed);
      remoteDir = result.remoteDir;

      if (TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE) {
        await prepareToolDisclosurePerformanceSmoke(elapsed);
      }

      if (result.needsOnboard) {
        pollForSandboxReady(elapsed);
        writeManualRegistry(elapsed);
      }
    }

    // Verify sandbox registry (only when beforeAll created a sandbox)
    if (brevSuiteNeedsHarnessSandbox(TEST_SUITE) && !GPU_TEST_SUITE) {
      console.log(`[${elapsed()}] Verifying sandbox registry...`);
      const registry = JSON.parse(ssh(`cat ~/.nemoclaw/sandboxes.json`, { timeout: 10_000 }));
      expect(registry.defaultSandbox).toBe("e2e-test");
      expect(registry.sandboxes).toHaveProperty("e2e-test");
      const sandbox = registry.sandboxes["e2e-test"];
      expect(sandbox).toMatchObject({
        name: "e2e-test",
        gpuEnabled: false,
        policies: ["pypi", "npm"],
      });
      console.log(`[${elapsed()}] Sandbox registry verified`);
    }

    console.log(`[${elapsed()}] beforeAll complete — total bootstrap time: ${elapsed()}`);
  }, 2_700_000); // 45 min

  afterAll(async () => {
    if (performanceSmokeMcpTunnel) {
      await performanceSmokeMcpTunnel.close();
      performanceSmokeMcpTunnel = undefined;
    }
    await stopManagedChild(performanceSmokeMcpForward);
    performanceSmokeMcpForward = undefined;
    if (instanceCreated && TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE) {
      stopPerformanceSmokeMcpPlaceholder();
    }
    if (!instanceCreated) return;
    const keepAlive = process.env.KEEP_ALIVE === "true";
    const workflowOwnsInstance = brevWorkflowOwnsInstance();
    if (keepAlive || workflowOwnsInstance) {
      const lines = keepAlive
        ? [
            `\n  Instance "${INSTANCE_NAME}" kept alive for debugging.`,
            `  To connect: brev refresh && ssh ${INSTANCE_NAME}`,
            `  To delete:  brev delete ${INSTANCE_NAME}\n`,
          ]
        : [`Instance "${INSTANCE_NAME}" deletion deferred to workflow-owned cleanup.`];
      console.log(lines.join("\n"));
      return;
    }
    deleteBrevInstance(requireInstanceName());
  }, 120_000); // 2 min for cleanup

  // NOTE: The full E2E test runs install.sh --non-interactive and owns the
  // complete sandbox lifecycle. The composite security suite also lets each
  // remote target own that lifecycle, without a shared harness registry.
  it.runIf(TEST_SUITE === "full")(
    "full E2E suite passes on remote VM",
    () => {
      const output = runRemoteVitest("e2e-live", "test/e2e/live/full-e2e.test.ts");
      expectVitestPassed(output);
    },
    900_000,
  );

  it.runIf(GPU_TEST_SUITE)(
    "GPU E2E suite passes on Brev GPU VM",
    () => {
      const output = runRemoteVitest("e2e-live", "test/e2e/live/gpu-e2e.test.ts");
      expectVitestPassed(output);
    },
    1_800_000,
  );

  it.runIf(TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE)(
    "tool-disclosure performance smoke passes on Brev CPU VM",
    () => {
      stopPerformanceSmokeMcpPlaceholder();
      const output = runRemoteVitest(
        "e2e-live",
        "test/e2e/live/tool-disclosure-performance-smoke.test.ts",
        BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_TIMEOUT_MS,
      );
      expectVitestPassed(output);
    },
    BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_TIMEOUT_MS + BREV_REMOTE_WRAPPER_GRACE_MS,
  );

  it.runIf(TEST_SUITE === "credential-sanitization" || TEST_SUITE === "all")(
    "credential sanitization suite passes on remote VM",
    () => {
      const output = runRemoteVitest(
        "e2e-live",
        "test/e2e/live/credential-sanitization.test.ts",
        BREV_SECURITY_SUITE_TIMEOUT_MS,
      );
      expectVitestPassed(output);
    },
    BREV_SECURITY_SUITE_TIMEOUT_MS + BREV_REMOTE_WRAPPER_GRACE_MS,
  );

  it.runIf(TEST_SUITE === "telegram-injection" || TEST_SUITE === "all")(
    "telegram bridge injection suite passes on remote VM",
    () => {
      const output = runRemoteVitest(
        "e2e-live",
        "test/e2e/live/telegram-injection.test.ts",
        BREV_SECURITY_SUITE_TIMEOUT_MS,
      );
      expectVitestPassed(output);
    },
    BREV_SECURITY_SUITE_TIMEOUT_MS + BREV_REMOTE_WRAPPER_GRACE_MS,
  );

  it.runIf(TEST_SUITE === "deploy-cli")(
    "deploy CLI provisions a remote sandbox end to end",
    () => {
      const sandboxList = ssh(
        "export PATH=$HOME/.local/bin:$PATH && openshell sandbox list 2>/dev/null",
        { timeout: 30_000 },
      );
      expect(sandboxList).toContain("e2e-test");
      expect(sandboxList).toContain("Ready");

      const registry = JSON.parse(ssh("cat ~/.nemoclaw/sandboxes.json", { timeout: 10_000 }));
      expect(registry.defaultSandbox).toBe("e2e-test");
      expect(registry.sandboxes).toHaveProperty("e2e-test");
    },
    120_000,
  );

  // This stateful target owns its sandbox and gateway lifecycle. Brev runs it
  // single-shot on a dedicated instance; a retry means a new workflow run and
  // therefore a new VM, never a second installer behind a live onboard lock.
  it.runIf(TEST_SUITE === "messaging-providers")(
    "messaging credential provider suite passes on remote VM",
    () => {
      const output = runRemoteVitest(
        "e2e-live",
        "test/e2e/live/messaging-providers.test.ts",
        BREV_MESSAGING_PROVIDER_TIMEOUT_MS,
      );
      expectVitestPassed(output);
    },
    BREV_MESSAGING_PROVIDER_TIMEOUT_MS + BREV_REMOTE_WRAPPER_GRACE_MS,
  );

  // The compatible-endpoint target also owns its sandbox lifecycle and runs
  // on a separate Brev instance so provider cleanup cannot leak across it.
  it.runIf(TEST_SUITE === "messaging-compatible-endpoint")(
    "messaging compatible endpoint suite passes on remote VM",
    () => {
      const output = runRemoteVitest(
        "e2e-live",
        "test/e2e/live/messaging-compatible-endpoint.test.ts",
        BREV_MESSAGING_COMPAT_TIMEOUT_MS,
      );
      expectVitestPassed(output);
    },
    BREV_MESSAGING_COMPAT_TIMEOUT_MS + BREV_REMOTE_WRAPPER_GRACE_MS,
  );

  it.runIf(TEST_SUITE === "dashboard-remote-bind")(
    "dashboard forward binds to all interfaces for remote browser origins",
    () => {
      const output = runRemoteCommand(
        [
          `NEMOCLAW_RUN_LIVE_E2E=1`,
          `NEMOCLAW_E2E_DASHBOARD_REMOTE_BIND=1`,
          `NEMOCLAW_SANDBOX_NAME=e2e-test`,
          `npx vitest run --project e2e-live`,
          `test/e2e/live/dashboard-remote-bind.test.ts`,
          `--silent=false --reporter=default`,
        ].join(" "),
        300_000,
      );
      expect(output).toContain("dashboard forward binds all interfaces");
      expect(output).not.toMatch(/FAIL|Failed/i);
    },
    300_000,
  );
});
