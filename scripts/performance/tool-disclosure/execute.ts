// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";

import { appendJsonLine, artifactPath, writeJsonArtifact, writeTextArtifact } from "./artifacts";
import { assembleToolDisclosureRun } from "./assemble-run";
import { generateCatalogPrefix, type SyntheticCatalog } from "./catalog";
import {
  buildAgentDriverCommand,
  buildOpenClawCallLogCommand,
  extractFinalAssistantOutput,
} from "./drivers";
import type { RecordedSyntheticCall } from "./grading";
import { SyntheticMcpServer } from "./mcp-server";
import { type QuickTunnel, startQuickTunnel } from "./quick-tunnel";
import { createToolDisclosureRecordingProxy, type ToolDisclosureRecordingEvent } from "./recorder";
import type { ScheduledToolDisclosureRun, ToolDisclosureAgent } from "./schedule";
import { runBoundedCommand } from "./subprocess";
import type { SyntheticPerformanceTask, SyntheticTaskSet } from "./tasks";
import {
  countTokensWithVllm,
  readVllmProcessStartTime,
  readVllmTokenSnapshot,
  tokenDelta,
} from "./telemetry";
import type { InferenceConfiguration, ToolDisclosureManifest, ToolDisclosureRun } from "./types";

export interface SanitizedRunEvidence {
  run_id: string;
  recorder_events: readonly ToolDisclosureRecordingEvent[];
  calls: readonly RecordedSyntheticCall[];
  invocation: { exit_code: number | null; timed_out: boolean; elapsed_ms: number };
  initial_schema_tokens: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  final_oracles_present: boolean;
  failure_outcome?: "setup-error" | "context-overflow";
}

export interface AttemptJournalEntry {
  raw: SanitizedRunEvidence;
  run: ToolDisclosureRun;
}

/** Permit retries only while an attempt is still wholly inside setup. */
export function assertSetupRetryAllowed(
  invocationAttempted: boolean,
  runId: string,
  cause?: unknown,
): void {
  if (invocationAttempted) {
    throw new Error(
      `run ${runId} failed after agent invocation began; discard this campaign and restart it with fresh resources`,
      { cause },
    );
  }
}

/** Continue setup retries across process restarts without resetting the allowance. */
export function nextSetupAttempt(
  entries: readonly AttemptJournalEntry[],
  runId: string,
  retrySetupFailures: number,
): number {
  if (!Number.isSafeInteger(retrySetupFailures) || retrySetupFailures < 0) {
    throw new Error("retry_setup_failures must be a non-negative integer");
  }
  const used = entries.filter(
    (entry) => entry.run.run_id === runId && entry.run.outcome === "setup-error",
  ).length;
  if (used > retrySetupFailures) throw new Error(`run ${runId} exhausted setup retries`);
  return used;
}

export function recoverAttemptJournal(outputDir: string): AttemptJournalEntry[] {
  const file = artifactPath(outputDir, "attempt-journal.jsonl");
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const entries: AttemptJournalEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AttemptJournalEntry);
    } catch {
      const isUnterminatedFinalAppend = index === lines.length - 1 && !raw.endsWith("\n");
      if (!isUnterminatedFinalAppend) {
        throw new Error(`attempt journal is corrupt at line ${index + 1}`);
      }
      writeTextArtifact(
        outputDir,
        "attempt-journal.jsonl",
        entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
      );
      break;
    }
  }
  return entries;
}

export function materializeAttemptJournal(
  outputDir: string,
  entries: readonly AttemptJournalEntry[],
): void {
  const lines = (select: (entry: AttemptJournalEntry) => unknown): string =>
    entries.map((entry) => JSON.stringify(select(entry))).join("\n") + (entries.length ? "\n" : "");
  writeTextArtifact(
    outputDir,
    "raw-events.jsonl",
    lines((entry) => entry.raw),
  );
  writeTextArtifact(
    outputDir,
    "runs.jsonl",
    lines((entry) => entry.run),
  );
}

export interface LiveCampaignConfiguration {
  campaign: 1 | 2;
  upstream_vllm_url: string;
  telemetry_url: string;
  tokenizer_model: string;
  recorder_port: number;
  managed_inference_base_url: string;
  vllm_container_name: string;
  vllm_container_id: string;
  sandbox_names: Record<string, string>;
  /** Private live sandbox instance IDs, verified against status and published only as hashes. */
  sandbox_instance_ids: Record<string, string>;
  sandbox_container_names: Record<string, string>;
  timeout_ms?: number;
  openshell_bin?: string;
  nemoclaw_bin?: string;
  cloudflared_bin?: string;
  docker_bin?: string;
}

