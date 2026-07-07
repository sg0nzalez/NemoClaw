// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { renderToolDisclosureMarkdown } from "../../scripts/performance/tool-disclosure/report";
import {
  buildComparisonCells,
  buildConservativeClaims,
  buildToolDisclosureSummary,
  evaluateClaimGates,
  pairedBootstrapDifference,
  summarizeStaticVisibility,
} from "../../scripts/performance/tool-disclosure/statistics";
import {
  type PerformanceTestPhase,
  DEFAULT_BOOTSTRAP_SAMPLES,
  TOOL_DISCLOSURE_PERFORMANCE_TEST_SCHEMA_VERSION,
  type ToolDisclosureAgent,
  type ToolDisclosureManifest,
  type ToolDisclosureMode,
  type ToolDisclosureRun,
} from "../../scripts/performance/tool-disclosure/types";

const AGENTS = ["langchain-deepagents-code", "hermes", "openclaw"] as const;
const CAMPAIGNS = ["campaign-1", "campaign-2"] as const;
const TASK_IDS = Array.from({ length: 24 }, (_, index) => `task-${index + 1}`);

function makeManifest(overrides: Partial<ToolDisclosureManifest> = {}): ToolDisclosureManifest {
  return {
    schema_version: TOOL_DISCLOSURE_PERFORMANCE_TEST_SCHEMA_VERSION,
    performance_test_id: "tool-disclosure-example",
    created_at: "2026-07-06T12:00:00.000Z",
    sut: { git_sha: "3a05b54e", git_ref: "v0.0.74", worktree_clean: true },
    harness: {
      git_sha: "1234abcd",
      git_ref: "performance-test-harness",
      worktree_clean: true,
    },
    campaigns: [
      {
        campaign_id: "campaign-1",
        ordinal: 1,
        fresh_inference_process: true,
        fresh_sandboxes: true,
      },
      {
        campaign_id: "campaign-2",
        ordinal: 2,
        fresh_inference_process: true,
        fresh_sandboxes: true,
      },
    ],
    protocol: {
      agents: AGENTS,
      modes: ["direct", "progressive"],
      catalog_sizes: [512],
      primary_catalog_size: 512,
      tasks: TASK_IDS.map((taskId) => ({
        task_id: taskId,
        kind: "single-tool" as const,
      })),
      repetitions: { "small-control": 1, primary: 1, "large-stress": 1 },
      execution_seed: 7,
      bootstrap_samples: 500,
      bootstrap_seed: 42,
      noninferiority_margin_percentage_points: -5,
      retry_setup_failures: 2,
    },
    environment: {
      operating_system: "Ubuntu 24.04",
      architecture: "x86_64",
      cpu_model: "Example CPU",
      cpu_count: 20,
      ram_gib: 128,
      accelerator_type: "example-accelerator",
      accelerator_model: "Example Accelerator",
      accelerator_architecture: "example-architecture",
      accelerator_count: 1,
      accelerator_driver_version: "999.1",
      accelerator_runtime: "example-runtime-1.0",
      power_state: "maximum-performance",
      openshell_version: "0.1.0",
      agent_versions: {
        "langchain-deepagents-code": "1.0.0",
        hermes: "1.0.0",
        openclaw: "1.0.0",
      },
    },
    inference: {
      api: "chat-completions",
      model_id: "deepseek-ai/DeepSeek-V4-Flash",
      model_revision: "revision-1",
      container_image: "registry.example/vllm:1.0.0",
      container_digest: "sha256:container",
      vllm_version: "0.1.0",
      tool_call_parser: "deepseek_v3",
      reasoning_parser: "deepseek_r1",
      temperature: 0,
      concurrency: 1,
      prefix_caching_enabled: true,
      public_vllm_flags: ["--enable-prefix-caching"],
    },
    ...overrides,
  };
}

interface RunOptions {
  campaign?: string;
  agent?: ToolDisclosureAgent;
  mode?: ToolDisclosureMode;
  phase?: PerformanceTestPhase;
  taskId?: string;
  repetition?: number;
  success?: boolean;
  scored?: boolean;
  schemaTokens?: number;
  schemaBytes?: number;
  visibleTools?: number;
  totalPromptTokens?: number;
  latencyMs?: number;
}

let runSequence = 0;

