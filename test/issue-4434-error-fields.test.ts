// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const DEPENDENCY_REVIEW = path.join(
  REPO_ROOT,
  "docs/security/openclaw-2026.6.9-dependency-review.md",
);

const CURRENT_REVIEWED_OPENCLAW_VERSION = "2026.6.9";
const REVIEWED_OPENCLAW_2026_6_9_ISSUE_4434_TUI_ERROR_OUTPUT = [
  "run error",
  "TypeError: fetch failed",
  "1m 04s | error",
].join("\n");

const FUTURE_COMPLETE_ISSUE_4434_TUI_ERROR_OUTPUT = [
  "run error: HTTP 503 from upstream API",
  "reported by gateway proxy",
  "recovery hint: check egress policy and retry",
  "1m 04s | error",
].join("\n");

const ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS = [
  {
    name: "httpStatusOrCause",
    pattern: /\b(?:HTTP\s+\d{3}|status(?:\s+code)?\s*[:=]\s*\d{3}|cause\s*[:=]\s*\S+)/i,
  },
  {
    name: "reportingLayer",
    pattern: /\b(?:gateway proxy|gateway layer|reported by gateway|upstream API|from upstream)\b/i,
  },
  {
    name: "recoveryHint",
    pattern: /\b(?:recovery hint|hint\s*[:=]|check (?:egress|network|provider)|retry)\b/i,
  },
] as const;

type Issue4434AcceptanceField = (typeof ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS)[number]["name"];

function readDockerfileOpenClawVersion(): string {
  return fs.readFileSync(DOCKERFILE, "utf-8").match(/^ARG OPENCLAW_VERSION=([^\s]+)/m)?.[1] ?? "";
}

function detectIssue4434AcceptanceFields(
  output: string,
): Record<Issue4434AcceptanceField, boolean> {
  return Object.fromEntries(
    ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS.map(({ name, pattern }) => [name, pattern.test(output)]),
  ) as Record<Issue4434AcceptanceField, boolean>;
}

function missingIssue4434AcceptanceFields(output: string): Issue4434AcceptanceField[] {
  const present = detectIssue4434AcceptanceFields(output);
  return ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS.map(({ name }) => name).filter(
    (name) => !present[name],
  );
}

describe("issue #4434 partial OpenClaw TUI error guard", () => {
  it("detects when upstream output grows the missing full-acceptance fields", () => {
    expect(readDockerfileOpenClawVersion()).toBe(CURRENT_REVIEWED_OPENCLAW_VERSION);
    expect(
      detectIssue4434AcceptanceFields(REVIEWED_OPENCLAW_2026_6_9_ISSUE_4434_TUI_ERROR_OUTPUT),
    ).toEqual({
      httpStatusOrCause: false,
      reportingLayer: false,
      recoveryHint: false,
    });
    expect(missingIssue4434AcceptanceFields(FUTURE_COMPLETE_ISSUE_4434_TUI_ERROR_OUTPUT)).toEqual(
      [],
    );
  });

  it("keeps the dependency review tied to the detector and tightening condition", () => {
    const review = fs.readFileSync(DEPENDENCY_REVIEW, "utf-8");
    expect(review).toContain("test/issue-4434-error-fields.test.ts");
    expect(review).toContain(
      "Tighten both `test/e2e/test-issue-4434-tui-unreachable-inference.sh`",
    );
  });
});
