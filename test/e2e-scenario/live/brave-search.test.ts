// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-brave-search-e2e.sh.
 *
 * Preserves the legacy #2687 acceptance boundary: non-interactive onboard with
 * a real BRAVE_API_KEY, brave policy/config wiring, secret non-leak checks,
 * a real agent web-search turn, and a direct in-sandbox Brave API curl using
 * the OpenShell credential placeholder.
 */

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-brave-search";
validateSandboxName(SANDBOX_NAME);
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
const LIVE_TIMEOUT_MS = 35 * 60_000;
const PLACEHOLDER_PATTERN = /^openshell:resolve:env:([A-Za-z0-9_]+_)?BRAVE_API_KEY$/;

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup should not mask primary failures.
  }
}

function singleLineShell(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; printf %s '${encoded}' | base64 -d > "$tmp"; sh "$tmp"`;
}

async function sandboxShell(
  sandbox: SandboxClient,
  script: string,
  options: { artifactName: string; timeoutMs?: number; redactionValues?: string[] },
): Promise<ShellProbeResult> {
  return await sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(singleLineShell(script)), {
    artifactName: options.artifactName,
    env: commandEnv(),
    timeoutMs: options.timeoutMs ?? 60_000,
    redactionValues: options.redactionValues,
  });
}

async function cleanupBraveSandbox(sandbox: SandboxClient): Promise<void> {
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-delete-brave-search",
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

function parsePlaceholder(configText: string): string | undefined {
  const parsed = JSON.parse(configText) as {
    tools?: { web?: { search?: { apiKey?: unknown } } };
  };
  const value = parsed.tools?.web?.search?.apiKey;
  return typeof value === "string" && value ? value : undefined;
}

function extractOpenClawAgentText(output: string): string {
  for (const index of [...output]
    .map((char, idx) => (char === "{" ? idx : -1))
    .filter((idx) => idx >= 0)) {
    try {
      const parsed = JSON.parse(output.slice(index)) as {
        payloads?: Array<{ text?: unknown }>;
        meta?: { finalAssistantVisibleText?: unknown };
      };
      const payloadText = parsed.payloads
        ?.map((payload) => payload.text)
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (payloadText) return payloadText;
      if (typeof parsed.meta?.finalAssistantVisibleText === "string") {
        return parsed.meta.finalAssistantVisibleText;
      }
    } catch {
      // Keep scanning; OpenClaw can emit non-JSON progress before the result.
    }
  }
  return "";
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "Brave search preset wires policy/config, hides the real key, and performs real searches (#2687)",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const braveKey = secrets.required("BRAVE_API_KEY");
    const inferenceKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const redactionValues = [braveKey, inferenceKey];

    await artifacts.writeJson("scenario.json", {
      id: "brave-search",
      runner: "vitest",
      legacySource: "test/e2e/test-brave-search-e2e.sh",
      boundary:
        "source CLI onboard + OpenShell policy/config + in-sandbox OpenClaw/Brave API calls",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "onboard succeeds with BRAVE_API_KEY present",
        "the brave network policy preset includes api.search.brave.com",
        "OpenClaw web search config is enabled and selects provider=brave",
        "the real BRAVE_API_KEY is absent from openclaw.json and sandbox shell env",
        "OpenClaw agent can perform a Brave-backed web search",
        "curl from inside the sandbox can query Brave using the placeholder token header",
      ],
    });

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for Brave search E2E: ${resultText(dockerInfo)}`);
      }
      skip(`Docker is required for Brave search E2E: ${resultText(dockerInfo)}`);
    }

    cleanup.add(`destroy brave search sandbox ${SANDBOX_NAME}`, async () => {
      await bestEffort(() =>
        host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-brave-search",
          env: commandEnv(),
          timeoutMs: 120_000,
        }),
      );
      await cleanupBraveSandbox(sandbox);
    });

    await bestEffort(() =>
      host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-brave-search",
        env: commandEnv(),
        timeoutMs: 120_000,
      }),
    );
    await cleanupBraveSandbox(sandbox);

    let onboard: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
      onboard = await host.command(
        "node",
        [
          CLI_ENTRYPOINT,
          "onboard",
          "--fresh",
          "--non-interactive",
          "--yes-i-accept-third-party-software",
        ],
        {
          artifactName:
            attempt === 1
              ? "phase-1-onboard-brave-search"
              : `phase-1-onboard-brave-search-attempt-${attempt}`,
          cwd: REPO_ROOT,
          env: commandEnv({
            BRAVE_API_KEY: braveKey,
            NVIDIA_INFERENCE_API_KEY: inferenceKey,
            NVIDIA_API_KEY: inferenceKey,
          }),
          redactionValues,
          timeoutMs: 20 * 60_000,
        },
      );
      if (onboard.exitCode === 0) break;
      if (isTransientProviderValidationFailure(onboard) && attempt < INSTALL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
        continue;
      }
      break;
    }
    expect(onboard, "onboard command must run").toBeDefined();
    expect(onboard?.exitCode, resultText(onboard as ShellProbeResult)).toBe(0);

    const policy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
      artifactName: "phase-2-brave-policy",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(policy.exitCode, resultText(policy)).toBe(0);
    expect(resultText(policy)).toContain("api.search.brave.com");

    const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.openclaw/openclaw.json"], {
      artifactName: "phase-2-openclaw-config",
      env: commandEnv(),
      redactionValues,
      timeoutMs: 60_000,
    });
    expect(config.exitCode, resultText(config)).toBe(0);
    const rawLeakCheck = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `python3 - <<'PY'
from pathlib import Path
needle = ${JSON.stringify(braveKey)}
body = Path('/sandbox/.openclaw/openclaw.json').read_text(encoding='utf-8')
raise SystemExit(1 if needle in body else 0)
PY`,
      ),
      {
        artifactName: "phase-3-openclaw-config-raw-secret-leak-check",
        env: commandEnv(),
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expect(
      rawLeakCheck.exitCode,
      "raw BRAVE_API_KEY must not appear anywhere in openclaw.json",
    ).toBe(0);
    const parsedConfig = JSON.parse(config.stdout) as {
      tools?: { web?: { search?: { enabled?: unknown; provider?: unknown; apiKey?: unknown } } };
    };
    const searchConfig = parsedConfig.tools?.web?.search;
    expect(searchConfig?.enabled, config.stdout).toBe(true);
    expect(searchConfig?.provider, config.stdout).toBe("brave");
    const placeholder = parsePlaceholder(config.stdout);
    expect(placeholder, config.stdout).toMatch(PLACEHOLDER_PATTERN);

    const envCheck = await sandbox.exec(
      SANDBOX_NAME,
      ["sh", "-lc", "printenv BRAVE_API_KEY || true"],
      {
        artifactName: "phase-3-sandbox-brave-env",
        env: commandEnv(),
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expect(envCheck.exitCode, resultText(envCheck)).toBe(0);
    expect(envCheck.stdout).not.toContain(braveKey);
    if (envCheck.stdout.trim()) expect(envCheck.stdout.trim()).toMatch(PLACEHOLDER_PATTERN);

    const agent = await sandboxShell(
      sandbox,
      `openclaw agent --agent main --json --session-id e2e-brave-agent-$$ -m 'Use the web search tool to find one result for the query: NVIDIA. Reply with only the title of the top result.'`,
      {
        artifactName: "phase-4a-agent-web-search",
        timeoutMs: 150_000,
        redactionValues,
      },
    );
    expect(resultText(agent)).not.toMatch(
      /SsrFBlockedError|Blocked hostname|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error/i,
    );
    expect(agent.exitCode, resultText(agent)).toBe(0);
    const assistantText = extractOpenClawAgentText(agent.stdout);
    expect(assistantText, resultText(agent)).toMatch(/nvidia|geforce|cuda|gpu/i);

    const curl = await sandboxShell(
      sandbox,
      `curl -sS --max-time 20 -G 'https://api.search.brave.com/res/v1/web/search' --data-urlencode 'q=NVIDIA' --data-urlencode 'count=1' -H 'X-Subscription-Token: ${placeholder}' -w '\nHTTP_STATUS:%{http_code}\n'`,
      {
        artifactName: "phase-4b-direct-brave-curl",
        timeoutMs: 60_000,
        redactionValues,
      },
    );
    const status = resultText(curl).match(/HTTP_STATUS:(\d{3})/)?.[1];
    expect(status, resultText(curl)).toBe("200");
    const body = resultText(curl).replace(/\n?HTTP_STATUS:\d{3}\s*$/u, "");
    const braveResponse = JSON.parse(body) as { web?: { results?: unknown[] } };
    expect(braveResponse.web?.results?.length ?? 0, body.slice(0, 500)).toBeGreaterThan(0);
  },
);
