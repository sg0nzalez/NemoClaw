// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildAgentDriverCommand,
  extractFinalAssistantOutput,
  outputContainsOracle,
} from "../../scripts/bench/tool-disclosure/drivers";

describe("tool-disclosure agent drivers", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("builds a bounded sandbox command for %s", (agent) => {
    const prompt = "Use the weather converter and return BENCH_OK_123";
    const command = buildAgentDriverCommand({
      agent,
      sandboxName: "bench-openclaw-progressive-512",
      prompt,
      sessionId: "bench-session-1",
    });
    expect(command.command).toBe("openshell");
    expect(command.args.slice(0, 5)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "bench-openclaw-progressive-512",
      "--",
    ]);
    expect(command.args.join(" ")).not.toContain(prompt);
    expect(command.redactions).toContain(prompt);
  });

  it("uses an exact oracle and rejects unsafe identifiers", () => {
    expect(outputContainsOracle("result BENCH_OK_123", "BENCH_OK_123")).toBe(true);
    expect(outputContainsOracle("result BENCH_OK_123", "BENCH_OK_456")).toBe(false);
    expect(() =>
      buildAgentDriverCommand({
        agent: "openclaw",
        sandboxName: "bad name",
        prompt: "x",
        sessionId: "one",
      }),
    ).toThrow("sandboxName contains unsupported characters");
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
});
