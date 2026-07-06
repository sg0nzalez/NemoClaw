// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { assembleToolDisclosureRun } from "../../scripts/bench/tool-disclosure/assemble-run";
import {
  canonicalJson,
  executeSyntheticTool,
  generateSyntheticCatalog,
  sha256Hex,
} from "../../scripts/bench/tool-disclosure/catalog";
import { gradeTaskRun } from "../../scripts/bench/tool-disclosure/grading";
import { writeOpenClawFixture } from "../../scripts/bench/tool-disclosure/openclaw-fixture";
import { buildToolDisclosureSchedule } from "../../scripts/bench/tool-disclosure/schedule";
import { buildPrimaryTasks } from "../../scripts/bench/tool-disclosure/tasks";
import {
  TOOL_DISCLOSURE_SCHEMA_VERSION,
  type ToolDisclosureManifest,
} from "../../scripts/bench/tool-disclosure/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.NEMOCLAW_BENCH_CALLS_PATH;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw benchmark fixture", () => {
  it("registers and executes the deterministic native tool catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bench-fixture-"));
    temporaryDirectories.push(root);
    const output = path.join(root, "fixture-16");
    const catalog = generateSyntheticCatalog({ size: 16 });
    writeOpenClawFixture({ outputDir: output, catalog, sandboxBase: "example/base@sha256:1234" });

    const registered: Array<Record<string, unknown>> = [];
    const callsPath = path.join(root, "calls.jsonl");
    process.env.NEMOCLAW_BENCH_CALLS_PATH = callsPath;
    const moduleUrl = `${pathToFileURL(path.join(output, "plugin", "index.js")).href}?test=1`;
    const plugin = (await import(moduleUrl)) as {
      default(api: { registerTool(tool: Record<string, unknown>): void }): void;
    };
    plugin.default({ registerTool: (tool) => registered.push(tool) });
    expect(registered).toHaveLength(16);

    const first = registered[0] as {
      execute(id: string, params: Record<string, unknown>): Promise<{ details: unknown }>;
    };
    const args = buildPrimaryTasks(generateSyntheticCatalog({ size: 64 }))[0].expected_calls[0]
      .arguments;
    const result = await first.execute("call-1", args);
    expect(result.details).toEqual(executeSyntheticTool(catalog.tools[0], args));
    const call = JSON.parse(fs.readFileSync(callsPath, "utf8")) as Record<string, unknown>;
    expect(call).toMatchObject({
      tool_name: catalog.tools[0].definition.function.name,
      arguments_sha256: sha256Hex(canonicalJson(args)),
      success: true,
    });

    const dockerfile = fs.readFileSync(path.join(output, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=progressive");
    expect(dockerfile).toContain("ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(output, "plugin", "openclaw.plugin.json"), "utf8"),
    ) as { contracts: { tools: string[] } };
    expect(manifest.contracts.tools).toHaveLength(16);
  });
});

describe("benchmark grading", () => {
  it("requires exact ordered calls, argument hashes, nonces, and final oracle", () => {
    const catalog = generateSyntheticCatalog({ size: 64 });
    const task = buildPrimaryTasks(catalog).find((candidate) => candidate.kind === "ordered-chain");
    if (!task) throw new Error("chain task fixture missing");
    const calls = task.expected_calls.map((call) => ({
      tool_name: call.tool_name,
      arguments_sha256: sha256Hex(canonicalJson(call.arguments)),
      result_nonce: call.result_nonce,
      success: true,
    }));
    const passing = gradeTaskRun(task, calls, task.expected_final_includes.join(" "));
    expect(passing.outcome).toBe("success");
    expect(
      gradeTaskRun(task, [...calls].reverse(), task.expected_final_includes.join(" ")),
    ).toMatchObject({ outcome: "incorrect", correctness: { expected_tool_order: false } });
  });

  it("passes a no-tool control only when no calls occur and the phrase is present", () => {
    const task = buildPrimaryTasks(generateSyntheticCatalog({ size: 64 })).find(
      (candidate) => candidate.kind === "no-tool",
    );
    if (!task) throw new Error("no-tool fixture missing");
    expect(gradeTaskRun(task, [], task.expected_final_includes[0]).outcome).toBe("success");
    expect(
      gradeTaskRun(
        task,
        [
          {
            tool_name: "unexpected",
            arguments_sha256: "0".repeat(64),
            result_nonce: null,
            success: true,
          },
        ],
        task.expected_final_includes[0],
      ).outcome,
    ).toBe("incorrect");
  });

  it("assembles a public run without retaining model output or arguments", () => {
    const catalog = generateSyntheticCatalog({ size: 64 });
    const tasks = buildPrimaryTasks(catalog);
    const task = tasks[0];
    const scheduled = buildToolDisclosureSchedule({
      primaryTaskIds: tasks.map((item) => item.id),
      stressTaskIds: Array.from({ length: 8 }, (_, index) => `stress-${index}`),
      seed: 1,
      campaigns: [1],
    }).find((run) => run.task_id === task.id && run.agent === "openclaw");
    if (!scheduled) throw new Error("scheduled fixture missing");
    const manifest = {
      schema_version: TOOL_DISCLOSURE_SCHEMA_VERSION,
      benchmark_id: "fixture-benchmark",
      campaigns: [
        {
          campaign_id: "campaign-1",
          ordinal: 1,
          fresh_inference_process: true,
          fresh_sandboxes: true,
        },
      ],
      protocol: { execution_seed: 1 },
    } as unknown as ToolDisclosureManifest;
    const expected = task.expected_calls[0];
    const record = assembleToolDisclosureRun({
      manifest,
      scheduled,
      task,
      calls: [
        {
          tool_name: expected.tool_name,
          arguments_sha256: sha256Hex(canonicalJson(expected.arguments)),
          result_nonce: expected.result_nonce,
          success: true,
        },
      ],
      recorderEvents: [
        {
          run_id: scheduled.run_id,
          request_sequence: 1,
          model_call_sequence: 1,
          endpoint: "chat-completions",
          method: "POST",
          visible_tool_count: 4,
          canonical_tools_json_bytes: 321,
          tools_sha256: "a".repeat(64),
          tool_names: [expected.tool_name],
          streaming: true,
          status_code: 200,
          started_monotonic_ms: 1,
          first_byte_monotonic_ms: 2,
          ended_monotonic_ms: 3,
          duration_ms: 2,
          time_to_first_byte_ms: 1,
          outcome: "completed",
          error_reason: null,
        },
      ],
      invocation: {
        exit_code: 0,
        timed_out: false,
        elapsed_ms: 10,
        final_output: `private output ${expected.result_nonce}`,
      },
      initialSchemaTokens: 42,
    });
    expect(record.outcome).toBe("success");
    expect(record.measurements.initial_tool_schema).toEqual({
      tool_count: 4,
      serialized_bytes: 321,
      tokenizer_tokens: 42,
    });
    expect(JSON.stringify(record)).not.toContain("private output");
    expect(JSON.stringify(record)).not.toContain(String(expected.arguments.resource_id));
  });
});