function makeRun(options: RunOptions = {}): ToolDisclosureRun {
  const success = options.success ?? true;
  const schemaTokens = options.schemaTokens ?? 1_000;
  const mode = options.mode ?? "direct";
  const phase = options.phase ?? "primary";
  const scored = options.scored ?? phase !== "static-visibility";
  runSequence += 1;
  return {
    schema_version: TOOL_DISCLOSURE_PERFORMANCE_TEST_SCHEMA_VERSION,
    performance_test_id: "tool-disclosure-example",
    campaign_id: options.campaign ?? "campaign-1",
    run_id: `run-${runSequence}`,
    phase,
    agent: options.agent ?? "langchain-deepagents-code",
    mode,
    catalog_size: 512,
    task_id: options.taskId ?? "task-1",
    task_kind: "single-tool",
    repetition: options.repetition ?? 1,
    execution_seed: 7,
    outcome:
      phase === "static-visibility"
        ? "success"
        : scored
          ? success
            ? "success"
            : "incorrect"
          : "setup-error",
    scored,
    correctness: {
      task_success: scored && success,
      expected_tool_names: scored && success,
      expected_tool_order: scored && success,
      expected_arguments: scored && success,
      expected_call_count: scored && success,
      nonce_present: scored && success,
      unnecessary_tool_calls: 0,
    },
    measurements: {
      initial_tool_schema: {
        tool_count: options.visibleTools ?? (mode === "direct" ? 512 : 3),
        serialized_bytes: options.schemaBytes ?? schemaTokens * 4,
        tokenizer_tokens: schemaTokens,
      },
      total_prompt_tokens: options.totalPromptTokens ?? schemaTokens + 100,
      completion_tokens: 20,
      time_to_first_response_byte_ms: (options.latencyMs ?? 200) / 2,
      inference_time_ms: options.latencyMs ?? 200,
      end_to_end_time_ms: options.latencyMs ?? 200,
      model_calls: 1,
      discovery_calls: mode === "progressive" ? 1 : 0,
    },
  };
}

function completeEvidence(progressiveSchemaTokens = 10): ToolDisclosureRun[] {
  const runs: ToolDisclosureRun[] = [];
  for (const campaign of CAMPAIGNS) {
    for (const agent of AGENTS) {
      runs.push(
        makeRun({
          campaign,
          agent,
          mode: "direct",
          phase: "static-visibility",
          taskId: "static",
          schemaTokens: 1_000,
          visibleTools: 512,
        }),
        makeRun({
          campaign,
          agent,
          mode: "progressive",
          phase: "static-visibility",
          taskId: "static",
          schemaTokens: progressiveSchemaTokens,
          visibleTools: 3,
        }),
      );
      for (const taskId of TASK_IDS) {
        runs.push(
          makeRun({
            campaign,
            agent,
            mode: "direct",
            taskId,
            schemaTokens: 1_000,
            latencyMs: 200,
          }),
          makeRun({
            campaign,
            agent,
            mode: "progressive",
            taskId,
            schemaTokens: progressiveSchemaTokens,
            latencyMs: 100,
          }),
        );
      }
    }
  }
  return runs;
}

describe("tool-disclosure paired statistics", () => {
  it("uses a deterministic 10,000-sample paired task bootstrap by default", () => {
    const observations = [
      { direct: 10, progressive: 5 },
      { direct: 20, progressive: 16 },
      { direct: 30, progressive: 24 },
    ];
    const first = pairedBootstrapDifference(observations, { seed: 123 });
    const second = pairedBootstrapDifference(observations, { seed: 123 });

    expect(first).toEqual(second);
    expect(first.bootstrap_samples).toBe(DEFAULT_BOOTSTRAP_SAMPLES);
    expect(first.paired_tasks).toBe(3);
    expect(first.estimate).toBe(-5);
    expect(first.lower_95).toBeLessThanOrEqual(first.estimate);
    expect(first.upper_95).toBeGreaterThanOrEqual(first.estimate);
  });

  it("averages repetitions within a task before resampling task pairs", () => {
    const runs = [
      makeRun({
        mode: "direct",
        taskId: "task-a",
        repetition: 1,
        success: true,
      }),
      makeRun({
        mode: "direct",
        taskId: "task-a",
        repetition: 2,
        success: false,
      }),
      makeRun({
        mode: "progressive",
        taskId: "task-a",
        repetition: 1,
        success: true,
      }),
      makeRun({
        mode: "progressive",
        taskId: "task-a",
        repetition: 2,
        success: true,
      }),
      makeRun({ mode: "direct", taskId: "task-b", success: true }),
      makeRun({ mode: "progressive", taskId: "task-b", success: true }),
    ];
    const [cell] = buildComparisonCells(runs, { samples: 100, seed: 1 });

    expect(cell.differences.success_percentage_points.paired_tasks).toBe(2);
    expect(cell.differences.success_percentage_points.estimate).toBe(25);
    expect(cell.direct.success_rate_percent).toBe(75);
    expect(cell.progressive.success_rate_percent).toBe(100);
  });
});

