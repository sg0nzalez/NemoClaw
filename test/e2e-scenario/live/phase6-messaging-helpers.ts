// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isNvidiaEndpointRateLimitFailure } from "./messaging-providers-helpers.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const CLI = process.env.NEMOCLAW_CLI_BIN ?? path.join(REPO_ROOT, "bin", "nemoclaw.js");
export const REGISTRY_FILE = path.join(
  process.env.HOME ?? os.homedir(),
  ".nemoclaw",
  "sandboxes.json",
);

export const INSTALL_TIMEOUT_MS = 45 * 60_000;
export const REBUILD_TIMEOUT_MS = 30 * 60_000;
export const COMMAND_TIMEOUT_MS = 120_000;

export type AgentKind = "openclaw" | "hermes";
export type JsonRecord = Record<string, unknown>;

export type Phase6Tokens = {
  telegram: string;
  discord: string;
  slackBot: string;
  slackApp: string;
  wechat: string;
};

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function isFakeSlackToken(value: string): boolean {
  return /^(xoxb|xapp)-(fake|test)-/.test(value);
}

export function phase6Tokens(suffix: string): Phase6Tokens {
  return {
    telegram: process.env.TELEGRAM_BOT_TOKEN ?? `test-fake-telegram-token-${suffix}`,
    discord: process.env.DISCORD_BOT_TOKEN ?? `test-fake-discord-token-${suffix}`,
    slackBot: process.env.SLACK_BOT_TOKEN ?? `xoxb-fake-slack-token-${suffix}`,
    slackApp: process.env.SLACK_APP_TOKEN ?? `xapp-fake-slack-token-${suffix}`,
    wechat: process.env.WECHAT_BOT_TOKEN ?? `test-fake-wechat-token-${suffix}`,
  };
}

export function phase6Env(options: {
  sandboxName: string;
  agent?: AgentKind;
  apiKey?: string;
  tokens?: Phase6Tokens;
  extra?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  validateSandboxName(options.sandboxName);
  const tokens = options.tokens;
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_POLICY_TIER: process.env.NEMOCLAW_POLICY_TIER ?? "open",
    NEMOCLAW_SANDBOX_NAME: options.sandboxName,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...(options.agent ? { NEMOCLAW_AGENT: options.agent } : {}),
    ...(options.apiKey
      ? { NVIDIA_INFERENCE_API_KEY: options.apiKey, NVIDIA_API_KEY: options.apiKey }
      : {}),
    ...(tokens
      ? {
          TELEGRAM_BOT_TOKEN: tokens.telegram,
          TELEGRAM_ALLOWED_IDS: process.env.TELEGRAM_ALLOWED_IDS ?? "123456789,987654321",
          TELEGRAM_REQUIRE_MENTION: process.env.TELEGRAM_REQUIRE_MENTION ?? "0",
          DISCORD_BOT_TOKEN: tokens.discord,
          DISCORD_SERVER_ID: process.env.DISCORD_SERVER_ID ?? "1491590992753590594",
          DISCORD_SERVER_IDS:
            process.env.DISCORD_SERVER_IDS ??
            process.env.DISCORD_SERVER_ID ??
            "1491590992753590594",
          DISCORD_USER_ID: process.env.DISCORD_USER_ID ?? "1005536447329222676",
          DISCORD_ALLOWED_IDS:
            process.env.DISCORD_ALLOWED_IDS ?? process.env.DISCORD_USER_ID ?? "1005536447329222676",
          DISCORD_REQUIRE_MENTION: process.env.DISCORD_REQUIRE_MENTION ?? "0",
          SLACK_BOT_TOKEN: tokens.slackBot,
          SLACK_APP_TOKEN: tokens.slackApp,
          SLACK_ALLOWED_USERS: process.env.SLACK_ALLOWED_USERS ?? "U0123456789,U09ABCDEFGH",
          WECHAT_BOT_TOKEN: tokens.wechat,
          WECHAT_ACCOUNT_ID:
            process.env.WECHAT_ACCOUNT_ID ?? `e2e-fake-account-${options.sandboxName}`,
          WECHAT_BASE_URL: process.env.WECHAT_BASE_URL ?? "https://ilinkai.wechat.com",
          WECHAT_USER_ID: process.env.WECHAT_USER_ID ?? "wxid_e2e_operator",
          WECHAT_ALLOWED_IDS:
            process.env.WECHAT_ALLOWED_IDS ?? process.env.WECHAT_USER_ID ?? "wxid_e2e_operator",
        }
      : {}),
    ...options.extra,
  };

  if (tokens?.telegram.includes("fake") && !env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY) {
    env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
  }
  if (
    tokens &&
    !env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION &&
    (isFakeSlackToken(tokens.slackBot) || isFakeSlackToken(tokens.slackApp))
  ) {
    env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";
  }
  return env;
}

