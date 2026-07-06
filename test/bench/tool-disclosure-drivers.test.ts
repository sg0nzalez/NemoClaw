// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

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

  it.skipIf(process.platform === "win32")("emits POSIX-valid driver scripts", () => {
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"] as const) {
      const command = buildAgentDriverCommand({
        agent,
        sandboxName: "bench-syntax",
        prompt: "Return BENCH_OK_123",
        sessionId: "bench-session-syntax",
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
      sandboxName: "bench-hermes-stream",
      prompt: "Return BENCH_OK_123",
      sessionId: "bench-session-hermes-stream",
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
});