export interface CampaignAttestation {
  campaign_id: string;
  vllm_process_start_time_seconds: number;
  inference_container_id_sha256: string;
  inference_config_sha256: string;
  inference_image_digest: string;
  sandbox_cells: readonly {
    cell: string;
    instance_id_sha256: string;
    status_sha256: string;
    image_digest: string;
  }[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Accept only the single inspect result whose immutable ID was requested. */
export function selectInspectedContainer<T extends { Id?: string }>(
  value: unknown,
  expectedId: string,
): (T & { Id: string }) | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  return (
    (value as Array<(T & { Id: string }) | null>).find(
      (candidate) => candidate?.Id === expectedId,
    ) ?? undefined
  );
}

const PUBLIC_VLLM_ENV_NAMES = new Set([
  "VLLM_ATTENTION_BACKEND",
  "VLLM_USE_V1",
  "VLLM_WORKER_MULTIPROC_METHOD",
]);
const SHELL_EXECUTABLE_NAMES = new Set(["ash", "bash", "dash", "ksh", "sh", "zsh"]);
const SHELL_CONTROL_TOKENS = new Set(["&", "&&", ";", "|", "||"]);

interface InspectedVllmContainer {
  Id?: string;
  Image?: string;
  Config?: {
    Cmd?: unknown;
    Entrypoint?: unknown;
    Env?: unknown;
    Labels?: unknown;
  };
}

export interface AttestedVllmConfiguration {
  cmd: readonly string[];
  entrypoint: readonly string[];
  env: readonly string[];
}

function inspectedStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value;
}

/** Tokenize the literal shell command used by Docker's `sh -c` form without expanding it. */
function tokenizeShellCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "single" | "double" | undefined;
  const pushWord = (): void => {
    if (!wordStarted) return;
    tokens.push(word);
    word = "";
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        index += 1;
        if (index >= command.length) return undefined;
        word += command[index];
      } else {
        word += character;
      }
      continue;
    }
    if (/\s/u.test(character)) {
      pushWord();
      if (character === "\n") tokens.push(";");
    } else if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      wordStarted = true;
    } else if (character === "\\") {
      index += 1;
      if (index >= command.length) return undefined;
      word += command[index];
      wordStarted = true;
    } else if (character === ";" || character === "&" || character === "|") {
      pushWord();
      const doubled = command[index + 1] === character;
      tokens.push(doubled ? `${character}${character}` : character);
      if (doubled) index += 1;
    } else {
      word += character;
      wordStarted = true;
    }
  }
  if (quote) return undefined;
  pushWord();
  return tokens;
}

function inspectedProcessTokens(
  entrypoint: readonly string[],
  cmd: readonly string[],
): string[] | undefined {
  const argv = [...entrypoint, ...cmd];
  const shellIndex = argv.findIndex((value) =>
    SHELL_EXECUTABLE_NAMES.has(value.split("/").pop() ?? ""),
  );
  if (shellIndex < 0) return argv;
  const shellOption = argv[shellIndex + 1];
  if (!shellOption?.startsWith("-") || !shellOption.slice(1).includes("c")) return argv;
  const commandIndex = shellIndex + 2;
  const shellTokens = tokenizeShellCommand(argv[commandIndex] ?? "");
  if (!shellTokens) return undefined;
  return [...argv.slice(0, commandIndex), ...shellTokens, ...argv.slice(commandIndex + 1)];
}

function optionMatches(args: readonly string[], name: string, value: string): boolean {
  return args.some(
    (argument, index) =>
      argument === `${name}=${value}` || (argument === name && args[index + 1] === value),
  );
}

function containsSequence(values: readonly string[], expected: readonly string[]): boolean {
  if (expected.length === 0) return false;
  return values.some((_, index) =>
    expected.every((value, offset) => values[index + offset] === value),
  );
}

