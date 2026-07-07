// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "vitest";

import {
  assertValidSyntheticCatalog,
  buildSyntheticArguments,
  canonicalJson,
  DEFAULT_SYNTHETIC_PERFORMANCE_TEST_CATALOG_SEED,
  executeSyntheticTool,
  generateCatalogPrefix,
  generateCatalogPrefixes,
  generateSyntheticCatalog,
  MAX_SYNTHETIC_TOOLS,
  SYNTHETIC_CATEGORIES,
  type SyntheticCatalog,
  SyntheticToolInvocationError,
  sha256Hex,
  toOpenAIFunctionTools,
  validateSyntheticArguments,
  validateSyntheticCatalog,
} from "../../scripts/performance/tool-disclosure/catalog";
import {
  assertValidSyntheticTaskSet,
  buildPrimaryTasks,
  buildStressTasks,
  generatePrimaryTaskSet,
  generateStressTaskSet,
  PRIMARY_CATALOG_MIN_SIZE,
  PRIMARY_TASK_COUNT,
  STRESS_CATALOG_SIZE,
  STRESS_TASK_COUNT,
  validateSyntheticTaskSet,
} from "../../scripts/performance/tool-disclosure/tasks";

let fullCatalog: SyntheticCatalog;

beforeAll(() => {
  fullCatalog = generateSyntheticCatalog();
});

describe("synthetic tool-disclosure catalog", () => {
  it("documents exactly 24 distinct synthetic categories", () => {
    expect(SYNTHETIC_CATEGORIES).toHaveLength(24);
    expect(new Set(SYNTHETIC_CATEGORIES.map((category) => category.id)).size).toBe(24);
    for (const category of SYNTHETIC_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.resource.length).toBeGreaterThan(0);
      expect(category.purpose.length).toBeGreaterThan(10);
      expect(category.operations).toHaveLength(6);
      expect(new Set(category.operations).size).toBe(6);
    }
  });

  it("generates 2,209 unique, safe OpenAI-style function definitions", () => {
    expect(fullCatalog.seed).toBe(DEFAULT_SYNTHETIC_PERFORMANCE_TEST_CATALOG_SEED);
    expect(fullCatalog.size).toBe(MAX_SYNTHETIC_TOOLS);
    expect(fullCatalog.tools).toHaveLength(2_209);
    expect(validateSyntheticCatalog(fullCatalog)).toEqual([]);
    expect(() => assertValidSyntheticCatalog(fullCatalog)).not.toThrow();

    const definitions = toOpenAIFunctionTools(fullCatalog);
    const names = definitions.map((definition) => definition.function.name);
    expect(definitions).toHaveLength(2_209);
    expect(new Set(names).size).toBe(2_209);
    expect(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
    expect(definitions.every((definition) => definition.type === "function")).toBe(true);
    expect(
      definitions.every(
        (definition) =>
          definition.function.description.length > 40 &&
          definition.function.parameters.type === "object" &&
          definition.function.parameters.additionalProperties === false,
      ),
    ).toBe(true);
    expect(new Set(fullCatalog.tools.map((tool) => tool.category))).toEqual(
      new Set(SYNTHETIC_CATEGORIES.map((category) => category.id)),
    );
  });

  it("uses a stable 25/50/25 schema-complexity cycle with a medium-schema median", () => {
    const counts = { small: 0, medium: 0, large: 0 };
    for (const tool of fullCatalog.tools) counts[tool.complexity] += 1;
    expect(counts).toEqual({ small: 555, medium: 1_104, large: 550 });

    const samples = [
      fullCatalog.tools.find((tool) => tool.complexity === "small"),
      fullCatalog.tools.find((tool) => tool.complexity === "medium"),
      fullCatalog.tools.find((tool) => tool.complexity === "large"),
    ];
    for (const tool of samples) {
      expect(tool).toBeDefined();
      const requiredTool = tool as NonNullable<typeof tool>;
      const args = buildSyntheticArguments(requiredTool, 17);
      expect(validateSyntheticArguments(requiredTool, args)).toEqual([]);
    }
    expect(Object.keys(samples[0]?.definition.function.parameters.properties ?? {})).toHaveLength(
      2,
    );
    expect(Object.keys(samples[1]?.definition.function.parameters.properties ?? {})).toHaveLength(
      5,
    );
    expect(Object.keys(samples[2]?.definition.function.parameters.properties ?? {})).toHaveLength(
      8,
    );
  });

  it("is deterministic, seed-sensitive, serializable, and prefix-stable", () => {
    const direct64 = generateSyntheticCatalog({ size: 64 });
    const prefix64 = generateCatalogPrefix(fullCatalog, 64);
    expect(prefix64).toEqual(direct64);
    expect(generateSyntheticCatalog({ size: 64 })).toEqual(direct64);
    expect(generateSyntheticCatalog({ size: 64, seed: 41 })).not.toEqual(direct64);

    const requested = generateCatalogPrefixes(fullCatalog, [16, 64, 256, 512, 2_209]);
    expect(requested.map((catalog) => catalog.size)).toEqual([16, 64, 256, 512, 2_209]);
    for (const catalog of requested) expect(validateSyntheticCatalog(catalog)).toEqual([]);
    expect(JSON.parse(JSON.stringify(direct64))).toEqual(direct64);
  });

  it("rejects invalid sizes, seeds, and corrupted catalog metadata", () => {
    expect(() => generateSyntheticCatalog({ size: 0 })).toThrow(/catalog size/);
    expect(() => generateSyntheticCatalog({ size: 2_210 })).toThrow(/catalog size/);
    expect(() => generateSyntheticCatalog({ seed: "" })).toThrow(/seed/);
    expect(() => generateSyntheticCatalog({ seed: -1 })).toThrow(/seed/);
    expect(() => generateCatalogPrefix(generateSyntheticCatalog({ size: 16 }), 17)).toThrow(
      /exceeds/,
    );
    expect(validateSyntheticCatalog({ ...fullCatalog, size: 2_208 })).toContain(
      "catalog size does not match tool count",
    );
    expect(validateSyntheticCatalog({ ...fullCatalog, tools_sha256: "0".repeat(64) })).toContain(
      "catalog tools_sha256 does not match tools",
    );
  });
});