export function redactionValues(apiKey: string | undefined, tokens?: Phase6Tokens): string[] {
  return [apiKey, ...(tokens ? Object.values(tokens) : [])].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup and diagnostics must not hide primary test failures.
  }
}

export function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label}\n${resultText(result)}`).toBe(0);
}

export async function precleanSandbox(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  prefix: string,
): Promise<void> {
  await bestEffort(() =>
    host.command("node", [CLI, sandboxName, "destroy", "--yes"], {
      artifactName: `${prefix}-nemoclaw-destroy`,
      env,
      redactionValues: redactions,
      timeoutMs: 15 * 60_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["sandbox", "delete", sandboxName], {
      artifactName: `${prefix}-openshell-sandbox-delete`,
      env,
      redactionValues: redactions,
      timeoutMs: 120_000,
    }),
  );
}

export async function cleanupSandbox(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  prefix: string,
): Promise<void> {
  await precleanSandbox(host, sandboxName, env, redactions, prefix);
}

export async function installSandbox(
  host: HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  const result = await host.command("bash", ["install.sh", "--non-interactive"], {
    artifactName,
    cwd: REPO_ROOT,
    env,
    redactionValues: redactions,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 && isNvidiaEndpointRateLimitFailure(resultText(result))) {
    throw new Error(`NVIDIA_ENDPOINT_RATE_LIMIT:${artifactName}`);
  }
  return result;
}

export async function installSandboxOrSkipOnRateLimit(
  host: HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
  skip: (note?: string) => never,
  skipMessage: string,
): Promise<ShellProbeResult> {
  try {
    return await installSandbox(host, env, redactions, artifactName);
  } catch (error) {
    if (String(error).includes("NVIDIA_ENDPOINT_RATE_LIMIT")) {
      skip(skipMessage);
    }
    throw error;
  }
}

export async function rebuildSandbox(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  return host.command("node", [CLI, sandboxName, "rebuild", "--yes"], {
    artifactName,
    env,
    redactionValues: redactions,
    timeoutMs: REBUILD_TIMEOUT_MS,
  });
}

export async function expectSandboxReady(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
): Promise<void> {
  const list = await host.command("openshell", ["sandbox", "list"], {
    artifactName,
    env,
    redactionValues: redactions,
    timeoutMs: 60_000,
  });
  expectExitZero(list, "openshell sandbox list");
  const row = stripAnsi(list.stdout)
    .split(/\r?\n/)
    .find((line) => line.includes(sandboxName));
  expect(row, resultText(list)).toMatch(/\bReady\b/i);
}

export function readRegistryEntry(sandboxName: string): JsonRecord {
  expect(fs.existsSync(REGISTRY_FILE), `${REGISTRY_FILE} missing`).toBe(true);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, JsonRecord>;
  };
  const entry = registry.sandboxes?.[sandboxName];
  expect(entry, `registry entry ${sandboxName} missing`).toBeTruthy();
  if (!entry) throw new Error(`registry entry ${sandboxName} missing`);
  return entry;
}

export function messagingPlan(sandboxName: string): JsonRecord {
  const messaging = readRegistryEntry(sandboxName).messaging;
  expect(messaging && typeof messaging === "object", "registry messaging state missing").toBe(true);
  const plan = (messaging as JsonRecord).plan;
  expect(plan && typeof plan === "object", "registry messaging.plan missing").toBe(true);
  if (!plan || typeof plan !== "object") throw new Error("registry messaging.plan missing");
  return plan as JsonRecord;
}

export function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object")
    : [];
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function sandboxSh(
  sandbox: SandboxClient,
  sandboxName: string,
  script: string,
  options: {
    artifactName: string;
    redactionValues?: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName: options.artifactName,
    env: sandboxAccessEnv(),
    redactionValues: options.redactionValues ?? [],
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

export async function sandboxEncodedSh(
  sandbox: SandboxClient,
  sandboxName: string,
  script: string,
  args: string[],
  options: {
    artifactName: string;
    redactionValues?: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  const command = [
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    `printf %s ${shellQuote(base64(script))} | base64 -d > "$tmp"`,
    `sh "$tmp" ${args.map(shellQuote).join(" ")}`,
  ].join("; ");
  return sandboxSh(sandbox, sandboxName, command, options);
}

export async function sandboxNode(
  sandbox: SandboxClient,
  sandboxName: string,
  source: string,
  env: Record<string, string>,
  options: {
    artifactName: string;
    redactionValues?: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  return sandboxEncodedSh(
    sandbox,
    sandboxName,
    `${exports}\nnode --input-type=module <<'NODE'\n${source}\nNODE\n`,
    [],
    options,
  );
}

export async function dockerInfo(
  host: HostCliClient,
  env: NodeJS.ProcessEnv,
): Promise<ShellProbeResult> {
  return host.command("docker", ["info"], {
    artifactName: "phase6-docker-info",
    env,
    timeoutMs: 30_000,
  });
}