function vllmInvocation(
  tokens: readonly string[],
): { kind: "serve" | "api-server"; args: readonly string[] } | undefined {
  const candidates: { kind: "serve" | "api-server"; start: number }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const executable = tokens[index].split("/").pop() ?? "";
    if (executable === "vllm" && tokens[index + 1] === "serve") {
      candidates.push({ kind: "serve", start: index + 2 });
    }
    if (
      /^python(?:\d+(?:\.\d+)*)?$/u.test(executable) &&
      tokens[index + 1] === "-m" &&
      tokens[index + 2] === "vllm.entrypoints.openai.api_server"
    ) {
      candidates.push({ kind: "api-server", start: index + 3 });
    }
  }
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  const boundary = tokens.findIndex(
    (token, index) => index >= candidate.start && SHELL_CONTROL_TOKENS.has(token),
  );
  return {
    kind: candidate.kind,
    args: tokens.slice(candidate.start, boundary < 0 ? undefined : boundary),
  };
}

/** Extract only a structurally verified process configuration from Docker inspect. */
export function readAttestedVllmConfiguration(
  container: InspectedVllmContainer,
  expected: InferenceConfiguration,
): AttestedVllmConfiguration | undefined {
  const cmd = inspectedStringArray(container.Config?.Cmd);
  const entrypoint = inspectedStringArray(container.Config?.Entrypoint);
  const rawEnv = inspectedStringArray(container.Config?.Env);
  if (!cmd || !entrypoint || !rawEnv) return undefined;
  const tokens = inspectedProcessTokens(entrypoint, cmd);
  if (!tokens) return undefined;
  const invocation = vllmInvocation(tokens);
  if (!invocation) return undefined;
  const modelMatches =
    (invocation.kind === "serve" && invocation.args[0] === expected.model_id) ||
    optionMatches(invocation.args, "--model", expected.model_id);
  const publicFlagsMatch = expected.public_vllm_flags.every((flag) => {
    const flagTokens = tokenizeShellCommand(flag);
    return (
      flagTokens !== undefined &&
      flagTokens.every((token) => !SHELL_CONTROL_TOKENS.has(token)) &&
      containsSequence(invocation.args, flagTokens)
    );
  });
  if (
    !modelMatches ||
    !optionMatches(invocation.args, "--revision", expected.model_revision) ||
    !optionMatches(invocation.args, "--tool-call-parser", expected.tool_call_parser) ||
    !optionMatches(invocation.args, "--reasoning-parser", expected.reasoning_parser) ||
    !publicFlagsMatch
  ) {
    return undefined;
  }

  const publicEnv = rawEnv
    .filter((entry) => PUBLIC_VLLM_ENV_NAMES.has(entry.slice(0, entry.indexOf("="))))
    .sort();
  if (
    new Set(publicEnv.map((entry) => entry.slice(0, entry.indexOf("=")))).size !== publicEnv.length
  ) {
    return undefined;
  }
  return { cmd, entrypoint, env: publicEnv };
}

async function attestVllmContainer(options: {
  config: LiveCampaignConfiguration;
  manifest: ToolDisclosureManifest;
}): Promise<
  Pick<
    CampaignAttestation,
    "inference_container_id_sha256" | "inference_config_sha256" | "inference_image_digest"
  >
> {
  const result = await runBoundedCommand({
    command: options.config.docker_bin ?? "docker",
    args: ["inspect", options.config.vllm_container_name],
    timeoutMs: 30_000,
  });
  if (result.exit_code !== 0 || result.timed_out || result.output_truncated) {
    throw new Error("vLLM container inspection failed");
  }
  const container = selectInspectedContainer<InspectedVllmContainer>(
    JSON.parse(result.stdout) as unknown,
    options.config.vllm_container_id,
  );
  const expected = options.manifest.inference;
  const publicConfig = container ? readAttestedVllmConfiguration(container, expected) : undefined;
  if (!container || container.Image !== expected.container_digest || !publicConfig) {
    throw new Error("live vLLM container does not match the frozen manifest");
  }
  return {
    inference_container_id_sha256: sha256(container.Id),
    inference_config_sha256: sha256(JSON.stringify(publicConfig)),
    inference_image_digest: container.Image,
  };
}

