// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  artifactPath,
  ensureCampaignDirectory,
  readJsonLines,
  scanArtifactsForForbiddenValues,
  sha256File,
  writeChecksumManifest,
  writeJsonArtifact,
  writeTextArtifact,
} from "./artifacts";
import {
  assertValidSyntheticCatalog,
  DEFAULT_SYNTHETIC_CATALOG_SEED,
  generateCatalogPrefix,
  generateSyntheticCatalog,
  type SyntheticCatalog,
} from "./catalog";
import {
  type AttemptJournalEntry,
  type CampaignAttestation,
  executeCampaign,
  type LiveCampaignConfiguration,
  type SanitizedRunEvidence,
} from "./execute";
import { assertImmutableSandboxBase, writeOpenClawFixture } from "./openclaw-fixture";
import { renderToolDisclosureMarkdown } from "./report";
import {
  buildToolDisclosureSchedule,
  STATIC_CATALOG_SIZES,
  TOOL_DISCLOSURE_AGENTS,
  TOOL_DISCLOSURE_MODES,
} from "./schedule";
import { buildToolDisclosureSummary } from "./statistics";
import {
  assertValidSyntheticTaskSet,
  generatePrimaryTaskSet,
  generateStressTaskSet,
  type SyntheticTaskSet,
} from "./tasks";
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_NONINFERIORITY_MARGIN_PP,
  type EvidenceArtifact,
  type EvidenceBundle,
  TOOL_DISCLOSURE_SCHEMA_VERSION,
  type ToolDisclosureManifest,
  type ToolDisclosureRun,
} from "./types";
import { validateCompleteEvidence, validateFrozenManifest } from "./validation";

interface ParsedArguments {
  command: "prepare" | "execute" | "summarize" | "help";
  outputDir?: string;
  sutRef: string;
  catalogSeed: string;
  executionSeed: number;
  sandboxBase?: string;
  resume: boolean;
  allowDirty: boolean;
  forbiddenValues: string[];
  configPath?: string;
}

interface FixtureManifestEntry {
  catalog_size: number;
  files: Array<{ path: string; byte_length: number; sha256: string }>;
}

const PREPARED_FILES = [
  "catalog.json",
  "primary-tasks.json",
  "stress-tasks.json",
  "schedule.json",
  "manifest.template.json",
  "execute-config.template.json",
  "fixtures.json",
] as const;

function usage(): string {
  return `Progressive tool-disclosure benchmark\n\n\
Usage:\n\
  npm run bench:tool-disclosure -- prepare --output-dir <directory> [options]\n\
  npm run bench:tool-disclosure -- execute --output-dir <directory> --config <file>\n\
  npm run bench:tool-disclosure -- summarize --output-dir <directory> [options]\n\n\
Prepare options:\n\
  --sut-ref <git-ref>          SUT revision to resolve (default: HEAD)\n\
  --catalog-seed <seed>        Deterministic catalog seed\n\
  --seed <integer>             Schedule seed\n\
  --sandbox-base <image>       Required immutable base image with @sha256 digest\n\
  --resume                     Reuse an existing output directory\n\n\
  --allow-dirty                Development only; resulting evidence cannot be summarized\n\n\
Summarize inputs:\n\
  Manifest, attestations, attempt journal, raw events, and runs in the output directory\n\
  --forbid-value <value>       Fail if a public artifact contains this value (repeatable)\n`;
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const first = args[0];
  const command =
    first === "prepare" || first === "execute" || first === "summarize" ? first : "help";
  if (first && command === "help" && first !== "help" && first !== "--help" && first !== "-h") {
    throw new Error(`unknown command: ${first}`);
  }
  const parsed: ParsedArguments = {
    command,
    sutRef: "HEAD",
    catalogSeed: DEFAULT_SYNTHETIC_CATALOG_SEED,
    executionSeed: 0x4e_56_44_41,
    resume: false,
    allowDirty: false,
    forbiddenValues: [],
  };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--resume") {
      parsed.resume = true;
      continue;
    }
    if (flag === "--allow-dirty") {
      parsed.allowDirty = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      parsed.command = "help";
      continue;
    }
    const value = requiredValue(args, index, flag);
    index += 1;
    if (flag === "--output-dir") parsed.outputDir = value;
    else if (flag === "--sut-ref") parsed.sutRef = value;
    else if (flag === "--catalog-seed") parsed.catalogSeed = value;
    else if (flag === "--sandbox-base") parsed.sandboxBase = value;
    else if (flag === "--forbid-value") parsed.forbiddenValues.push(value);
    else if (flag === "--config") parsed.configPath = value;
    else if (flag === "--seed") {
      parsed.executionSeed = Number(value);
      if (!Number.isSafeInteger(parsed.executionSeed)) throw new Error("--seed must be an integer");
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (parsed.command !== "help" && !parsed.outputDir) throw new Error("--output-dir is required");
  if (parsed.command === "execute" && !parsed.configPath)
    throw new Error("execute requires --config");
  return parsed;
}

