// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public evidence schema for the progressive tool-disclosure performance test.
 *
 * The schema deliberately stores task identifiers, classifications, booleans,
 * and numeric measurements rather than prompts, tool arguments, response
 * bodies, endpoint URLs, or credentials. Sanitized transcripts are separate,
 * checksummed artifacts and never flow through the statistics/report layer.
 */

export const TOOL_DISCLOSURE_PERFORMANCE_TEST_SCHEMA_VERSION =
  "nemoclaw.tool_disclosure_performance_test.v1" as const;
export const DEFAULT_BOOTSTRAP_SAMPLES = 10_000;
export const DEFAULT_BOOTSTRAP_SEED = 0x4e_56_44_41;
export const DEFAULT_NONINFERIORITY_MARGIN_PP = -5;
export const NO_ACCELERATOR_TYPE = "none" as const;
export const NOT_APPLICABLE = "not-applicable" as const;

export type ToolDisclosurePerformanceTestSchemaVersion =
  typeof TOOL_DISCLOSURE_PERFORMANCE_TEST_SCHEMA_VERSION;
export type ToolDisclosureAgent = "langchain-deepagents-code" | "hermes" | "openclaw";
export type ToolDisclosureMode = "direct" | "progressive";
export type PerformanceTestPhase =
  | "static-visibility"
  | "small-control"
  | "primary"
  | "large-stress";
export type PerformanceTestTaskKind = "single-tool" | "ordered-chain" | "near-match" | "no-tool";
export type PerformanceTestRunOutcome =
  | "success"
  | "incorrect"
  | "timeout"
  | "model-error"
  | "context-overflow"
  | "setup-error";

export interface RevisionIdentity {
  git_sha: string;
  git_ref: string;
  worktree_clean: boolean;
}

export interface CampaignDefinition {
  campaign_id: string;
  ordinal: 1 | 2;
  fresh_inference_process: boolean;
  fresh_sandboxes: boolean;
}

/** Public, sanitized machine metadata. There is intentionally no hostname or path field. */
export interface PerformanceTestEnvironment {
  operating_system: string;
  architecture: string;
  cpu_model: string;
  cpu_count: number;
  ram_gib: number;
  /** Generic accelerator metadata. Use count 0, type "none", and explicit not-applicable values for CPU-only runs. */
  accelerator_type: string;
  accelerator_model: string;
  accelerator_architecture: string;
  accelerator_count: number;
  accelerator_driver_version: string;
  accelerator_runtime: string;
  power_state: string;
  openshell_version: string;
  agent_versions: Record<ToolDisclosureAgent, string>;
  /** Exact OCI image digest used by every agent/mode/catalog sandbox cell. */
  sandbox_image_digests?: Readonly<Record<string, string>>;
}

export interface InferenceConfiguration {
  api: "chat-completions";
  model_id: string;
  model_revision: string;
  container_image: string;
  container_digest: string;
  vllm_version: string;
  tool_call_parser: string;
  reasoning_parser: string;
  temperature: 0;
  concurrency: 1;
  prefix_caching_enabled: boolean;
  /** Public, reviewed flags only. Never put endpoint, token, mount, or host values here. */
  public_vllm_flags: readonly string[];
}

export interface PerformanceTestProtocol {
  agents: readonly ToolDisclosureAgent[];
  modes: readonly ToolDisclosureMode[];
  catalog_sizes: readonly number[];
  primary_catalog_size: number;
  tasks: readonly {
    task_id: string;
    kind: PerformanceTestTaskKind;
  }[];
  repetitions: Readonly<Record<Exclude<PerformanceTestPhase, "static-visibility">, number>>;
  execution_seed: number;
  bootstrap_samples: number;
  bootstrap_seed: number;
  noninferiority_margin_percentage_points: number;
  retry_setup_failures: number;
}

export interface ToolDisclosureManifest {
  schema_version: ToolDisclosurePerformanceTestSchemaVersion;
  performance_test_id: string;
  created_at: string;
  sut: RevisionIdentity;
  harness: RevisionIdentity;
  campaigns: readonly CampaignDefinition[];
  protocol: PerformanceTestProtocol;
  environment: PerformanceTestEnvironment;
  inference: InferenceConfiguration;
}

export interface InitialToolSchemaMeasurement {
  tool_count: number;
  serialized_bytes: number;
  tokenizer_tokens: number;
}

export interface RunCorrectness {
  task_success: boolean;
  expected_tool_names: boolean;
  expected_tool_order: boolean;
  expected_arguments: boolean;
  expected_call_count: boolean;
  nonce_present: boolean;
  unnecessary_tool_calls: number;
}

export interface RunMeasurements {
  initial_tool_schema: InitialToolSchemaMeasurement;
  total_prompt_tokens?: number;
  completion_tokens?: number;
  time_to_first_response_byte_ms?: number;
  inference_time_ms?: number;
  end_to_end_time_ms?: number;
  model_calls: number;
  discovery_calls: number;
}

