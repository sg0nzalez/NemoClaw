// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildSyntheticArguments,
  canonicalJson,
  executeSyntheticTool,
  type JsonObject,
  type JsonValue,
  SYNTHETIC_CATEGORIES,
  type SyntheticCatalog,
  type SyntheticTool,
  sha256Hex,
  validateSyntheticArguments,
} from "./catalog";

export const TOOL_DISCLOSURE_TASK_SCHEMA_VERSION = "nemoclaw.tool_disclosure.tasks.v1" as const;
export const PRIMARY_TASK_COUNT = 24;
export const PRIMARY_CATALOG_MIN_SIZE = 64;
export const STRESS_TASK_COUNT = 8;
export const STRESS_CATALOG_SIZE = 2_209;

export type BenchmarkTaskKind = "single-tool" | "ordered-chain" | "near-match" | "no-tool";
export type BenchmarkTaskSuite = "primary" | "stress";

export interface ExpectedToolCall {
  tool_name: string;
  arguments: JsonObject;
  result_nonce: string;
}

export interface SyntheticBenchmarkTask {
  id: string;
  suite: BenchmarkTaskSuite;
  kind: BenchmarkTaskKind;
  prompt: string;
  min_catalog_size: number;
  expected_calls: ExpectedToolCall[];
  expected_final_includes: string[];
  distractor_tool_names: string[];
}

export interface SyntheticTaskSet {
  schema_version: typeof TOOL_DISCLOSURE_TASK_SCHEMA_VERSION;
  catalog_seed: string;
  suite: BenchmarkTaskSuite;
  task_count: number;
  tasks_sha256: string;
  tasks: SyntheticBenchmarkTask[];
}

function toolAt(catalog: SyntheticCatalog, index: number): SyntheticTool {
  const tool = catalog.tools[index];
  if (!tool) throw new RangeError(`catalog does not contain required tool index ${index}`);
  return tool;
}

function categoryDetails(tool: SyntheticTool): (typeof SYNTHETIC_CATEGORIES)[number] {
  const category = SYNTHETIC_CATEGORIES.find((candidate) => candidate.id === tool.category);
  if (!category) throw new Error(`unknown synthetic category ${tool.category}`);
  return category;
}

function expectedCall(tool: SyntheticTool, args: JsonObject): ExpectedToolCall {
  return {
    tool_name: tool.definition.function.name,
    arguments: args,
    result_nonce: executeSyntheticTool(tool, args).nonce,
  };
}

function operationText(tool: SyntheticTool): string {
  const category = categoryDetails(tool);
  return `the ${tool.operation.replaceAll("_", " ")} operation for a synthetic ${category.resource} in ${category.label}`;
}

function positiveFinalInstruction(callCount: number): string {
  return callCount === 1
    ? "Include the returned nonce exactly in the final answer."
    : "Include both returned nonces exactly, in call order, in the final answer.";
}

function buildSingleTask(
  suite: BenchmarkTaskSuite,
  ordinal: number,
  tool: SyntheticTool,
  variant: number,
): SyntheticBenchmarkTask {
  const args = buildSyntheticArguments(tool, variant);
  const call = expectedCall(tool, args);
  return {
    id: `${suite}-single-${String(ordinal).padStart(2, "0")}`,
    suite,
    kind: "single-tool",
    prompt: [
      `Use the available tools to perform ${operationText(tool)}.`,
      `Pass exactly these arguments: ${canonicalJson(args)}.`,
      positiveFinalInstruction(1),
    ].join(" "),
    min_catalog_size: tool.index + 1,
    expected_calls: [call],
    expected_final_includes: [call.result_nonce],
    distractor_tool_names: [],
  };
}

function buildChainTask(
  ordinal: number,
  firstTool: SyntheticTool,
  secondTool: SyntheticTool,
): SyntheticBenchmarkTask {
  const firstArgs = buildSyntheticArguments(firstTool, 200 + ordinal);
  const firstCall = expectedCall(firstTool, firstArgs);
  const secondArgs = buildSyntheticArguments(secondTool, 300 + ordinal, {
    resource_id: firstCall.result_nonce,
  });
  const secondCall = expectedCall(secondTool, secondArgs);
  const secondFixedArgs = { ...secondArgs };
  delete secondFixedArgs.resource_id;

  return {
    id: `primary-chain-${String(ordinal).padStart(2, "0")}`,
    suite: "primary",
    kind: "ordered-chain",
    prompt: [
      `Complete two tool operations in order. First, perform ${operationText(firstTool)}`,
      `with exactly these arguments: ${canonicalJson(firstArgs)}.`,
      `Then perform ${operationText(secondTool)}. For the second call, set resource_id to the nonce`,
      `returned by the first call and pass these other fields exactly: ${canonicalJson(secondFixedArgs)}.`,
      positiveFinalInstruction(2),
    ].join(" "),
    min_catalog_size: Math.max(firstTool.index, secondTool.index) + 1,
    expected_calls: [firstCall, secondCall],
    expected_final_includes: [firstCall.result_nonce, secondCall.result_nonce],
    distractor_tool_names: [],
  };
}