function gitOutput(args: readonly string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function revision(ref: string, worktreeClean: boolean): ToolDisclosureManifest["sut"] {
  const sha = gitOutput(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error(`could not resolve git revision ${ref}`);
  return { git_sha: sha, git_ref: ref, worktree_clean: worktreeClean };
}

function benchmarkId(sha: string, catalogHash: string): string {
  return `tool-disclosure-${sha.slice(0, 12)}-${catalogHash.slice(0, 12)}`;
}

function manifestTemplate(options: {
  sutRef: string;
  catalogHash: string;
  executionSeed: number;
  worktreeClean: boolean;
  tasks: readonly {
    id: string;
    kind: ToolDisclosureManifest["protocol"]["tasks"][number]["kind"];
  }[];
}): ToolDisclosureManifest {
  const sut = revision(options.sutRef, options.worktreeClean);
  const harness = revision("HEAD", options.worktreeClean);
  return {
    schema_version: TOOL_DISCLOSURE_SCHEMA_VERSION,
    benchmark_id: benchmarkId(sut.git_sha, options.catalogHash),
    created_at: new Date().toISOString(),
    sut,
    harness,
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
      agents: TOOL_DISCLOSURE_AGENTS,
      modes: TOOL_DISCLOSURE_MODES,
      catalog_sizes: STATIC_CATALOG_SIZES,
      primary_catalog_size: 512,
      tasks: options.tasks.map((task) => ({
        task_id: task.id,
        kind: task.kind,
      })),
      repetitions: { "small-control": 1, primary: 5, "large-stress": 1 },
      execution_seed: options.executionSeed,
      bootstrap_samples: DEFAULT_BOOTSTRAP_SAMPLES,
      bootstrap_seed: DEFAULT_BOOTSTRAP_SEED,
      noninferiority_margin_percentage_points: DEFAULT_NONINFERIORITY_MARGIN_PP,
      retry_setup_failures: 1,
    },
    environment: {
      operating_system: "RECORD_BEFORE_EXECUTION",
      architecture: "RECORD_BEFORE_EXECUTION",
      cpu_model: "RECORD_BEFORE_EXECUTION",
      cpu_count: 0,
      ram_gib: 0,
      accelerator_type: "RECORD_BEFORE_EXECUTION",
      accelerator_model: "RECORD_BEFORE_EXECUTION",
      accelerator_architecture: "RECORD_BEFORE_EXECUTION",
      accelerator_count: 0,
      accelerator_driver_version: "RECORD_BEFORE_EXECUTION",
      accelerator_runtime: "RECORD_BEFORE_EXECUTION",
      power_state: "RECORD_BEFORE_EXECUTION",
      openshell_version: "RECORD_BEFORE_EXECUTION",
      agent_versions: {
        openclaw: "RECORD_BEFORE_EXECUTION",
        hermes: "RECORD_BEFORE_EXECUTION",
        "langchain-deepagents-code": "RECORD_BEFORE_EXECUTION",
      },
      sandbox_image_digests: Object.fromEntries(
        TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
          TOOL_DISCLOSURE_MODES.flatMap((mode) =>
            STATIC_CATALOG_SIZES.map((size) => [
              `${agent}:${mode}:${size}`,
              "RECORD_BEFORE_EXECUTION",
            ]),
          ),
        ),
      ),
    },
    inference: {
      api: "chat-completions",
      model_id: "RECORD_BEFORE_EXECUTION",
      model_revision: "RECORD_BEFORE_EXECUTION",
      container_image: "RECORD_BEFORE_EXECUTION",
      container_digest: "RECORD_BEFORE_EXECUTION",
      vllm_version: "RECORD_BEFORE_EXECUTION",
      tool_call_parser: "RECORD_BEFORE_EXECUTION",
      reasoning_parser: "RECORD_BEFORE_EXECUTION",
      temperature: 0,
      concurrency: 1,
      prefix_caching_enabled: false,
      public_vllm_flags: [],
    },
  };
}

