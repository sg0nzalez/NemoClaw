// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  DEFAULT_SYNTHETIC_CATALOG_SEED,
  generateCatalogPrefix,
  generateSyntheticCatalog,
} from "../../../scripts/bench/tool-disclosure/catalog";
import {
  buildAgentDriverCommand,
  extractFinalAssistantOutput,
} from "../../../scripts/bench/tool-disclosure/drivers";
import { gradeTaskRun } from "../../../scripts/bench/tool-disclosure/grading";
import { SyntheticMcpServer } from "../../../scripts/bench/tool-disclosure/mcp-server";
import { startQuickTunnel } from "../../../scripts/bench/tool-disclosure/quick-tunnel";
import type { ToolDisclosureMode } from "../../../scripts/bench/tool-disclosure/schedule";
import { generatePrimaryTaskSet } from "../../../scripts/bench/tool-disclosure/tasks";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, sandboxAccessEnv } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";

const AGENT = "langchain-deepagents-code" as const;
const CATALOG_SIZE = 64;
const TASK_ID = "primary-single-01";
const MODES = ["progressive", "direct"] as const satisfies readonly ToolDisclosureMode[];
const MCP_SERVER_NAME = "benchmark";
const MCP_TOKEN_ENV = "NEMOCLAW_BENCHMARK_MCP_BEARER";
const TEST_TIMEOUT_MS = 50 * 60_000;

function sandboxName(mode: ToolDisclosureMode): string {
  return `e2e-tool-disclosure-${mode}`;
}

function hostEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

function gitSha(): string {
  const sha =
    process.env.GITHUB_SHA?.trim() ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("tool-disclosure smoke requires a git SHA");
  return sha;
}