export interface ToolDisclosureRun {
  schema_version: ToolDisclosurePerformanceTestSchemaVersion;
  performance_test_id: string;
  campaign_id: string;
  run_id: string;
  phase: PerformanceTestPhase;
  agent: ToolDisclosureAgent;
  mode: ToolDisclosureMode;
  catalog_size: number;
  task_id: string;
  task_kind?: PerformanceTestTaskKind;
  repetition: number;
  execution_seed: number;
  outcome: PerformanceTestRunOutcome;
  /** Static captures are unscored; for task phases, only setup-error is excluded. */
  scored: boolean;
  correctness: RunCorrectness;
  measurements: RunMeasurements;
}

export interface ConfidenceInterval {
  estimate: number;
  lower_95: number;
  upper_95: number;
  paired_tasks: number;
  bootstrap_samples: number;
  bootstrap_seed: number;
}

export interface ModeAggregate {
  runs: number;
  scored_runs: number;
  tasks: number;
  success_rate_percent: number;
  mean_initial_tool_schema_tokens: number;
  mean_total_prompt_tokens?: number;
  mean_time_to_first_response_byte_ms?: number;
  mean_end_to_end_time_ms?: number;
}

export interface ComparisonDifferences {
  /** Progressive minus direct, in percentage points. Higher is better. */
  success_percentage_points: ConfidenceInterval;
  /** Progressive minus direct. Negative is better for all remaining metrics. */
  initial_tool_schema_tokens: ConfidenceInterval;
  total_prompt_tokens?: ConfidenceInterval;
  time_to_first_response_byte_ms?: ConfidenceInterval;
  end_to_end_time_ms?: ConfidenceInterval;
}

export interface ComparisonCellSummary {
  campaign_id: string;
  phase: Exclude<PerformanceTestPhase, "static-visibility">;
  agent: ToolDisclosureAgent;
  catalog_size: number;
  direct: ModeAggregate;
  progressive: ModeAggregate;
  differences: ComparisonDifferences;
}

export interface SchemaVisibilitySnapshot extends InitialToolSchemaMeasurement {
  samples: number;
}

export interface SchemaReductionSummary {
  campaign_id: string;
  agent: ToolDisclosureAgent;
  catalog_size: number;
  direct: SchemaVisibilitySnapshot;
  progressive: SchemaVisibilitySnapshot;
  reduction: {
    tool_count: number;
    serialized_bytes: number;
    tokenizer_tokens: number;
    tokenizer_tokens_percent: number;
  };
}

export interface CampaignAgentGate {
  campaign_id: string;
  agent: ToolDisclosureAgent;
  success_noninferior: boolean;
  initial_schema_tokens_improved: boolean;
  end_to_end_latency_improved: boolean;
  success_lower_95_percentage_points?: number;
  schema_tokens_upper_95?: number;
  latency_upper_95_ms?: number;
  reasons: readonly string[];
}

export interface ClaimGateSummary {
  required_agents: readonly ToolDisclosureAgent[];
  required_campaigns: readonly string[];
  primary_catalog_size: number;
  noninferiority_margin_percentage_points: number;
  campaign_agent_gates: readonly CampaignAgentGate[];
  cross_agent_success_noninferior: boolean;
  cross_agent_initial_schema_tokens_improved: boolean;
  cross_agent_end_to_end_latency_improved: boolean;
}

export interface ToolDisclosureSummary {
  schema_version: ToolDisclosurePerformanceTestSchemaVersion;
  performance_test_id: string;
  generated_at: string;
  bootstrap_samples: number;
  bootstrap_seed: number;
  comparison_cells: readonly ComparisonCellSummary[];
  static_visibility: readonly SchemaReductionSummary[];
  claim_gates: ClaimGateSummary;
  /** Mechanically generated, public-safe claims. Empty means no claim cleared its gate. */
  claims: readonly string[];
}

export type EvidenceArtifactKind =
  | "catalog"
  | "tasks"
  | "schedule"
  | "fixture-manifest"
  | "manifest"
  | "runs"
  | "summary"
  | "report"
  | "sanitized-transcript"
  | "raw-events"
  | "attempt-journal"
  | "attestation"
  | "checksums";

export interface EvidenceArtifact {
  artifact_id: string;
  kind: EvidenceArtifactKind;
  /** A public-safe leaf name, not an absolute path. */
  file_name: string;
  media_type: string;
  byte_length: number;
  sha256: string;
  campaign_id?: string;
  run_id?: string;
}

export interface EvidenceBundle {
  schema_version: ToolDisclosurePerformanceTestSchemaVersion;
  performance_test_id: string;
  generated_at: string;
  artifacts: readonly EvidenceArtifact[];
}