function prepare(options: ParsedArguments): void {
  const repositoryRoot = path.resolve(gitOutput(["rev-parse", "--show-toplevel"]));
  const requestedOutput = path.resolve(options.outputDir as string);
  if (
    requestedOutput === repositoryRoot ||
    requestedOutput.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    throw new Error("benchmark output directory must be outside the Git worktree");
  }
  const worktreeClean = gitOutput(["status", "--porcelain=v1", "--untracked-files=normal"]) === "";
  if (!worktreeClean && !options.allowDirty) {
    throw new Error(
      "benchmark preparation requires a clean worktree; commit or stash changes first",
    );
  }
  if (!options.sandboxBase) {
    throw new Error("--sandbox-base is required and must end in an immutable @sha256 digest");
  }
  assertImmutableSandboxBase(options.sandboxBase);
  const outputDir = ensureCampaignDirectory(requestedOutput, options.resume);
  const catalog = generateSyntheticCatalog({ seed: options.catalogSeed });
  const primary = generatePrimaryTaskSet(catalog);
  const stress = generateStressTaskSet(catalog);
  const schedule = buildToolDisclosureSchedule({
    primaryTaskIds: primary.tasks.map((task) => task.id),
    stressTaskIds: stress.tasks.map((task) => task.id),
    seed: options.executionSeed,
  });
  const manifest = manifestTemplate({
    sutRef: options.sutRef,
    catalogHash: catalog.tools_sha256,
    executionSeed: options.executionSeed,
    worktreeClean,
    tasks: [...primary.tasks, ...stress.tasks],
  });
  writeJsonArtifact(outputDir, "catalog.json", catalog);
  writeJsonArtifact(outputDir, "primary-tasks.json", primary);
  writeJsonArtifact(outputDir, "stress-tasks.json", stress);
  writeJsonArtifact(outputDir, "schedule.json", schedule);
  writeJsonArtifact(outputDir, "manifest.template.json", manifest);
  writeJsonArtifact(outputDir, "execute-config.template.json", {
    campaign: 1,
    upstream_vllm_url: "http://127.0.0.1:8000",
    telemetry_url: "http://127.0.0.1:8000",
    tokenizer_model: "REPLACE_WITH_MODEL_ID",
    recorder_port: 18_080,
    managed_inference_base_url: "http://127.0.0.1:18080",
    vllm_container_name: "replace-vllm-container-name",
    vllm_container_id: "replace-vllm-container-id",
    sandbox_names: Object.fromEntries(
      TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
        TOOL_DISCLOSURE_MODES.flatMap((mode) =>
          STATIC_CATALOG_SIZES.map((size) => [
            `${agent}:${mode}:${size}`,
            `replace-${agent}-${mode}-${size}`,
          ]),
        ),
      ),
    ),
    sandbox_instance_ids: Object.fromEntries(
      TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
        TOOL_DISCLOSURE_MODES.flatMap((mode) =>
          STATIC_CATALOG_SIZES.map((size) => [
            `${agent}:${mode}:${size}`,
            `replace-live-instance-id-${agent}-${mode}-${size}`,
          ]),
        ),
      ),
    ),
    sandbox_container_names: Object.fromEntries(
      TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
        TOOL_DISCLOSURE_MODES.flatMap((mode) =>
          STATIC_CATALOG_SIZES.map((size) => [
            `${agent}:${mode}:${size}`,
            `replace-live-container-${agent}-${mode}-${size}`,
          ]),
        ),
      ),
    ),
    timeout_ms: 600_000,
  } satisfies LiveCampaignConfiguration);

  for (const size of STATIC_CATALOG_SIZES) {
    const fixtureDir = path.join(outputDir, `openclaw-${size}`);
    if (fs.existsSync(fixtureDir) && fs.readdirSync(fixtureDir).length > 0) {
      const existing = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, "plugin", "catalog.json"), "utf8"),
      ) as { tools_sha256?: string };
      const expected = generateCatalogPrefix(catalog, size);
      if (existing.tools_sha256 !== expected.tools_sha256) {
        throw new Error(`existing OpenClaw fixture ${size} does not match the prepared catalog`);
      }
      continue;
    }
    writeOpenClawFixture({
      outputDir: fixtureDir,
      catalog: generateCatalogPrefix(catalog, size),
      sandboxBase: options.sandboxBase,
    });
  }
  writeJsonArtifact(
    outputDir,
    "fixtures.json",
    STATIC_CATALOG_SIZES.map((size) => {
      const fixtureRoot = path.join(outputDir, `openclaw-${size}`);
      const files = [
        ".dockerignore",
        "Dockerfile",
        "plugin/catalog.json",
        "plugin/index.js",
        "plugin/openclaw.plugin.json",
        "plugin/package.json",
      ];
      return {
        catalog_size: size,
        files: files.map((name) => {
          const file = path.join(fixtureRoot, name);
          return {
            path: `openclaw-${size}/${name}`,
            byte_length: fs.statSync(file).size,
            sha256: sha256File(file),
          };
        }),
      };
    }),
  );
  writeChecksumManifest(outputDir, PREPARED_FILES);
  process.stdout.write(
    `Prepared ${schedule.length} runs in ${outputDir}. Copy manifest.template.json to manifest.json and replace every RECORD_BEFORE_EXECUTION value before execution.\n`,
  );
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new Error(`could not read ${path.basename(file)}: ${String(error)}`);
  }
}