async function attestSandbox(options: {
  config: LiveCampaignConfiguration;
  manifest: ToolDisclosureManifest;
  cell: string;
}): Promise<CampaignAttestation["sandbox_cells"][number]> {
  const sandboxName = options.config.sandbox_names[options.cell];
  const instanceId = options.config.sandbox_instance_ids[options.cell];
  const imageDigest = options.manifest.environment.sandbox_image_digests?.[options.cell] ?? "";
  if (!instanceId) throw new Error(`live config is missing sandbox instance ID ${options.cell}`);
  const result = await runBoundedCommand({
    command: options.config.nemoclaw_bin ?? "nemoclaw",
    args: [sandboxName, "status", "--json"],
    timeoutMs: 120_000,
  });
  if (result.exit_code !== 0 || result.timed_out || result.output_truncated) {
    throw new Error(`sandbox status attestation failed for ${options.cell}`);
  }
  const status = JSON.parse(result.stdout) as {
    found?: boolean;
    agent?: string;
    gatewayState?: string;
  };
  const [agent, mode] = options.cell.split(":");
  if (!status.found || status.agent !== agent || status.gatewayState !== "present") {
    throw new Error(`sandbox status does not attest the expected cell ${options.cell}`);
  }
  const containerName = options.config.sandbox_container_names[options.cell];
  if (!containerName) throw new Error(`live config is missing container name ${options.cell}`);
  const inspected = await runBoundedCommand({
    command: options.config.docker_bin ?? "docker",
    args: ["inspect", containerName],
    timeoutMs: 30_000,
  });
  if (inspected.exit_code !== 0 || inspected.timed_out || inspected.output_truncated) {
    throw new Error(`container inspection failed for ${options.cell}`);
  }
  const container = selectInspectedContainer<{
    Id?: string;
    Image?: string;
    Config?: { Env?: string[] };
  }>(JSON.parse(inspected.stdout) as unknown, instanceId);
  if (
    !container ||
    container.Image !== imageDigest ||
    !container.Config?.Env?.includes(`NEMOCLAW_TOOL_DISCLOSURE=${mode}`)
  ) {
    throw new Error(`live container does not attest the expected cell ${options.cell}`);
  }
  return {
    cell: options.cell,
    instance_id_sha256: sha256(instanceId),
    status_sha256: sha256(`${result.stdout}\n${inspected.stdout}`),
    image_digest: imageDigest,
  };
}

function recordCampaignAttestation(outputDir: string, attestation: CampaignAttestation): void {
  const file = artifactPath(outputDir, "campaign-attestations.json");
  const existing = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as CampaignAttestation[])
    : [];
  const priorSame = existing.find((item) => item.campaign_id === attestation.campaign_id);
  if (priorSame) {
    if (priorSame.vllm_process_start_time_seconds !== attestation.vllm_process_start_time_seconds) {
      throw new Error("campaign resume attempted against a different vLLM process");
    }
    const priorInstances = priorSame.sandbox_cells.map((cell) => cell.instance_id_sha256).sort();
    const currentInstances = attestation.sandbox_cells
      .map((cell) => cell.instance_id_sha256)
      .sort();
    if (JSON.stringify(priorInstances) !== JSON.stringify(currentInstances)) {
      throw new Error("campaign resume attempted against different sandbox instances");
    }
    return;
  }
  for (const prior of existing) {
    if (prior.vllm_process_start_time_seconds === attestation.vllm_process_start_time_seconds) {
      throw new Error("campaigns must use distinct fresh vLLM processes");
    }
    const priorIds = new Set(prior.sandbox_cells.map((cell) => cell.instance_id_sha256));
    if (attestation.sandbox_cells.some((cell) => priorIds.has(cell.instance_id_sha256))) {
      throw new Error("campaigns must use distinct fresh sandbox instances");
    }
  }
  writeJsonArtifact(outputDir, "campaign-attestations.json", [...existing, attestation]);
}

function sandboxKey(run: ScheduledToolDisclosureRun): string {
  return `${run.agent}:${run.mode}:${run.catalog_size}`;
}

function parseCalls(raw: string): RecordedSyntheticCall[] {
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RecordedSyntheticCall);
}

function isContextOverflow(stdout: string, stderr: string): boolean {
  return /context(?:_| )length(?:_| )exceeded|maximum context length|context window|too many tokens/iu.test(
    `${stdout}\n${stderr}`,
  );
}