function buildNearMatchTask(
  ordinal: number,
  target: SyntheticTool,
  distractors: readonly SyntheticTool[],
): SyntheticBenchmarkTask {
  const args = buildSyntheticArguments(target, 400 + ordinal);
  const call = expectedCall(target, args);
  const distractorOperations = distractors
    .map((tool) => tool.operation.replaceAll("_", " "))
    .join(" or ");

  return {
    id: `primary-near-match-${String(ordinal).padStart(2, "0")}`,
    suite: "primary",
    kind: "near-match",
    prompt: [
      `Use exactly one tool to perform ${operationText(target)}.`,
      `Do not perform the nearby ${distractorOperations} operations in the same category.`,
      `Pass exactly these arguments: ${canonicalJson(args)}.`,
      positiveFinalInstruction(1),
    ].join(" "),
    min_catalog_size: Math.max(target.index, ...distractors.map((tool) => tool.index)) + 1,
    expected_calls: [call],
    expected_final_includes: [call.result_nonce],
    distractor_tool_names: distractors.map((tool) => tool.definition.function.name),
  };
}

const NO_TOOL_CONTROLS = [
  {
    phrase: "CONTROL-NO-TOOL-ALPHA",
    prompt: "Without using tools, reply with the exact phrase CONTROL-NO-TOOL-ALPHA.",
  },
  {
    phrase: "CONTROL-NO-TOOL-BRAVO",
    prompt: "Do not call a tool. Return only the exact phrase CONTROL-NO-TOOL-BRAVO.",
  },
  {
    phrase: "CONTROL-NO-TOOL-CHARLIE",
    prompt: "This is a no-tool control: answer with exactly CONTROL-NO-TOOL-CHARLIE.",
  },
  {
    phrase: "CONTROL-NO-TOOL-DELTA",
    prompt: "Use no external capability and respond with exactly CONTROL-NO-TOOL-DELTA.",
  },
] as const;

function buildNoToolTasks(): SyntheticBenchmarkTask[] {
  return NO_TOOL_CONTROLS.map((control, index) => ({
    id: `primary-no-tool-${String(index + 1).padStart(2, "0")}`,
    suite: "primary",
    kind: "no-tool",
    prompt: control.prompt,
    min_catalog_size: 1,
    expected_calls: [],
    expected_final_includes: [control.phrase],
    distractor_tool_names: [],
  }));
}

export function buildPrimaryTasks(catalog: SyntheticCatalog): SyntheticBenchmarkTask[] {
  if (catalog.size < PRIMARY_CATALOG_MIN_SIZE) {
    throw new RangeError(
      `primary tasks require at least ${PRIMARY_CATALOG_MIN_SIZE} tools; catalog has ${catalog.size}`,
    );
  }

  const singleTasks = Array.from({ length: 8 }, (_, index) =>
    buildSingleTask("primary", index + 1, toolAt(catalog, index), 100 + index),
  );
  const chainTasks = Array.from({ length: 8 }, (_, index) =>
    buildChainTask(index + 1, toolAt(catalog, 8 + index * 2), toolAt(catalog, 9 + index * 2)),
  );
  const nearMatchTasks = Array.from({ length: 4 }, (_, index) =>
    buildNearMatchTask(index + 1, toolAt(catalog, 24 + index), [
      toolAt(catalog, index),
      toolAt(catalog, 48 + index),
    ]),
  );
  return [...singleTasks, ...chainTasks, ...nearMatchTasks, ...buildNoToolTasks()];
}

const STRESS_TOOL_INDICES = [256, 511, 767, 1_023, 1_279, 1_535, 1_791, 2_208] as const;

export function buildStressTasks(catalog: SyntheticCatalog): SyntheticBenchmarkTask[] {
  if (catalog.size < STRESS_CATALOG_SIZE) {
    throw new RangeError(
      `stress tasks require ${STRESS_CATALOG_SIZE} tools; catalog has ${catalog.size}`,
    );
  }
  return STRESS_TOOL_INDICES.map((toolIndex, index) =>
    buildSingleTask("stress", index + 1, toolAt(catalog, toolIndex), 500 + index),
  );
}

function buildTaskSet(
  catalog: SyntheticCatalog,
  suite: BenchmarkTaskSuite,
  tasks: SyntheticBenchmarkTask[],
): SyntheticTaskSet {
  return {
    schema_version: TOOL_DISCLOSURE_TASK_SCHEMA_VERSION,
    catalog_seed: catalog.seed,
    suite,
    task_count: tasks.length,
    tasks_sha256: sha256Hex(canonicalJson(tasks as unknown as JsonValue)),
    tasks,
  };
}

export function generatePrimaryTaskSet(catalog: SyntheticCatalog): SyntheticTaskSet {
  return buildTaskSet(catalog, "primary", buildPrimaryTasks(catalog));
}

export function generateStressTaskSet(catalog: SyntheticCatalog): SyntheticTaskSet {
  return buildTaskSet(catalog, "stress", buildStressTasks(catalog));
}