function evidenceArtifact(
  outputDir: string,
  fileName: string,
  kind: EvidenceArtifact["kind"],
): EvidenceArtifact {
  const file = artifactPath(outputDir, fileName);
  return {
    artifact_id: `${kind}-${fileName}`,
    kind,
    file_name: fileName,
    media_type: fileName.endsWith(".jsonl")
      ? "application/x-ndjson"
      : fileName.endsWith(".md")
        ? "text/markdown"
        : "application/json",
    byte_length: fs.statSync(file).size,
    sha256: sha256File(file),
  };
}

function assertManifestCompleted(manifest: ToolDisclosureManifest): void {
  const serialized = JSON.stringify(manifest);
  if (serialized.includes("RECORD_BEFORE_EXECUTION")) {
    throw new Error("manifest.json still contains RECORD_BEFORE_EXECUTION placeholders");
  }
}

function assertPreparedIdentity(
  manifest: ToolDisclosureManifest,
  catalog: SyntheticCatalog,
  primaryTasks: SyntheticTaskSet,
  stressTasks: SyntheticTaskSet,
): void {
  if (manifest.benchmark_id !== benchmarkId(manifest.sut.git_sha, catalog.tools_sha256)) {
    throw new Error("manifest benchmark ID does not match the frozen SUT and catalog");
  }
  const expectedTasks = [...primaryTasks.tasks, ...stressTasks.tasks].map((task) => ({
    task_id: task.id,
    kind: task.kind,
  }));
  if (JSON.stringify(manifest.protocol.tasks) !== JSON.stringify(expectedTasks)) {
    throw new Error("manifest tasks do not match the prepared task artifacts");
  }
}