describe("canonical fixture execution", () => {
  it("canonicalizes object keys and produces a stable SHA-256 digest", () => {
    const first = { z: [3, { b: true, a: null }], a: "value" };
    const second = { a: "value", z: [3, { a: null, b: true }] };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(first)).toBe('{"a":"value","z":[3,{"a":null,"b":true}]}');
    expect(sha256Hex(canonicalJson(first))).toMatch(/^[a-f0-9]{64}$/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
  });

  it("returns deterministic argument-bound nonces from every executable fixture", () => {
    for (const tool of fullCatalog.tools) {
      const args = buildSyntheticArguments(tool, tool.index % 503);
      expect(validateSyntheticArguments(tool, args)).toEqual([]);
      const result = executeSyntheticTool(tool, args);
      expect(result.ok).toBe(true);
      expect(result.tool_name).toBe(tool.definition.function.name);
      expect(result.nonce).toMatch(/^nonce_[a-f0-9]{20}$/);
    }

    const tool = fullCatalog.tools[17];
    const args = buildSyntheticArguments(tool, 8);
    const reordered = Object.fromEntries(Object.entries(args).reverse());
    expect(executeSyntheticTool(tool, reordered).nonce).toBe(
      executeSyntheticTool(tool, args).nonce,
    );
    expect(executeSyntheticTool(tool, { ...args, query: "a changed request" }).nonce).not.toBe(
      executeSyntheticTool(tool, args).nonce,
    );
  });

  it("rejects malformed handler arguments before producing a result", () => {
    const tool = fullCatalog.tools.find((candidate) => candidate.complexity === "large");
    expect(tool).toBeDefined();
    const requiredTool = tool as NonNullable<typeof tool>;
    const valid = buildSyntheticArguments(requiredTool, 3);
    expect(validateSyntheticArguments(requiredTool, { ...valid, unexpected: true })).toContain(
      "arguments.unexpected is not allowed",
    );
    expect(() => executeSyntheticTool(requiredTool, { ...valid, limit: 0 })).toThrow(
      SyntheticToolInvocationError,
    );
  });
});