function expectedKindCounts(
  suite: BenchmarkTaskSuite,
): Readonly<Record<BenchmarkTaskKind, number>> {
  return suite === "primary"
    ? { "single-tool": 8, "ordered-chain": 8, "near-match": 4, "no-tool": 4 }
    : { "single-tool": 8, "ordered-chain": 0, "near-match": 0, "no-tool": 0 };
}

export function validateSyntheticTaskSet(
  taskSet: SyntheticTaskSet,
  catalog: SyntheticCatalog,
): string[] {
  const errors: string[] = [];
  if (taskSet.schema_version !== TOOL_DISCLOSURE_TASK_SCHEMA_VERSION) {
    errors.push(`unsupported task schema version: ${taskSet.schema_version}`);
  }
  if (taskSet.catalog_seed !== catalog.seed) errors.push("task and catalog seeds do not match");
  if (taskSet.task_count !== taskSet.tasks.length) errors.push("task_count does not match tasks");
  const expectedHash = sha256Hex(canonicalJson(taskSet.tasks as unknown as JsonValue));
  if (taskSet.tasks_sha256 !== expectedHash) errors.push("tasks_sha256 does not match tasks");

  const ids = new Set<string>();
  const tools = new Map(catalog.tools.map((tool) => [tool.definition.function.name, tool]));
  const counts: Record<BenchmarkTaskKind, number> = {
    "single-tool": 0,
    "ordered-chain": 0,
    "near-match": 0,
    "no-tool": 0,
  };

  for (const task of taskSet.tasks) {
    counts[task.kind] += 1;
    if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (task.suite !== taskSet.suite) errors.push(`${task.id} has the wrong suite`);
    if (task.prompt.trim().length === 0) errors.push(`${task.id} has an empty prompt`);
    if (task.min_catalog_size > catalog.size) errors.push(`${task.id} exceeds catalog size`);

    for (const call of task.expected_calls) {
      const tool = tools.get(call.tool_name);
      if (!tool) {
        errors.push(`${task.id} references missing tool ${call.tool_name}`);
        continue;
      }
      const argumentErrors = validateSyntheticArguments(tool, call.arguments);
      if (argumentErrors.length > 0) {
        errors.push(`${task.id} has invalid arguments for ${call.tool_name}`);
        continue;
      }
      const result = executeSyntheticTool(tool, call.arguments);
      if (result.nonce !== call.result_nonce)
        errors.push(`${task.id} has an incorrect result nonce`);
      if (tool.index + 1 > task.min_catalog_size)
        errors.push(`${task.id} has a low min_catalog_size`);
      if (!task.expected_final_includes.includes(call.result_nonce)) {
        errors.push(`${task.id} does not require its result nonce in the final answer`);
      }
    }

    if (task.kind === "single-tool" && task.expected_calls.length !== 1) {
      errors.push(`${task.id} must expect exactly one call`);
    }
    if (task.kind === "ordered-chain") {
      if (task.expected_calls.length !== 2) {
        errors.push(`${task.id} must expect exactly two calls`);
      } else if (
        task.expected_calls[1].arguments.resource_id !== task.expected_calls[0].result_nonce
      ) {
        errors.push(`${task.id} does not pass the first nonce into the second call`);
      }
    }
    if (task.kind === "near-match") {
      if (task.expected_calls.length !== 1 || task.distractor_tool_names.length < 1) {
        errors.push(`${task.id} must have one expected call and at least one distractor`);
      }
      for (const distractor of task.distractor_tool_names) {
        if (!tools.has(distractor))
          errors.push(`${task.id} references missing distractor ${distractor}`);
        if (task.expected_calls.some((call) => call.tool_name === distractor)) {
          errors.push(`${task.id} calls a declared distractor`);
        }
      }
    }
    if (task.kind === "no-tool" && task.expected_calls.length !== 0) {
      errors.push(`${task.id} must not expect tool calls`);
    }
  }

  const expectedCounts = expectedKindCounts(taskSet.suite);
  for (const kind of Object.keys(counts) as BenchmarkTaskKind[]) {
    if (counts[kind] !== expectedCounts[kind]) {
      errors.push(
        `${taskSet.suite} task set has ${counts[kind]} ${kind} tasks; expected ${expectedCounts[kind]}`,
      );
    }
  }
  const expectedTotal = taskSet.suite === "primary" ? PRIMARY_TASK_COUNT : STRESS_TASK_COUNT;
  if (taskSet.tasks.length !== expectedTotal) {
    errors.push(
      `${taskSet.suite} task set has ${taskSet.tasks.length} tasks; expected ${expectedTotal}`,
    );
  }
  return errors;
}

export function assertValidSyntheticTaskSet(
  taskSet: SyntheticTaskSet,
  catalog: SyntheticCatalog,
): void {
  const errors = validateSyntheticTaskSet(taskSet, catalog);
  if (errors.length > 0) throw new Error(`invalid synthetic task set: ${errors.join("; ")}`);
}