export function validateCampaignAttestations(
  manifest: ToolDisclosureManifest,
  attestations: readonly CampaignAttestation[],
): void {
  if (
    attestations.length !== 2 ||
    JSON.stringify(attestations.map((item) => item.campaign_id).sort()) !==
      JSON.stringify(["campaign-1", "campaign-2"])
  ) {
    throw new Error("evidence requires exactly two campaign attestations");
  }
  if (new Set(attestations.map((item) => item.vllm_process_start_time_seconds)).size !== 2) {
    throw new Error("campaign attestations reused a vLLM process");
  }
  if (
    new Set(attestations.map((item) => item.inference_container_id_sha256)).size !== 2 ||
    new Set(attestations.map((item) => item.inference_config_sha256)).size !== 1 ||
    attestations.some(
      (item) =>
        !/^[a-f0-9]{64}$/u.test(item.inference_container_id_sha256) ||
        !/^[a-f0-9]{64}$/u.test(item.inference_config_sha256) ||
        item.inference_image_digest !== manifest.inference.container_digest,
    )
  ) {
    throw new Error("campaigns require distinct vLLM containers with identical frozen config");
  }
  const allInstanceIds = attestations.flatMap((item) =>
    item.sandbox_cells.map((cell) => cell.instance_id_sha256),
  );
  const expectedCells = TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
    TOOL_DISCLOSURE_MODES.flatMap((mode) =>
      STATIC_CATALOG_SIZES.map((size) => `${agent}:${mode}:${size}`),
    ),
  ).sort();
  if (
    attestations.some(
      (item) =>
        !Number.isFinite(item.vllm_process_start_time_seconds) ||
        item.vllm_process_start_time_seconds <= 0 ||
        JSON.stringify(item.sandbox_cells.map((cell) => cell.cell).sort()) !==
          JSON.stringify(expectedCells) ||
        item.sandbox_cells.some(
          (cell) =>
            !/^[a-f0-9]{64}$/u.test(cell.instance_id_sha256) ||
            !/^[a-f0-9]{64}$/u.test(cell.status_sha256),
        ),
    ) ||
    new Set(allInstanceIds).size !== 60
  ) {
    throw new Error("campaign attestations reused or omitted sandbox instances");
  }
  for (const attestation of attestations) {
    for (const cell of attestation.sandbox_cells) {
      if (manifest.environment.sandbox_image_digests?.[cell.cell] !== cell.image_digest) {
        throw new Error(`campaign attestation image mismatch for ${cell.cell}`);
      }
    }
  }
}

