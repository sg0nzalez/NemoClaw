// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_SYNTHETIC_PERFORMANCE_TEST_CATALOG_SEED,
  generateCatalogPrefix,
  generateSyntheticCatalog,
} from "../../../scripts/performance/tool-disclosure/catalog";
import {
  createOpenAIChatTaskDecomposer,
  PortableHashingTextEmbedder,
} from "../../../scripts/performance/tool-disclosure/compositional-tool-routing-adapters";
import { runCompositionalRoutingAcceptance } from "../../../scripts/performance/tool-disclosure/compositional-tool-routing-run";
import { CompositionalToolRoutingTransform } from "../../../scripts/performance/tool-disclosure/compositional-tool-routing-transform";
import {
  buildAgentDriverCommand,
  extractFinalAssistantOutput,
} from "../../../scripts/performance/tool-disclosure/drivers";
import { gradeTaskRun } from "../../../scripts/performance/tool-disclosure/grading";
import { SyntheticMcpServer } from "../../../scripts/performance/tool-disclosure/mcp-server";
import { startQuickTunnel } from "../../../scripts/performance/tool-disclosure/quick-tunnel";
import { createToolDisclosureRecordingProxy } from "../../../scripts/performance/tool-disclosure/recorder";
import type { ToolDisclosureMode } from "../../../scripts/performance/tool-disclosure/schedule";
import { generatePrimaryTaskSet } from "../../../scripts/performance/tool-disclosure/tasks";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "../../../src/lib/onboard/env";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, sandboxAccessEnv } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";

const AGENT = "langchain-deepagents-code" as const;
const CATALOG_SIZE = 64;
const TASK_ID = "primary-single-01";
const MODES = ["progressive", "direct"] as const satisfies readonly ToolDisclosureMode[];
const MCP_SERVER_NAME = "performance-test";
const MCP_TOKEN_ENV = "TOOL_DISCLOSURE_PERFORMANCE_TEST_MCP_TOKEN";
const OPENSHELL_DOCKER_NETWORK =
  process.env.OPENSHELL_DOCKER_NETWORK_NAME?.trim() || "openshell-docker";
const PRIVATE_BRIDGE_PROBE_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const TEST_TIMEOUT_MS = 50 * 60_000;
const ROUTING_DECOMPOSER_MAX_ATTEMPTS = 2;
const ROUTING_DECOMPOSER_REQUEST_TIMEOUT_MS = 120_000;
const ROUTE_ONLY_RUN_TIMEOUT_MS = 900_000;
const ROUTED_PROXY_REQUEST_TIMEOUT_MS = 720_000;
const ROUTED_GATEWAY_REQUEST_TIMEOUT_MS = 840_000;
const ROUTED_AGENT_INVOCATION_TIMEOUT_MS = 900_000;
const RESTORED_GATEWAY_REQUEST_TIMEOUT_MS = LOCAL_INFERENCE_TIMEOUT_SECS * 1_000;

function sandboxName(mode: ToolDisclosureMode): string {
  return `e2e-tool-disclosure-performance-${mode}`;
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
  return /^[a-f0-9]{40}$/u.test(sha)
    ? sha
    : (() => {
        throw new Error("tool-disclosure performance smoke requires a git SHA");
      })();
}

