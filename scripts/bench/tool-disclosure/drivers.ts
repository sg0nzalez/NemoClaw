// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import type { ToolDisclosureAgent } from "./schedule";

export interface AgentDriverCommand {
  command: string;
  args: string[];
  redactions: string[];
}

export const OPENCLAW_BENCH_CALLS_PATH = "/sandbox/.nemoclaw-benchmark/calls.jsonl";

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function shellScriptFor(agent: ToolDisclosureAgent, prompt: string, sessionId: string): string {
  const encodedPrompt = base64(prompt);
  if (agent === "openclaw") {
    return [
      "set -eu",
      `prompt=$(printf '%s' '${encodedPrompt}' | base64 -d)`,
      `exec openclaw agent --agent main --json --thinking off --session-id '${sessionId}' -m "$prompt"`,
    ].join("\n");
  }
  if (agent === "langchain-deepagents-code") {
    return [
      "set -eu",
      `prompt=$(printf '%s' '${encodedPrompt}' | base64 -d)`,
      'exec nemoclaw-start dcode -n "$prompt"',
    ].join("\n");
  }
  const payload = base64(
    JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512,
      temperature: 0,
      stream: false,
    }),
  );
  return [
    "set -eu",
    "set -a",
    "[ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env",
    "set +a",
    `payload=$(printf '%s' '${payload}' | base64 -d)`,
    'if [ -n "${API_SERVER_KEY:-}" ]; then',
    '  exec curl -fsS --max-time 600 http://127.0.0.1:8642/v1/chat/completions -H \'Content-Type: application/json\' -H "Authorization: Bearer ${API_SERVER_KEY}" --data-binary "$payload"',
    "fi",
    "exec curl -fsS --max-time 600 http://127.0.0.1:8642/v1/chat/completions -H 'Content-Type: application/json' --data-binary \"$payload\"",
  ].join("\n");
}

export function buildAgentDriverCommand(options: {
  openshellBin?: string;
  sandboxName: string;
  agent: ToolDisclosureAgent;
  prompt: string;
  sessionId: string;
}): AgentDriverCommand {
  validateIdentifier(options.sandboxName, "sandboxName");
  validateIdentifier(options.sessionId, "sessionId");
  if (!options.prompt.trim()) throw new Error("benchmark task prompt must not be empty");
  const script = shellScriptFor(options.agent, options.prompt, options.sessionId);
  return {
    command: options.openshellBin ?? "openshell",
    args: ["sandbox", "exec", "-n", options.sandboxName, "--", "sh", "-lc", script],
    redactions: [
      options.prompt,
      base64(options.prompt),
      base64(
        JSON.stringify({
          messages: [{ role: "user", content: options.prompt }],
          max_tokens: 512,
          temperature: 0,
          stream: false,
        }),
      ),
    ],
  };
}

export function outputContainsOracle(output: string, oracle: string): boolean {
  return oracle.length > 0 && output.includes(oracle);
}

function jsonDocuments(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw.split(/\r?\n/u).flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extract only the user-visible final assistant field, never raw tool traces. */
export function extractFinalAssistantOutput(agent: ToolDisclosureAgent, raw: string): string {
  if (agent === "hermes") {
    const root = record(jsonDocuments(raw)[0]);
    const choice = Array.isArray(root?.choices) ? record(root.choices[0]) : null;
    const message = record(choice?.message);
    return typeof message?.content === "string" ? message.content : "";
  }
  if (agent === "openclaw") {
    const parts: string[] = [];
    for (const document of jsonDocuments(raw)) {
      const root = record(document);
      const result = record(root?.result);
      const payloads = Array.isArray(result?.payloads)
        ? result.payloads
        : Array.isArray(root?.payloads)
          ? root.payloads
          : [];
      for (const payload of payloads) {
        const text = record(payload)?.text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return (
    raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

export function buildOpenClawCallLogCommand(options: {
  openshellBin?: string;
  sandboxName: string;
  action: "read" | "reset";
}): AgentDriverCommand {
  validateIdentifier(options.sandboxName, "sandboxName");
  const script =
    options.action === "reset"
      ? `rm -f -- '${OPENCLAW_BENCH_CALLS_PATH}'`
      : `[ ! -f '${OPENCLAW_BENCH_CALLS_PATH}' ] || cat -- '${OPENCLAW_BENCH_CALLS_PATH}'`;
  return {
    command: options.openshellBin ?? "openshell",
    args: ["sandbox", "exec", "-n", options.sandboxName, "--", "sh", "-lc", script],
    redactions: [],
  };
}
