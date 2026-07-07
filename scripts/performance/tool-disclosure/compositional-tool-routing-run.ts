// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";

import { canonicalJson, type JsonValue, sha256Hex } from "./catalog";
import {
  buildDenseToolIndex,
  COMPOSITIONAL_ROUTER_HINT_COUNT,
  COMPOSITIONAL_ROUTER_TOP_K,
  type CompositionalRoutingEvidence,
  type CompositionalRoutingResult,
  routeCompositionalToolsPaired,
} from "./compositional-tool-router";
import {
  COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES,
  COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS,
  type CompositionalRoutingCasePrediction,
  type CompositionalRoutingComparison,
  compareCompositionalRoutingVariants,
} from "./compositional-tool-routing-acceptance";
import {
  createOpenAIChatTaskDecomposer,
  createOpenAITextEmbedder,
  type ModelUsageEvent,
  PortableHashingTextEmbedder,
} from "./compositional-tool-routing-adapters";

const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface CompositionalRoutingRemoteModelConfig {
  base_url: string;
  model: string;
  revision: string;
  api_key_env?: string;
  allow_remote?: boolean;
  reasoning_control?: "enable_thinking_false" | "thinking_false";
  json_object_response?: boolean;
}

export interface CompositionalRoutingAcceptanceConfig {
  decomposer: CompositionalRoutingRemoteModelConfig;
  embedding:
    | { kind: "portable"; dimensions?: number }
    | ({ kind: "openai" } & CompositionalRoutingRemoteModelConfig);
  timeout_ms?: number;
}