test(
  "tool disclosure hosted-inference performance smoke completes one frozen task in both modes",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const bearerToken = randomBytes(32).toString("hex");
    const routingIngressToken = randomBytes(32).toString("hex");
    artifacts.addRedactionValues([
      hosted.apiKey,
      hosted.endpointUrl,
      bearerToken,
      routingIngressToken,
    ]);

    const routingCredentialEnv = "NEMOCLAW_COMPOSITIONAL_ROUTING_SMOKE_API_KEY";
    const previousRoutingCredential = process.env[routingCredentialEnv];
    process.env[routingCredentialEnv] = hosted.apiKey;
    let routingAcceptance: Awaited<ReturnType<typeof runCompositionalRoutingAcceptance>>;
    try {
      routingAcceptance = await runCompositionalRoutingAcceptance({
        decomposer: {
          base_url: hosted.endpointUrl,
          model: hosted.model,
          revision: process.env.NEMOCLAW_MODEL_REVISION?.trim() || "unreported",
          api_key_env: routingCredentialEnv,
          allow_remote: true,
          reasoning_control: "enable_thinking_false",
          json_object_response: true,
          max_attempts: ROUTING_DECOMPOSER_MAX_ATTEMPTS,
        },
        embedding: { kind: "portable" },
        timeout_ms: ROUTING_DECOMPOSER_REQUEST_TIMEOUT_MS,
        run_timeout_ms: ROUTE_ONLY_RUN_TIMEOUT_MS,
      });
    } finally {
      previousRoutingCredential === undefined
        ? delete process.env[routingCredentialEnv]
        : (process.env[routingCredentialEnv] = previousRoutingCredential);
    }
    await artifacts.writeJson("compositional-routing-acceptance.json", routingAcceptance);
    expect(routingAcceptance.acceptance_passed).toBe(true);

    const catalog = generateSyntheticCatalog({
      seed: DEFAULT_SYNTHETIC_PERFORMANCE_TEST_CATALOG_SEED,
    });
    const catalogPrefix = generateCatalogPrefix(catalog, CATALOG_SIZE);
    const primaryTasks = generatePrimaryTaskSet(catalog);
    const task = primaryTasks.tasks.find((candidate) => candidate.id === TASK_ID);
    expect(task, `frozen task ${TASK_ID} is missing`).toBeDefined();
    const frozenTask = task as NonNullable<typeof task>;
    expect(
      frozenTask.min_catalog_size,
      `frozen task ${TASK_ID} does not fit the performance smoke catalog`,
    ).toBeLessThanOrEqual(catalogPrefix.size);

    await artifacts.writeJson("scenario.json", {
      id: "tool-disclosure-performance-smoke",
      boundary:
        "tool-disclosure performance smoke with two real Deep Agents Code sandboxes, hosted inference, and synthetic MCP",
      claim_eligible: false,
      agent: AGENT,
      modes: MODES,
      catalog_size: CATALOG_SIZE,
      task_id: TASK_ID,
      model_id: hosted.model,
    });

    const mcp = new SyntheticMcpServer(catalogPrefix, bearerToken);
    const mcpAddress = await mcp.start();
    cleanup.add("stop tool-disclosure performance synthetic MCP server", () => mcp.stop());
    const tunnel = await startQuickTunnel({ port: mcpAddress.port });
    cleanup.add("stop tool-disclosure performance MCP quick tunnel", () => tunnel.close());

    for (const mode of MODES) {
      const name = sandboxName(mode);
      cleanup.add(`destroy ${mode} tool-disclosure performance smoke sandbox`, () =>
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
        [
          "nemoclaw-start",
          "sh",
          "-c",
          `test "$NEMOCLAW_TOOL_DISCLOSURE" = ${JSON.stringify(mode)}`,
        ],
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
      const runId = `performance-smoke-${AGENT}-${mode}-${TASK_ID}`;
      const driver = buildAgentDriverCommand({
        openshellBin: process.env.OPENSHELL_BIN,
        sandboxName: sandboxName(mode),
        agent: AGENT,
        prompt: frozenTask.prompt,
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
      const graded = gradeTaskRun(frozenTask, calls, finalOutput);
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

    const routedRunId = `performance-smoke-${AGENT}-compositional-${TASK_ID}`;
    const routedToolNames = new Set(
      catalogPrefix.tools.map((tool) => `${MCP_SERVER_NAME}_${tool.definition.function.name}`),
    );
    const expectedRoutedToolName = `${MCP_SERVER_NAME}_${frozenTask.expected_calls[0]?.tool_name ?? ""}`;
    expect(
      routedToolNames.has(expectedRoutedToolName),
      "the routed replay target is not present in the reviewed catalog",
    ).toBe(true);
    const routedTransform = new CompositionalToolRoutingTransform({
      decomposer: createOpenAIChatTaskDecomposer({
        baseUrl: hosted.endpointUrl,
        model: hosted.model,
        apiKey: hosted.apiKey,
        allowRemote: true,
        reasoningControl: "enable_thinking_false",
        jsonObjectResponse: true,
        maxAttempts: ROUTING_DECOMPOSER_MAX_ATTEMPTS,
        timeoutMs: ROUTING_DECOMPOSER_REQUEST_TIMEOUT_MS,
      }),
      embedder: new PortableHashingTextEmbedder(),
      isRoutableTool: (name) => routedToolNames.has(name),
      requireRouting: true,
    });
    const networkInspect = await host.command(
      "docker",
      ["network", "inspect", "--format", "{{json .IPAM.Config}}", OPENSHELL_DOCKER_NETWORK],
      {
        artifactName: "compositional-routing-private-network",
        env: hostEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(networkInspect.exitCode, resultText(networkInspect)).toBe(0);
    const networkIpam = JSON.parse(networkInspect.stdout) as Array<{
      Gateway?: unknown;
    }>;
    const privateListenHost = networkIpam
      .map((entry) => entry.Gateway)
      .find((gateway): gateway is string => typeof gateway === "string" && gateway.includes("."));
    expect(privateListenHost, "OpenShell Docker network has no IPv4 gateway").toBeDefined();
    const recorderListenHost = privateListenHost as string;
    const routedProxy = createToolDisclosureRecordingProxy({
      upstreamBaseUrl: hosted.endpointUrl,
      allowRemoteHttpsUpstream: true,
      listenHost: recorderListenHost,
      allowAuthenticatedPrivateIpv4Listener: true,
      requiredAuthorization: `Bearer ${routingIngressToken}`,
      upstreamAuthorization: `Bearer ${hosted.apiKey}`,
      requestTimeoutMs: ROUTED_PROXY_REQUEST_TIMEOUT_MS,
      requestTransform: routedTransform.requestTransform,
    });
    const routedProxyAddress = await routedProxy.start();
    cleanup.add("stop compositional routing recording proxy", () => routedProxy.stop());
    expect(routedProxyAddress.host).toBe(recorderListenHost);
    expect(routedProxyAddress.port).toBeGreaterThanOrEqual(1_024);

    const bridgeProbe = await host.command(
      "docker",
      [
        "run",
        "--rm",
        "--pull=missing",
        "--network",
        OPENSHELL_DOCKER_NETWORK,
        PRIVATE_BRIDGE_PROBE_IMAGE,
        "nc",
        "-zw5",
        recorderListenHost,
        String(routedProxyAddress.port),
      ],
      {
        artifactName: "compositional-routing-private-reachability",
        env: hostEnv(),
        redactionValues: [routedProxyAddress.base_url],
        timeoutMs: 30_000,
      },
    );
    expect(
      bridgeProbe.exitCode,
      `OpenShell Docker network cannot reach the authenticated routing bridge: ${resultText(bridgeProbe)}`,
    ).toBe(0);

    const configureInferenceRoute = async (
      baseUrl: string,
      artifactSuffix: string,
      credential: string,
      timeoutMs: number,
    ) => {
      artifacts.addRedactionValues([baseUrl, credential]);
      const providerEnv = hostEnv({
        [hosted.credentialEnv]: credential,
      });
      const update = await host.command(
        "openshell",
        [
          "provider",
          "update",
          hosted.providerName,
          "--credential",
          hosted.credentialEnv,
          "--config",
          `OPENAI_BASE_URL=${baseUrl}`,
        ],
        {
          artifactName: `compositional-routing-provider-${artifactSuffix}`,
          env: providerEnv,
          redactionValues: [hosted.apiKey, routingIngressToken, baseUrl, credential],
          timeoutMs: 2 * 60_000,
        },
      );
      expect(update.exitCode, resultText(update)).toBe(0);
      const select = await host.command(
        "openshell",
        [
          "inference",
          "set",
          "--no-verify",
          "--provider",
          hosted.providerName,
          "--model",
          hosted.model,
          "--timeout",
          String(timeoutMs / 1_000),
        ],
        {
          artifactName: `compositional-routing-select-${artifactSuffix}`,
          env: providerEnv,
          redactionValues: [hosted.apiKey, routingIngressToken, baseUrl, credential],
          timeoutMs: 2 * 60_000,
        },
      );
      expect(select.exitCode, resultText(select)).toBe(0);
    };

    let providerRestore: Promise<void> | undefined;
    const restoreInferenceRoute = (): Promise<void> =>
      providerRestore ??
      (providerRestore = configureInferenceRoute(
        hosted.endpointUrl,
        "restore",
        hosted.apiKey,
        RESTORED_GATEWAY_REQUEST_TIMEOUT_MS,
      ).catch((error: unknown) => {
        providerRestore = undefined;
        throw error;
      }));
    cleanup.add("restore hosted inference route", restoreInferenceRoute);

    let routedReplay: Record<string, unknown> | undefined;
    try {
      await configureInferenceRoute(
        `${routedProxyAddress.base_url}/v1`,
        "enable",
        routingIngressToken,
        ROUTED_GATEWAY_REQUEST_TIMEOUT_MS,
      );
      const driver = buildAgentDriverCommand({
        openshellBin: process.env.OPENSHELL_BIN,
        sandboxName: sandboxName("direct"),
        agent: AGENT,
        prompt: frozenTask.prompt,
        sessionId: routedRunId,
      });
      mcp.beginRun(routedRunId);
      routedProxy.beginRun(routedRunId);
      const startedAt = process.hrtime.bigint();
      let invocation;
      let calls;
      let recorderEvents;
      try {
        invocation = await host.command(driver.command, driver.args, {
          artifactName: "invoke-tool-disclosure-compositional",
          env: hostEnv(),
          redactionValues: [
            ...driver.redactions,
            hosted.apiKey,
            bearerToken,
            routingIngressToken,
            routedProxyAddress.base_url,
          ],
          timeoutMs: ROUTED_AGENT_INVOCATION_TIMEOUT_MS,
        });
      } finally {
        calls = mcp.endRun();
        recorderEvents = routedProxy.endRun();
      }
      const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const routeEvidence = await routedTransform.consumeEvidence(routedRunId);
      const finalOutput = extractFinalAssistantOutput(AGENT, invocation.stdout);
      const graded = gradeTaskRun(frozenTask, calls, finalOutput);
      const outcome = invocation.timedOut
        ? "timeout"
        : invocation.exitCode === 0
          ? graded.outcome
          : "model-error";
      routedReplay = {
        schema_version: "nemoclaw.compositional_tool_routing_agent_smoke.v1",
        generated_at: new Date().toISOString(),
        claim_eligible: false,
        run_id: routedRunId,
        outcome,
        invocation: {
          exit_code: invocation.exitCode,
          timed_out: invocation.timedOut,
          elapsed_ms: elapsedMs,
        },
        synthetic_call_count: calls.length,
        correctness: graded.correctness,
        expected_routed_tool_name: expectedRoutedToolName,
        routing_configuration: {
          reasoning_control: "enable_thinking_false",
          output_mode: "json-object",
          max_attempts: ROUTING_DECOMPOSER_MAX_ATTEMPTS,
          timeout_ms: ROUTING_DECOMPOSER_REQUEST_TIMEOUT_MS,
          route_only_run_timeout_ms: ROUTE_ONLY_RUN_TIMEOUT_MS,
          proxy_request_timeout_ms: ROUTED_PROXY_REQUEST_TIMEOUT_MS,
          gateway_request_timeout_ms: ROUTED_GATEWAY_REQUEST_TIMEOUT_MS,
          agent_invocation_timeout_ms: ROUTED_AGENT_INVOCATION_TIMEOUT_MS,
          baseline_gateway_request_timeout_ms: RESTORED_GATEWAY_REQUEST_TIMEOUT_MS,
          gateway_transport: "authenticated-private-host-bridge",
          embedding: "portable-lexical-hashing",
        },
        route_evidence: routeEvidence,
        recorder_events: recorderEvents,
        limitations: [
          "This single routed replay is an end-to-end wiring check, not a performance or quality claim.",
          "The portable lexical embedder is used only for an ordinary-runner smoke path.",
          "The replay uses an authenticated private runner bridge and replaces its ephemeral ingress credential before the hosted request.",
          "The bridge uses host-local HTTP inside the trusted runner and Docker-network boundary.",
          "Proxy and gateway timeouts apply per request; the routed agent invocation has its own overall bound.",
          "The routed replay is separate from the frozen direct/progressive comparison.",
        ],
      };
    } finally {
      await restoreInferenceRoute();
    }

    await artifacts.writeJson("compositional-routing-agent-smoke.json", routedReplay);
    expect(routedReplay).toBeDefined();
    const replay = routedReplay as {
      outcome: string;
      correctness: { task_success: boolean };
      synthetic_call_count: number;
      route_evidence: Awaited<ReturnType<typeof routedTransform.consumeEvidence>>;
      recorder_events: Array<{
        model_call_sequence: number | null;
        visible_tool_count: number;
      }>;
    };
    expect(replay.outcome).toBe("success");
    expect(replay.correctness.task_success).toBe(true);
    expect(replay.synthetic_call_count).toBe(1);
    expect(replay.route_evidence.length).toBeGreaterThan(0);
    const [firstRoute] = replay.route_evidence;
    expect(firstRoute.routing.fallback).toBeNull();
    expect(firstRoute.transform_bypass).toBeNull();
    expect(firstRoute.routable_tool_count).toBe(CATALOG_SIZE);
    expect(firstRoute.forwarded_tool_count).toBeLessThan(firstRoute.source_tool_count);
    expect(firstRoute.routing.selected_tool_names).toContain(expectedRoutedToolName);
    const firstModelEvent = replay.recorder_events.find((event) => event.model_call_sequence === 1);
    expect(firstModelEvent?.visible_tool_count).toBe(firstRoute.forwarded_tool_count);

    await artifacts.writeJson("tool-disclosure-performance-smoke.json", {
      schema_version: "nemoclaw.tool_disclosure_performance_smoke.v1",
      generated_at: new Date().toISOString(),
      claim_eligible: false,
      sut_git_sha: gitSha(),
      profile: {
        agent: AGENT,
        modes: MODES,
        catalog_seed: catalog.seed,
        catalog_size: CATALOG_SIZE,
        catalog_tools_sha256: catalogPrefix.tools_sha256,
        task_id: frozenTask.id,
        task_kind: frozenTask.kind,
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
        "This performance smoke test verifies live wiring and task completion; it is not the complete two-campaign performance test.",
        "One observation per mode is insufficient for performance or quality claims.",
        "The fixed progressive-then-direct order makes elapsed times informational and subject to cold-cache and ordering effects.",
        "The performance smoke test does not collect vLLM tokenizer, token-counter, or request-recorder evidence.",
      ],
    });

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.outcome, `${result.mode} performance smoke outcome`).toBe("success");
      expect(result.correctness.task_success, `${result.mode} task correctness`).toBe(true);
      expect(result.synthetic_call_count, `${result.mode} synthetic call count`).toBe(1);
    }
  },
);