describe("tool-disclosure visibility and claim gates", () => {
  it("rejects nondeterministic static visibility instead of rounding it", () => {
    const runs = [
      makeRun({
        phase: "static-visibility",
        mode: "direct",
        schemaTokens: 1_000,
      }),
      makeRun({
        phase: "static-visibility",
        mode: "direct",
        schemaTokens: 1_001,
      }),
      makeRun({
        phase: "static-visibility",
        mode: "progressive",
        schemaTokens: 10,
      }),
    ];

    expect(() => summarizeStaticVisibility(runs)).toThrow("nondeterministic");
  });

  it("treats a success lower confidence bound of exactly -5 pp as noninferior", () => {
    const runs = completeEvidence();
    const cells = buildComparisonCells(runs, { samples: 100, seed: 2 });
    const visibility = summarizeStaticVisibility(runs);
    const target = cells.find(
      (cell) => cell.campaign_id === "campaign-1" && cell.agent === "langchain-deepagents-code",
    );
    expect(target).toBeDefined();
    const requiredTarget = target as NonNullable<typeof target>;
    requiredTarget.differences.success_percentage_points.lower_95 = -5;

    const gates = evaluateClaimGates(cells, visibility, {
      agents: ["langchain-deepagents-code"],
      campaignIds: CAMPAIGNS,
      primaryCatalogSize: 512,
      noninferiorityMarginPercentagePoints: -5,
    });

    expect(gates.campaign_agent_gates[0].success_noninferior).toBe(true);
    expect(gates.cross_agent_success_noninferior).toBe(true);
  });

  it("blocks a cross-agent claim when the improvement does not repeat in campaign two", () => {
    const runs = completeEvidence();
    const cells = buildComparisonCells(runs, { samples: 100, seed: 2 });
    const visibility = summarizeStaticVisibility(runs);
    const failingCell = cells.find(
      (cell) => cell.campaign_id === "campaign-2" && cell.agent === "openclaw",
    );
    expect(failingCell).toBeDefined();
    const requiredFailingCell = failingCell as NonNullable<typeof failingCell>;
    requiredFailingCell.differences.initial_tool_schema_tokens.upper_95 = 1;

    const gates = evaluateClaimGates(cells, visibility, {
      agents: AGENTS,
      campaignIds: CAMPAIGNS,
      primaryCatalogSize: 512,
    });

    expect(gates.cross_agent_initial_schema_tokens_improved).toBe(false);
    expect(
      gates.campaign_agent_gates.find(
        (gate) => gate.campaign_id === "campaign-2" && gate.agent === "openclaw",
      )?.initial_schema_tokens_improved,
    ).toBe(false);
  });

  it("does not trust a stale aggregate gate when a campaign-agent cell is blocked", () => {
    const summary = buildToolDisclosureSummary(makeManifest(), completeEvidence(), {
      generatedAt: "2026-07-06T13:00:00.000Z",
    });
    summary.claim_gates.campaign_agent_gates[0].schema_tokens_upper_95 = 1;

    const claims = buildConservativeClaims(summary);

    expect(summary.claim_gates.cross_agent_initial_schema_tokens_improved).toBe(true);
    expect(claims.some((claim) => claim.includes("initial serialized tool-schema tokens"))).toBe(
      false,
    );
  });

  it("never says 99% unless every cited cell measures at least 99%", () => {
    const below = buildToolDisclosureSummary(makeManifest(), completeEvidence(11), {
      generatedAt: "2026-07-06T13:00:00.000Z",
    });
    const atLeast = buildToolDisclosureSummary(makeManifest(), completeEvidence(10), {
      generatedAt: "2026-07-06T13:00:00.000Z",
    });
    const belowClaims = buildConservativeClaims(below);
    const atLeastClaims = buildConservativeClaims(atLeast);

    atLeast.static_visibility[0].reduction.tokenizer_tokens_percent = 98.999;
    const nearThresholdClaims = buildConservativeClaims(atLeast);

    expect(belowClaims.join(" ")).not.toContain("99%");
    expect(belowClaims[0]).toContain("initial serialized tool-schema tokens");
    expect(nearThresholdClaims.join(" ")).not.toContain("99%");
    expect(nearThresholdClaims[0]).toContain("98.9%");
    expect(atLeastClaims[0]).toContain("at least 99%");
    expect(atLeastClaims[0]).toContain("initial serialized tool-schema tokens");
  });

  it("blocks schema and latency claims when task success is not noninferior", () => {
    const runs = completeEvidence();
    for (const run of runs.filter(
      (candidate) => candidate.phase === "primary" && candidate.mode === "progressive",
    )) {
      run.outcome = "incorrect";
      run.correctness.task_success = false;
    }
    const summary = buildToolDisclosureSummary(makeManifest(), runs);
    expect(summary.claims.join(" ")).not.toContain("reduced initial");
    expect(summary.claims.join(" ")).not.toContain("reduced end-to-end");
  });
});

