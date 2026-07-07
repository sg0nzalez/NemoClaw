// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildAgentDriverCommand,
  extractFinalAssistantOutput,
  outputContainsOracle,
} from "../../scripts/performance/tool-disclosure/drivers";

describe("tool-disclosure agent drivers", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("builds a bounded sandbox command for %s", (agent) => {
    const prompt = "Use the weather converter,\nthen return PERFORMANCE_TEST_OK_123";
    const command = buildAgentDriverCommand({
      agent,
      sandboxName: "performance-test-openclaw-progressive-512",
      prompt,
      sessionId: "performance-test-session-1",
    });
    expect(command.command).toBe("openshell");
    expect(command.args.slice(0, 5)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "performance-test-openclaw-progressive-512",
      "--",
    ]);
    expect(command.args.join(" ")).not.toContain(prompt);
    expect(command.args.every((argument) => !/[\r\n]/u.test(argument))).toBe(true);
    expect(command.redactions).toContain(prompt);
  });

  it("uses an exact oracle and rejects unsafe identifiers", () => {
    expect(outputContainsOracle("result PERFORMANCE_TEST_OK_123", "PERFORMANCE_TEST_OK_123")).toBe(
      true,
    );
    expect(outputContainsOracle("result PERFORMANCE_TEST_OK_123", "PERFORMANCE_TEST_OK_456")).toBe(
      false,
    );
    expect(() =>
      buildAgentDriverCommand({
        agent: "openclaw",
        sandboxName: "bad name",
        prompt: "x",
        sessionId: "one",
      }),
    ).toThrow("sandboxName contains unsupported characters");
  });

  it.skipIf(process.platform === "win32")("emits POSIX-valid driver scripts", () => {
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"] as const) {
      const command = buildAgentDriverCommand({
        agent,
        sandboxName: "performance-test-syntax",
        prompt: "Return PERFORMANCE_TEST_OK_123",
        sessionId: "performance-test-session-syntax",
      });
      const syntax = spawnSync("sh", ["-n"], {
        encoding: "utf8",
        input: command.args.at(-1),
      });
      expect(syntax.status, syntax.stderr).toBe(0);
    }
  });

  it("streams the decoded Hermes payload directly to curl", () => {
    const command = buildAgentDriverCommand({
      agent: "hermes",
      sandboxName: "performance-test-hermes-stream",
      prompt: "Return PERFORMANCE_TEST_OK_123",
      sessionId: "performance-test-session-hermes-stream",
    });
    const script = command.args.at(-1) ?? "";
    expect(script).toContain("base64 -d | curl");
    expect(script).toContain("--data-binary @-");
    expect(script).not.toContain("payload=$(printf");
  });

  it("extracts assistant replies without accepting tool-result fields", () => {
    expect(
      extractFinalAssistantOutput(
        "openclaw",
        JSON.stringify({
          result: { payloads: [{ text: "FINAL_NONCE" }] },
          tool_result: { text: "TOOL_ONLY_NONCE" },
        }),
      ),
    ).toBe("FINAL_NONCE");
    expect(
      extractFinalAssistantOutput(
        "hermes",
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "FINAL_NONCE" } }],
          tool_result: "TOOL_ONLY_NONCE",
        }),
      ),
    ).toBe("FINAL_NONCE");
  });

  it("extracts the Deep Agents final block before trailing task status", () => {
    const output = [
      "Running task non-interactively...",
      "App: v0.1.30 | Agent: agent (default) | Model: example/model | Thread: thread-1",
      "Starting LangGraph server...",
      "✓ Loaded 1 MCP tool",
      "✓ Server ready",
      "🔧 Calling tool: search_tools (trace: TOOL_ONLY_NONCE)",
      "🔧 Calling tool: performance_test_echo",
      "Operation complete.",
      "FINAL_NONCE",
      "",
      "✓ Task completed",
      "",
      "Agent active  1.3s",
    ].join("\n");

    expect(extractFinalAssistantOutput("langchain-deepagents-code", output)).toBe(
      "Operation complete.\nFINAL_NONCE",
    );
    expect(
      extractFinalAssistantOutput(
        "langchain-deepagents-code",
        "✓ Server ready\n🔧 Calling tool: performance_test_echo (result: TOOL_ONLY_NONCE)\n✓ Task completed\nAgent active  1.3s",
      ),
    ).toBe("");
  });
});