export interface CompositionalRoutingAcceptanceOutput {
  schema_version: "nemoclaw.compositional_tool_routing_acceptance.v1";
  generated_at: string;
  claim_eligible: false;
  configuration: {
    decomposer_model: string;
    decomposer_revision: string;
    decomposer_reasoning_control: "enable_thinking_false" | "thinking_false" | "endpoint-default";
    decomposer_output_mode: "json-object" | "prompt-only";
    embedding_kind: "portable" | "openai";
    embedding_model: string;
    embedding_revision: string;
    top_k: number;
    hint_count: number;
    temperature: 0;
  };
  corpus: {
    tool_count: number;
    case_count: number;
    expected_step_count: number;
    tools_sha256: string;
    cases_sha256: string;
  };
  usage: {
    decomposition: {
      requests: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      duration_ms: number;
    };
    embedding: {
      requests: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      duration_ms: number;
    };
    index_build_time_ms: number;
    end_to_end_time_ms: number;
  };
  comparison: CompositionalRoutingComparison;
  cases: readonly {
    case_id: string;
    expected_step_count: number;
    shared_initial_decomposition: true;
    initial: {
      disposition: CompositionalRoutingResult["disposition"];
      forwarded_tool_names: readonly string[];
      forwarded_tool_count: number;
      evidence: CompositionalRoutingEvidence;
    };
    refined: {
      disposition: CompositionalRoutingResult["disposition"];
      forwarded_tool_names: readonly string[];
      forwarded_tool_count: number;
      evidence: CompositionalRoutingEvidence;
    };
  }[];
  acceptance_passed: boolean;
  limitations: readonly string[];
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty single-line string`);
  }
  return value.trim();
}

function publicIdentity(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (
    text.length > 256 ||
    text.includes("://") ||
    /(?:token|secret|password|api[_-]?key)/iu.test(text)
  ) {
    throw new TypeError(`${label} is not a public-safe model identity`);
  }
  return text;
}

function credential(name: string | undefined, label: string): string | undefined {
  if (name === undefined) return undefined;
  if (!SAFE_ENV_NAME.test(name))
    throw new TypeError(`${label} must be an environment variable name`);
  const value = process.env[name];
  if (!value) throw new Error(`${label} is not set`);
  return value;
}

function remoteOptions(
  config: CompositionalRoutingRemoteModelConfig,
  timeoutMs: number,
  usage: ModelUsageEvent[],
) {
  return {
    baseUrl: requiredText(config.base_url, "model base_url"),
    model: publicIdentity(config.model, "model"),
    apiKey: credential(config.api_key_env, "model api_key_env"),
    allowRemote: config.allow_remote === true,
    timeoutMs,
    onUsage: (event: ModelUsageEvent) => usage.push(event),
  };
}

function prediction(
  caseId: string,
  result: CompositionalRoutingResult,
): CompositionalRoutingCasePrediction {
  return {
    case_id: caseId,
    disposition: result.disposition,
    fallback: result.evidence.fallback,
    steps: result.evidence.final_candidate_tool_names.map((ranked, index) => ({
      subtask: `private-step-${index + 1}`,
      ranked_tool_names: ranked,
    })),
    selected_tool_names: result.selected_tool_names,
  };
}

function observation(result: CompositionalRoutingResult) {
  const forwardedToolNames =
    result.disposition === "passthrough"
      ? COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS.map((tool) => tool.name)
      : [...result.selected_tool_names];
  return {
    disposition: result.disposition,
    forwarded_tool_names: forwardedToolNames,
    forwarded_tool_count: forwardedToolNames.length,
    evidence: result.evidence,
  };
}

function sumUsage(
  events: readonly ModelUsageEvent[],
  key: "prompt_tokens" | "completion_tokens" | "total_tokens",
) {
  const values = events
    .map((event) => event[key])
    .filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
}

function operationUsage(
  events: readonly ModelUsageEvent[],
  operation: ModelUsageEvent["operation"],
): CompositionalRoutingAcceptanceOutput["usage"]["decomposition"] {
  const selected = events.filter((event) => event.operation === operation);
  const promptTokens = sumUsage(selected, "prompt_tokens");
  const completionTokens = sumUsage(selected, "completion_tokens");
  const totalTokens = sumUsage(selected, "total_tokens");
  return {
    requests: selected.length,
    ...(promptTokens === undefined ? {} : { prompt_tokens: promptTokens }),
    ...(completionTokens === undefined ? {} : { completion_tokens: completionTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
    duration_ms: selected.reduce((total, event) => total + event.duration_ms, 0),
  };
}

/** Run the public-safe route-only acceptance path with a real decomposer. */
export async function runCompositionalRoutingAcceptance(
  config: CompositionalRoutingAcceptanceConfig,
): Promise<CompositionalRoutingAcceptanceOutput> {
  const timeoutMs = config.timeout_ms ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeout_ms must be a positive safe integer");
  }
  const usage: ModelUsageEvent[] = [];
  const decomposerRevision = publicIdentity(config.decomposer.revision, "decomposer revision");
  const decomposer = createOpenAIChatTaskDecomposer({
    ...remoteOptions(config.decomposer, timeoutMs, usage),
    reasoningControl: config.decomposer.reasoning_control,
    jsonObjectResponse: config.decomposer.json_object_response,
  });
  const embeddingKind = config.embedding.kind;
  const embeddingModel =
    embeddingKind === "portable"
      ? "portable-lexical-hashing"
      : publicIdentity(config.embedding.model, "embedding model");
  const embeddingRevision =
    embeddingKind === "portable"
      ? "builtin-v1"
      : publicIdentity(config.embedding.revision, "embedding revision");
  const embedder =
    embeddingKind === "portable"
      ? new PortableHashingTextEmbedder(config.embedding.dimensions)
      : createOpenAITextEmbedder(remoteOptions(config.embedding, timeoutMs, usage));

  const startedAt = performance.now();
  const indexStartedAt = performance.now();
  const preparedIndex = await buildDenseToolIndex(COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS, embedder);
  const indexBuildTimeMs = performance.now() - indexStartedAt;
  const initialPredictions: CompositionalRoutingCasePrediction[] = [];
  const refinedPredictions: CompositionalRoutingCasePrediction[] = [];
  const cases: CompositionalRoutingAcceptanceOutput["cases"][number][] = [];
  for (const fixture of COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES) {
    const pair = await routeCompositionalToolsPaired(
      fixture.prompt,
      COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS,
      { decomposer, embedder, preparedIndex },
    );
    initialPredictions.push(prediction(fixture.id, pair.initial));
    refinedPredictions.push(prediction(fixture.id, pair.refined));
    cases.push({
      case_id: fixture.id,
      expected_step_count: fixture.expected_steps.length,
      shared_initial_decomposition: true,
      initial: observation(pair.initial),
      refined: observation(pair.refined),
    });
  }
  const comparison = compareCompositionalRoutingVariants(
    { variant: "initial", cases: initialPredictions },
    { variant: "refined", cases: refinedPredictions },
  );
  return {
    schema_version: "nemoclaw.compositional_tool_routing_acceptance.v1",
    generated_at: new Date().toISOString(),
    claim_eligible: false,
    configuration: {
      decomposer_model: publicIdentity(config.decomposer.model, "decomposer model"),
      decomposer_revision: decomposerRevision,
      decomposer_reasoning_control: config.decomposer.reasoning_control ?? "endpoint-default",
      decomposer_output_mode:
        config.decomposer.json_object_response === true ? "json-object" : "prompt-only",
      embedding_kind: embeddingKind,
      embedding_model: embeddingModel,
      embedding_revision: embeddingRevision,
      top_k: COMPOSITIONAL_ROUTER_TOP_K,
      hint_count: COMPOSITIONAL_ROUTER_HINT_COUNT,
      temperature: 0,
    },
    corpus: {
      tool_count: COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS.length,
      case_count: COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES.length,
      expected_step_count: COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES.reduce(
        (total, fixture) => total + fixture.expected_steps.length,
        0,
      ),
      tools_sha256: sha256Hex(
        canonicalJson(COMPOSITIONAL_ROUTING_ACCEPTANCE_TOOLS as unknown as JsonValue),
      ),
      cases_sha256: sha256Hex(
        canonicalJson(COMPOSITIONAL_ROUTING_ACCEPTANCE_CASES as unknown as JsonValue),
      ),
    },
    usage: {
      decomposition: operationUsage(usage, "decomposition"),
      embedding: operationUsage(usage, "embedding"),
      index_build_time_ms: indexBuildTimeMs,
      end_to_end_time_ms: performance.now() - startedAt,
    },
    comparison,
    cases,
    acceptance_passed: comparison.passed,
    limitations: [
      "This route-only acceptance run does not execute an agent or a tool.",
      "The eight-case corpus is software acceptance coverage, not a universal quality result.",
      ...(decomposerRevision === "unreported"
        ? ["The decomposer revision was not reported, so this run is not reproducible evidence."]
        : []),
      ...(embeddingKind === "portable"
        ? ["The portable lexical embedder is for smoke testing and is not claim eligible."]
        : []),
    ],
  };
}