test.skipIf(!shouldRunLiveE2E())(
  "tool disclosure hosted-inference smoke completes one frozen task in both modes",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const bearerToken = randomBytes(32).toString("hex");
    artifacts.addRedactionValues([hosted.apiKey, bearerToken]);

    const catalog = generateSyntheticCatalog({ seed: DEFAULT_SYNTHETIC_CATALOG_SEED });
    const catalogPrefix = generateCatalogPrefix(catalog, CATALOG_SIZE);
    const primaryTasks = generatePrimaryTaskSet(catalog);
    const task = primaryTasks.tasks.find((candidate) => candidate.id === TASK_ID);
    if (!task) throw new Error(`frozen task ${TASK_ID} is missing`);
    if (task.min_catalog_size > catalogPrefix.size) {
      throw new Error(`frozen task ${TASK_ID} does not fit the smoke catalog`);
    }

    await artifacts.writeJson("scenario.json", {
      id: "tool-disclosure-smoke",
      boundary: "two real Deep Agents Code sandboxes with hosted inference and synthetic MCP",
      claim_eligible: false,
      agent: AGENT,
      modes: MODES,
      catalog_size: CATALOG_SIZE,
      task_id: TASK_ID,
      model_id: hosted.model,
    });

    const mcp = new SyntheticMcpServer(catalogPrefix, bearerToken);
    const mcpAddress = await mcp.start();
    cleanup.add("stop tool-disclosure synthetic MCP server", () => mcp.stop());
    const tunnel = await startQuickTunnel({ port: mcpAddress.port });
    cleanup.add("stop tool-disclosure MCP quick tunnel", () => tunnel.close());

    for (const mode of MODES) {
      const name = sandboxName(mode);
      cleanup.add(`destroy ${mode} tool-disclosure smoke sandbox`, () =>
        host.bestEffortCleanupSandbox(name, {
          artifactName: `cleanup-${mode}-tool-disclosure-sandbox`,
          env: hostEnv(),
        }),
      );
      await host.cleanupSandbox(name, {
        artifactName: `preclean-${mode}-tool-disclosure-sandbox`,
        env: hostEnv(),
      });

      const onboard = await host.nemoclaw(
        [
          "onboard",
          "--non-interactive",
          "--fresh",
          "--yes",
          "--yes-i-accept-third-party-software",
          "--agent",
          AGENT,
          "--name",
          name,
          "--tool-disclosure",
          mode,
        ],
        {
          artifactName: `onboard-tool-disclosure-${mode}`,
          env: hostEnv({
            ...hosted.env,
            NEMOCLAW_AGENT: AGENT,
            NEMOCLAW_RECREATE_SANDBOX: "1",
            NEMOCLAW_SANDBOX_NAME: name,
            NEMOCLAW_TOOL_DISCLOSURE: mode,
          }),
          redactionValues: [hosted.apiKey],
          timeoutMs: 20 * 60_000,
        },
      );
      expect(onboard.exitCode, resultText(onboard)).toBe(0);

      const attestation = await sandbox.exec(
        name,
        ["sh", "-c", `test "$NEMOCLAW_TOOL_DISCLOSURE" = ${JSON.stringify(mode)}`],
        {
          artifactName: `attest-tool-disclosure-${mode}`,
          env: sandboxAccessEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(attestation.exitCode, resultText(attestation)).toBe(0);
    }

    for (const mode of MODES) {
      const add = await host.nemoclaw(
        [
          sandboxName(mode),
          "mcp",
          "add",
          MCP_SERVER_NAME,
          "--url",
          tunnel.mcpUrl,
          "--env",
          MCP_TOKEN_ENV,
        ],
        {
          artifactName: `add-tool-disclosure-mcp-${mode}`,
          env: hostEnv({ [MCP_TOKEN_ENV]: bearerToken }),
          redactionValues: [bearerToken],
          timeoutMs: 5 * 60_000,
        },
      );
      expect(add.exitCode, resultText(add)).toBe(0);
    }

    const results = [];
    for (const mode of MODES) {
      const runId = `smoke-${AGENT}-${mode}-${TASK_ID}`;
      const driver = buildAgentDriverCommand({
        openshellBin: process.env.OPENSHELL_BIN,
        sandboxName: sandboxName(mode),
        agent: AGENT,
        prompt: task.prompt,
        sessionId: runId,
      });
      mcp.beginRun(runId);
      const startedAt = process.hrtime.bigint();
      let invocation;
      let calls;
      try {
        invocation = await host.command(driver.command, driver.args, {
          artifactName: `invoke-tool-disclosure-${mode}`,
          env: hostEnv(),
          redactionValues: [...driver.redactions, hosted.apiKey, bearerToken],
          timeoutMs: 10 * 60_000,
        });
      } finally {
        calls = mcp.endRun();
      }
      const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const finalOutput = extractFinalAssistantOutput(AGENT, invocation.stdout);
      const graded = gradeTaskRun(task, calls, finalOutput);
      const outcome = invocation.timedOut
        ? "timeout"
        : invocation.exitCode === 0
          ? graded.outcome
          : "model-error";
      results.push({
        run_id: runId,
        mode,
        outcome,
        invocation: {
          exit_code: invocation.exitCode,
          timed_out: invocation.timedOut,
          elapsed_ms: elapsedMs,
        },
        synthetic_call_count: calls.length,
        correctness: graded.correctness,
      });
    }

    await artifacts.writeJson("tool-disclosure-smoke.json", {
      schema_version: "nemoclaw.tool_disclosure_smoke.v1",
      generated_at: new Date().toISOString(),
      claim_eligible: false,
      sut_git_sha: gitSha(),
      profile: {
        agent: AGENT,
        modes: MODES,
        catalog_seed: catalog.seed,
        catalog_size: CATALOG_SIZE,
        catalog_tools_sha256: catalogPrefix.tools_sha256,
        task_id: task.id,
        task_kind: task.kind,
        task_set_sha256: primaryTasks.tasks_sha256,
        repetitions_per_mode: 1,
        observed_runs: results.length,
      },
      inference: {
        api: "openai-compatible",
        model_id: hosted.model,
      },
      results,
      limitations: [
        "This smoke verifies live wiring and task completion; it is not the full benchmark.",
        "One observation per mode is insufficient for performance or quality claims.",
        "The fixed progressive-then-direct order makes elapsed times informational and subject to cold-cache and ordering effects.",
        "The smoke does not collect vLLM tokenizer, token-counter, or request-recorder evidence.",
      ],
    });

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.outcome, `${result.mode} smoke outcome`).toBe("success");
      expect(result.correctness.task_success, `${result.mode} task correctness`).toBe(true);
      expect(result.synthetic_call_count, `${result.mode} synthetic call count`).toBe(1);
    }
  },
);