describe("tool-disclosure Markdown report", () => {
  it("renders only gated claims and public-safe evidence fields", () => {
    const runs = completeEvidence();
    (runs[0] as ToolDisclosureRun & { prompt: string }).prompt = "RAW-PROMPT-SECRET";
    const manifest = makeManifest();
    const summary = buildToolDisclosureSummary(manifest, runs, {
      generatedAt: "2026-07-06T13:00:00.000Z",
    });
    const markdown = renderToolDisclosureMarkdown(manifest, summary, {
      artifacts: [
        {
          artifact_id: "summary",
          kind: "summary",
          file_name: "summary.json",
          media_type: "application/json",
          byte_length: 123,
          sha256: "a".repeat(64),
        },
      ],
    });

    expect(markdown).toContain("# Progressive Tool-Disclosure Performance Test");
    expect(markdown).toContain("at least 99%");
    expect(markdown).toContain("initial serialized tool-schema tokens");
    expect(markdown).toContain("not an authorization boundary");
    expect(markdown).toContain("| Accelerator | 1 × example-accelerator: Example Accelerator |");
    expect(markdown).toContain("| Accelerator driver / runtime | 999.1 / example-runtime-1.0 |");
    expect(markdown).toContain("summary.json");
    expect(markdown).not.toContain("RAW-PROMPT-SECRET");
  });

  it("renders CPU-only hardware without implying an accelerator", () => {
    const manifest = makeManifest();
    manifest.environment.accelerator_type = "none";
    manifest.environment.accelerator_model = "not-applicable";
    manifest.environment.accelerator_architecture = "not-applicable";
    manifest.environment.accelerator_count = 0;
    manifest.environment.accelerator_driver_version = "not-applicable";
    manifest.environment.accelerator_runtime = "not-applicable";
    const summary = buildToolDisclosureSummary(manifest, completeEvidence(), {
      generatedAt: "2026-07-06T13:00:00.000Z",
    });

    const markdown = renderToolDisclosureMarkdown(manifest, summary);

    expect(markdown).toContain("| Accelerator | none |");
    expect(markdown).toContain("| Accelerator architecture | not-applicable |");
    expect(markdown).not.toContain("GPU");
  });

  it("rejects unsafe public manifest values before rendering the report", () => {
    const manifest = makeManifest();
    const summary = buildToolDisclosureSummary(manifest, completeEvidence(), {
      generatedAt: "2026-07-06T13:00:00.000Z",
    });
    manifest.inference.public_vllm_flags = ["--host=http://127.0.0.1:8000"];

    expect(() => renderToolDisclosureMarkdown(manifest, summary)).toThrow(/private routing flag/u);
  });

  it("rejects artifact paths so host locations cannot enter the report", () => {
    const manifest = makeManifest();
    const summary = buildToolDisclosureSummary(manifest, completeEvidence(), {
      generatedAt: "2026-07-06T13:00:00.000Z",
    });

    expect(() =>
      renderToolDisclosureMarkdown(manifest, summary, {
        artifacts: [
          {
            artifact_id: "bad",
            kind: "summary",
            file_name: "/Users/test/summary.json",
            media_type: "application/json",
            byte_length: 1,
            sha256: "b".repeat(64),
          },
        ],
      }),
    ).toThrow("leaf file name");
  });
});