function validateOpenClawFixtures(
  outputDir: string,
  catalog: SyntheticCatalog,
  fixtureManifest: readonly FixtureManifestEntry[],
): void {
  if (
    !sameNumberList(
      fixtureManifest.map((entry) => entry.catalog_size),
      STATIC_CATALOG_SIZES,
    )
  ) {
    throw new Error("fixtures.json does not contain the frozen catalog sizes");
  }
  for (const entry of fixtureManifest) {
    const root = path.join(outputDir, `openclaw-${entry.catalog_size}`);
    const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
    const sandboxBase = dockerfile.match(/^ARG SANDBOX_BASE=(\S+)$/mu)?.[1];
    if (!sandboxBase) throw new Error(`OpenClaw ${entry.catalog_size} fixture has no base image`);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fixture-verify-"));
    const expectedRoot = path.join(temporaryRoot, `fixture-${entry.catalog_size}`);
    try {
      const generated = writeOpenClawFixture({
        outputDir: expectedRoot,
        catalog: generateCatalogPrefix(catalog, entry.catalog_size),
        sandboxBase,
      });
      if (entry.files.length !== generated.files.length) {
        throw new Error(`OpenClaw ${entry.catalog_size} fixture file count changed`);
      }
      for (const name of generated.files) {
        const relative = `openclaw-${entry.catalog_size}/${name}`;
        const recorded = entry.files.find((file) => file.path === relative);
        const actual = path.join(root, name);
        const expected = path.join(expectedRoot, name);
        if (
          !recorded ||
          recorded.byte_length !== fs.statSync(actual).size ||
          recorded.sha256 !== sha256File(actual) ||
          recorded.sha256 !== sha256File(expected)
        ) {
          throw new Error(`OpenClaw fixture integrity check failed for ${relative}`);
        }
      }
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function sameNumberList(left: readonly number[], right: readonly number[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summarize(options: ParsedArguments): void {
  const outputDir = path.resolve(options.outputDir as string);
  const manifest = readJson<ToolDisclosureManifest>(artifactPath(outputDir, "manifest.json"));
  assertManifestCompleted(manifest);
  validateFrozenManifest(manifest);
  const catalog = readJson<SyntheticCatalog>(artifactPath(outputDir, "catalog.json"));
  const primaryTasks = readJson<SyntheticTaskSet>(artifactPath(outputDir, "primary-tasks.json"));
  const stressTasks = readJson<SyntheticTaskSet>(artifactPath(outputDir, "stress-tasks.json"));
  const fixtures = readJson<FixtureManifestEntry[]>(artifactPath(outputDir, "fixtures.json"));
  const schedule = readJson<ReturnType<typeof buildToolDisclosureSchedule>>(
    artifactPath(outputDir, "schedule.json"),
  );
  assertValidSyntheticCatalog(catalog);
  assertValidSyntheticTaskSet(primaryTasks, catalog);
  assertValidSyntheticTaskSet(stressTasks, catalog);
  assertPreparedIdentity(manifest, catalog, primaryTasks, stressTasks);
  validateOpenClawFixtures(outputDir, catalog, fixtures);
  const runs = readJsonLines<ToolDisclosureRun>(artifactPath(outputDir, "runs.jsonl"));
  const rawEvidence = readJsonLines<SanitizedRunEvidence>(
    artifactPath(outputDir, "raw-events.jsonl"),
  );
  const journal = readJsonLines<AttemptJournalEntry>(
    artifactPath(outputDir, "attempt-journal.jsonl"),
  );
  if (
    JSON.stringify(journal.map((entry) => entry.raw)) !== JSON.stringify(rawEvidence) ||
    JSON.stringify(journal.map((entry) => entry.run)) !== JSON.stringify(runs)
  ) {
    throw new Error("materialized evidence differs from the atomic attempt journal");
  }
  const attestations = readJson<CampaignAttestation[]>(
    artifactPath(outputDir, "campaign-attestations.json"),
  );
  validateCampaignAttestations(manifest, attestations);
  validateCompleteEvidence({
    manifest,
    runs,
    schedule,
    primaryTasks,
    stressTasks,
    rawEvidence,
    catalog,
  });
  const summary = buildToolDisclosureSummary(manifest, runs);
  writeJsonArtifact(outputDir, "summary.json", summary);
  const reportInputs = [
    evidenceArtifact(outputDir, "catalog.json", "catalog"),
    evidenceArtifact(outputDir, "primary-tasks.json", "tasks"),
    evidenceArtifact(outputDir, "stress-tasks.json", "tasks"),
    evidenceArtifact(outputDir, "schedule.json", "schedule"),
    evidenceArtifact(outputDir, "fixtures.json", "fixture-manifest"),
    evidenceArtifact(outputDir, "manifest.json", "manifest"),
    evidenceArtifact(outputDir, "raw-events.jsonl", "raw-events"),
    evidenceArtifact(outputDir, "attempt-journal.jsonl", "attempt-journal"),
    evidenceArtifact(outputDir, "campaign-attestations.json", "attestation"),
    evidenceArtifact(outputDir, "runs.jsonl", "runs"),
    evidenceArtifact(outputDir, "summary.json", "summary"),
  ];
  writeTextArtifact(
    outputDir,
    "report.md",
    renderToolDisclosureMarkdown(manifest, summary, {
      artifacts: reportInputs,
    }),
  );
  const artifacts = [...reportInputs, evidenceArtifact(outputDir, "report.md", "report")];
  const bundle: EvidenceBundle = {
    schema_version: TOOL_DISCLOSURE_SCHEMA_VERSION,
    benchmark_id: manifest.benchmark_id,
    generated_at: new Date().toISOString(),
    artifacts,
  };
  writeJsonArtifact(outputDir, "evidence.json", bundle);
  const publicNames = [
    "catalog.json",
    "primary-tasks.json",
    "stress-tasks.json",
    "schedule.json",
    "fixtures.json",
    "manifest.json",
    "raw-events.jsonl",
    "attempt-journal.jsonl",
    "campaign-attestations.json",
    "runs.jsonl",
    "summary.json",
    "report.md",
    "evidence.json",
  ];
  scanArtifactsForForbiddenValues(outputDir, publicNames, options.forbiddenValues);
  writeChecksumManifest(outputDir, publicNames);
  process.stdout.write(
    `Summarized ${runs.length} runs. ${summary.claims.length} claim(s) cleared all gates.\n`,
  );
}

async function execute(options: ParsedArguments): Promise<void> {
  const outputDir = path.resolve(options.outputDir as string);
  const manifest = readJson<ToolDisclosureManifest>(artifactPath(outputDir, "manifest.json"));
  assertManifestCompleted(manifest);
  validateFrozenManifest(manifest);
  if (
    gitOutput(["rev-parse", "HEAD"]) !== manifest.harness.git_sha ||
    gitOutput(["status", "--porcelain=v1", "--untracked-files=normal"]) !== ""
  ) {
    throw new Error("execute requires the clean harness HEAD recorded in manifest.json");
  }
  const catalog = readJson<SyntheticCatalog>(artifactPath(outputDir, "catalog.json"));
  const primaryTasks = readJson<SyntheticTaskSet>(artifactPath(outputDir, "primary-tasks.json"));
  const stressTasks = readJson<SyntheticTaskSet>(artifactPath(outputDir, "stress-tasks.json"));
  const schedule = readJson<ReturnType<typeof buildToolDisclosureSchedule>>(
    artifactPath(outputDir, "schedule.json"),
  );
  assertValidSyntheticCatalog(catalog);
  assertValidSyntheticTaskSet(primaryTasks, catalog);
  assertValidSyntheticTaskSet(stressTasks, catalog);
  assertPreparedIdentity(manifest, catalog, primaryTasks, stressTasks);
  const expectedSchedule = buildToolDisclosureSchedule({
    primaryTaskIds: primaryTasks.tasks.map((task) => task.id),
    stressTaskIds: stressTasks.tasks.map((task) => task.id),
    seed: manifest.protocol.execution_seed,
  });
  if (JSON.stringify(schedule) !== JSON.stringify(expectedSchedule)) {
    throw new Error("execute refused a modified schedule.json");
  }
  await executeCampaign({
    outputDir,
    config: readJson<LiveCampaignConfiguration>(path.resolve(options.configPath as string)),
    manifest,
    catalog,
    primaryTasks,
    stressTasks,
    schedule,
  });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(args);
  if (options.command === "help") {
    process.stdout.write(usage());
    return;
  }
  if (options.command === "prepare") prepare(options);
  else if (options.command === "execute") await execute(options);
  else summarize(options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `tool-disclosure benchmark: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