export function classifyInvocationFailure(options: {
  phase: ScheduledToolDisclosureRun["phase"];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): "context-overflow" | undefined {
  return options.phase !== "static-visibility" &&
    !options.timedOut &&
    options.exitCode !== null &&
    options.exitCode !== 0 &&
    isContextOverflow(options.stdout, options.stderr)
    ? "context-overflow"
    : undefined;
}

async function command(built: ReturnType<typeof buildAgentDriverCommand>, timeoutMs: number) {
  return await runBoundedCommand({
    command: built.command,
    args: built.args,
    timeoutMs,
    redactions: built.redactions,
  });
}

async function configureMcpSandbox(options: {
  config: LiveCampaignConfiguration;
  agent: ToolDisclosureAgent;
  sandboxName: string;
  url: string;
  token: string;
  tokenEnv: string;
}): Promise<void> {
  const binary = options.config.nemoclaw_bin ?? "nemoclaw";
  const invoke = async (args: string[]) => {
    const result = await runBoundedCommand({
      command: binary,
      args,
      env: { ...process.env, [options.tokenEnv]: options.token },
      timeoutMs: 20 * 60_000,
      redactions: [options.token],
    });
    return result;
  };
  const run = async (args: string[]): Promise<void> => {
    const result = await invoke(args);
    if (result.exit_code !== 0 || result.timed_out || result.output_truncated) {
      throw new Error(`MCP setup failed for ${options.agent} sandbox`);
    }
  };
  if (options.agent === "hermes") {
    await run([
      options.sandboxName,
      "shields",
      "down",
      "--timeout",
      "15m",
      "--reason",
      "tool disclosure performance test setup",
    ]);
  }
  try {
    const listed = await invoke([options.sandboxName, "mcp", "list", "--json"]);
    if (listed.exit_code !== 0 || listed.timed_out || listed.output_truncated) {
      throw new Error(`MCP inventory failed for ${options.agent} sandbox`);
    }
    if (/"(?:name|server)"\s*:\s*"performance-test"/u.test(listed.stdout)) {
      await run([options.sandboxName, "mcp", "remove", "performance-test", "--force"]);
    }
    await run([
      options.sandboxName,
      "mcp",
      "add",
      "performance-test",
      "--url",
      options.url,
      "--env",
      options.tokenEnv,
    ]);
  } finally {
    if (options.agent === "hermes") await run([options.sandboxName, "shields", "up"]);
  }
}

function taskMap(
  primary: SyntheticTaskSet,
  stress: SyntheticTaskSet,
): Map<string, SyntheticPerformanceTask> {
  return new Map([...primary.tasks, ...stress.tasks].map((task) => [task.id, task] as const));
}

/** Execute one frozen campaign against already-created fresh sandboxes and vLLM. */
export async function executeCampaign(options: {
  outputDir: string;
  config: LiveCampaignConfiguration;
  manifest: ToolDisclosureManifest;
  catalog: SyntheticCatalog;
  primaryTasks: SyntheticTaskSet;
  stressTasks: SyntheticTaskSet;
  schedule: readonly ScheduledToolDisclosureRun[];
}): Promise<void> {
  if (options.config.campaign !== 1 && options.config.campaign !== 2) {
    throw new Error("live campaign configuration must select campaign 1 or 2");
  }
  const scheduled = options.schedule.filter((run) => run.campaign === options.config.campaign);
  const expectedKeys = new Set(scheduled.map(sandboxKey));
  for (const key of expectedKeys) {
    if (!options.config.sandbox_names[key])
      throw new Error(`live config is missing sandbox ${key}`);
  }
  const names = [...expectedKeys].map((key) => options.config.sandbox_names[key]);
  if (new Set(names).size !== names.length)
    throw new Error("every performance test cell needs a unique sandbox");
  const instanceIds = [...expectedKeys].map((key) => options.config.sandbox_instance_ids[key]);
  if (instanceIds.some((value) => !value) || new Set(instanceIds).size !== instanceIds.length) {
    throw new Error("every performance test cell needs a unique live sandbox instance ID");
  }
  const containerNames = [...expectedKeys].map(
    (key) => options.config.sandbox_container_names[key],
  );
  if (
    containerNames.some((value) => !value) ||
    new Set(containerNames).size !== containerNames.length
  ) {
    throw new Error("every performance test cell needs a unique live container name");
  }
  if (options.config.tokenizer_model !== options.manifest.inference.model_id) {
    throw new Error("tokenizer_model must exactly match manifest.inference.model_id");
  }
  if (
    new URL(options.config.upstream_vllm_url).origin !==
    new URL(options.config.telemetry_url).origin
  ) {
    throw new Error("inference and telemetry must address the same vLLM process");
  }
  const journal = recoverAttemptJournal(options.outputDir);
  const existing = journal.map((entry) => entry.run);
  const complete = new Set(
    existing.filter((run) => run.outcome !== "setup-error").map((run) => run.run_id),
  );
  const token = randomBytes(32).toString("hex");
  const tokenEnv = "TOOL_DISCLOSURE_PERFORMANCE_TEST_MCP_TOKEN";
  const proxy = createToolDisclosureRecordingProxy({
    upstreamBaseUrl: options.config.upstream_vllm_url,
    port: options.config.recorder_port,
    requiredTemperature: 0,
  });
  const servers = new Map<number, SyntheticMcpServer>();
  const tunnels = new Map<number, QuickTunnel>();
  try {
    const proxyAddress = await proxy.start();
    if (proxyAddress.base_url !== options.config.managed_inference_base_url) {
      throw new Error("managed inference route does not match the started recorder address");
    }
    const processStart = await readVllmProcessStartTime(options.config.telemetry_url);
    const inferenceAttestation = await attestVllmContainer({
      config: options.config,
      manifest: options.manifest,
    });
    const sandboxCells: CampaignAttestation["sandbox_cells"][number][] = [];
    for (const cell of [...expectedKeys].sort()) {
      sandboxCells.push(
        await attestSandbox({ config: options.config, manifest: options.manifest, cell }),
      );
    }
    recordCampaignAttestation(options.outputDir, {
      campaign_id: `campaign-${options.config.campaign}`,
      vllm_process_start_time_seconds: processStart,
      ...inferenceAttestation,
      sandbox_cells: sandboxCells,
    });
    for (const size of [16, 64, 256, 512, 2_209]) {
      const server = new SyntheticMcpServer(generateCatalogPrefix(options.catalog, size), token);
      const address = await server.start();
      servers.set(size, server);
      tunnels.set(
        size,
        await startQuickTunnel({
          port: address.port,
          binary: options.config.cloudflared_bin,
        }),
      );
    }
    for (const key of expectedKeys) {
      const [agent, , sizeText] = key.split(":") as [ToolDisclosureAgent, string, string];
      if (agent === "openclaw") continue;
      await configureMcpSandbox({
        config: options.config,
        agent,
        sandboxName: options.config.sandbox_names[key],
        url: tunnels.get(Number(sizeText))?.mcpUrl ?? "",
        token,
        tokenEnv,
      });
    }

    const tasks = taskMap(options.primaryTasks, options.stressTasks);
    const timeoutMs = options.config.timeout_ms ?? 10 * 60_000;
    for (const run of scheduled) {
      if (complete.has(run.run_id)) continue;
      const task = run.task_id ? tasks.get(run.task_id) : undefined;
      const sandboxName = options.config.sandbox_names[sandboxKey(run)];
      const mcp = run.agent === "openclaw" ? undefined : servers.get(run.catalog_size);
      const firstAttempt = nextSetupAttempt(
        journal,
        run.run_id,
        options.manifest.protocol.retry_setup_failures,
      );
      for (
        let attempt = firstAttempt;
        attempt <= options.manifest.protocol.retry_setup_failures;
        attempt += 1
      ) {
        let invocationAttempted = false;
        try {
          if (run.agent === "openclaw") {
            const reset = await command(
              buildOpenClawCallLogCommand({
                openshellBin: options.config.openshell_bin,
                sandboxName,
                action: "reset",
              }),
              timeoutMs,
            );
            if (reset.exit_code !== 0 || reset.timed_out)
              throw new Error("OpenClaw call-log reset failed");
          }
          mcp?.beginRun(run.run_id);
          proxy.beginRun(run.run_id);
          const before = await readVllmTokenSnapshot(options.config.telemetry_url);
          const driverCommand = buildAgentDriverCommand({
            openshellBin: options.config.openshell_bin,
            sandboxName,
            agent: run.agent,
            prompt: task?.prompt ?? "Without using tools, reply exactly STATIC-CAPTURE.",
            sessionId: run.run_id,
          });
          invocationAttempted = true;
          const invocation = await command(driverCommand, timeoutMs);
          if (invocation.output_truncated)
            throw new Error("agent output exceeded the evidence bound");
          const after = await readVllmTokenSnapshot(options.config.telemetry_url);
          const recorderEvents = proxy.endRun();
          const snapshots = proxy.consumeToolSchemaSnapshots(run.run_id);
          if (!snapshots[0]) throw new Error("recorder did not capture an initial tool schema");
          const initialSchemaTokens = await countTokensWithVllm(
            options.config.telemetry_url,
            options.config.tokenizer_model,
            snapshots[0].canonical_tools_json,
          );
          let calls: RecordedSyntheticCall[];
          if (run.agent === "openclaw") {
            const callLog = await command(
              buildOpenClawCallLogCommand({
                openshellBin: options.config.openshell_bin,
                sandboxName,
                action: "read",
              }),
              timeoutMs,
            );
            if (callLog.exit_code !== 0 || callLog.timed_out || callLog.output_truncated) {
              throw new Error("OpenClaw call-log read failed");
            }
            calls = parseCalls(callLog.stdout);
          } else {
            calls = mcp?.endRun() ?? [];
          }
          const tokens = tokenDelta(before, after);
          if (!tokens.available) throw new Error("vLLM token counters were unavailable or reset");
          const finalOutput = extractFinalAssistantOutput(run.agent, invocation.stdout);
          const classifiedFailure = classifyInvocationFailure({
            phase: run.phase,
            exitCode: invocation.exit_code,
            timedOut: invocation.timed_out,
            stdout: invocation.stdout,
            stderr: invocation.stderr,
          });
          const rawEvidence: SanitizedRunEvidence = {
            run_id: run.run_id,
            recorder_events: recorderEvents,
            calls,
            invocation: {
              exit_code: invocation.exit_code,
              timed_out: invocation.timed_out,
              elapsed_ms: invocation.elapsed_ms,
            },
            initial_schema_tokens: initialSchemaTokens,
            ...(tokens.available
              ? { prompt_tokens: tokens.prompt_tokens, completion_tokens: tokens.generation_tokens }
              : {}),
            final_oracles_present:
              !task || task.expected_final_includes.every((oracle) => finalOutput.includes(oracle)),
            ...(classifiedFailure ? { failure_outcome: classifiedFailure } : {}),
          };
          const record = assembleToolDisclosureRun({
            manifest: options.manifest,
            scheduled: run,
            task,
            calls,
            recorderEvents,
            invocation: {
              exit_code: invocation.exit_code,
              timed_out: invocation.timed_out,
              elapsed_ms: invocation.elapsed_ms,
              final_output: finalOutput,
            },
            initialSchemaTokens,
            ...(tokens.available
              ? { promptTokens: tokens.prompt_tokens, completionTokens: tokens.generation_tokens }
              : {}),
            ...(classifiedFailure ? { failureOutcome: classifiedFailure } : {}),
          });
          const entry = { raw: rawEvidence, run: record } satisfies AttemptJournalEntry;
          appendJsonLine(options.outputDir, "attempt-journal.jsonl", entry);
          journal.push(entry);
          break;
        } catch (error) {
          try {
            proxy.endRun();
          } catch {}
          try {
            mcp?.endRun();
          } catch {}
          assertSetupRetryAllowed(invocationAttempted, run.run_id, error);
          const setupEvidence: SanitizedRunEvidence = {
            run_id: run.run_id,
            recorder_events: [],
            calls: [],
            invocation: { exit_code: null, timed_out: false, elapsed_ms: 0 },
            initial_schema_tokens: 0,
            final_oracles_present: false,
            failure_outcome: "setup-error",
          };
          const setupRun = assembleToolDisclosureRun({
            manifest: options.manifest,
            scheduled: run,
            task,
            calls: [],
            recorderEvents: [],
            invocation: { exit_code: null, timed_out: false, elapsed_ms: 0, final_output: "" },
            initialSchemaTokens: 0,
            failureOutcome: "setup-error",
          });
          const entry = { raw: setupEvidence, run: setupRun } satisfies AttemptJournalEntry;
          appendJsonLine(options.outputDir, "attempt-journal.jsonl", entry);
          journal.push(entry);
          if (attempt === options.manifest.protocol.retry_setup_failures)
            throw new Error(`run ${run.run_id} exhausted setup retries`);
        }
      }
    }
    materializeAttemptJournal(options.outputDir, journal);
  } finally {
    await Promise.allSettled([...tunnels.values()].map((tunnel) => tunnel.close()));
    await Promise.allSettled([...servers.values()].map((server) => server.stop()));
    await proxy.stop();
  }
}