describe("tool-disclosure task fixtures", () => {
  it("builds the exact 24-task primary composition with valid oracles", () => {
    const taskSet = generatePrimaryTaskSet(fullCatalog);
    expect(taskSet.task_count).toBe(PRIMARY_TASK_COUNT);
    expect(taskSet.tasks).toHaveLength(24);
    expect(validateSyntheticTaskSet(taskSet, fullCatalog)).toEqual([]);
    expect(() => assertValidSyntheticTaskSet(taskSet, fullCatalog)).not.toThrow();

    const count = (kind: string) => taskSet.tasks.filter((task) => task.kind === kind).length;
    expect(count("single-tool")).toBe(8);
    expect(count("ordered-chain")).toBe(8);
    expect(count("near-match")).toBe(4);
    expect(count("no-tool")).toBe(4);
    expect(new Set(taskSet.tasks.map((task) => task.id)).size).toBe(24);
    expect(JSON.parse(JSON.stringify(taskSet))).toEqual(taskSet);
  });

  it("makes every chain consume the first result and every distractor genuinely nearby", () => {
    const tasks = buildPrimaryTasks(fullCatalog);
    const toolsByName = new Map(
      fullCatalog.tools.map((tool) => [tool.definition.function.name, tool]),
    );

    for (const task of tasks.filter((candidate) => candidate.kind === "ordered-chain")) {
      expect(task.expected_calls).toHaveLength(2);
      expect(task.expected_calls[1].arguments.resource_id).toBe(
        task.expected_calls[0].result_nonce,
      );
      expect(task.expected_final_includes).toEqual(
        task.expected_calls.map((call) => call.result_nonce),
      );
    }
    for (const task of tasks.filter((candidate) => candidate.kind === "near-match")) {
      const target = toolsByName.get(task.expected_calls[0].tool_name);
      expect(target).toBeDefined();
      expect(task.distractor_tool_names).toHaveLength(2);
      for (const distractorName of task.distractor_tool_names) {
        const distractor = toolsByName.get(distractorName);
        expect(distractor?.category).toBe(target?.category);
        expect(distractor?.operation).not.toBe(target?.operation);
        expect(task.expected_calls.map((call) => call.tool_name)).not.toContain(distractorName);
      }
    }
    for (const task of tasks.filter((candidate) => candidate.kind === "no-tool")) {
      expect(task.expected_calls).toEqual([]);
      expect(task.expected_final_includes).toHaveLength(1);
    }
  });

  it("builds eight single-tool stress tasks distributed through the 2,209-tool catalog", () => {
    const taskSet = generateStressTaskSet(fullCatalog);
    expect(taskSet.task_count).toBe(STRESS_TASK_COUNT);
    expect(taskSet.tasks).toHaveLength(8);
    expect(taskSet.tasks.every((task) => task.kind === "single-tool")).toBe(true);
    expect(taskSet.tasks.map((task) => task.expected_calls[0].tool_name)).toEqual(
      [256, 511, 767, 1_023, 1_279, 1_535, 1_791, 2_208].map(
        (index) => fullCatalog.tools[index].definition.function.name,
      ),
    );
    expect(validateSyntheticTaskSet(taskSet, fullCatalog)).toEqual([]);
    expect(buildStressTasks(fullCatalog)).toEqual(taskSet.tasks);
  });

  it("keeps primary tasks prefix-invariant and rejects undersized task catalogs", () => {
    const prefix = generateCatalogPrefix(fullCatalog, PRIMARY_CATALOG_MIN_SIZE);
    expect(generatePrimaryTaskSet(prefix).tasks).toEqual(generatePrimaryTaskSet(fullCatalog).tasks);
    expect(() => buildPrimaryTasks(generateSyntheticCatalog({ size: 63 }))).toThrow(/at least 64/);
    expect(() => buildStressTasks(generateSyntheticCatalog({ size: 512 }))).toThrow(/require 2209/);

    const valid = generatePrimaryTaskSet(prefix);
    expect(validateSyntheticTaskSet({ ...valid, tasks_sha256: "f".repeat(64) }, prefix)).toContain(
      "tasks_sha256 does not match tasks",
    );
  });

  it("exposes fixed size constants matching the generated task requirements", () => {
    expect(PRIMARY_CATALOG_MIN_SIZE).toBe(64);
    expect(STRESS_CATALOG_SIZE).toBe(MAX_SYNTHETIC_TOOLS);
  });
});
