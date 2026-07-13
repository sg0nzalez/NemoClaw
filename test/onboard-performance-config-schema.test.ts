// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHASE_NAMES = [
  "nemoclaw.onboard.phase.preflight",
  "nemoclaw.onboard.phase.gateway",
  "nemoclaw.onboard.phase.provider_selection",
  "nemoclaw.onboard.phase.inference",
  "nemoclaw.onboard.phase.sandbox",
] as const;

const schema = JSON.parse(
  readFileSync(join(REPO_ROOT, "schemas", "onboard-config.schema.json"), "utf8"),
) as object;
const validate = new Ajv({ allErrors: true, strict: false, $data: true }).compile(schema);
const phaseBudgetsMs = Object.fromEntries(PHASE_NAMES.map((name) => [name, 1_000]));
const validConfig = {
  $comment: "Schema fixture",
  schemaVersion: 1,
  mode: "advisory",
  scope: "fixture",
  totalBudgetMs: 1_000,
  regressionWarning: { minDeltaMs: 0, minPercent: 0 },
  phaseRegressionWarning: { minDeltaMs: 0, minPercent: 0 },
  fullE2eColdPath: {
    rootStartToFirstTurnCompletionBudgetMs: 5_000,
    rootEndToFirstTurnCompletionBudgetMs: 1_000,
    phaseBudgetsMs,
  },
};

describe("onboard performance config schema", () => {
  it("accepts the checked-in config and a complete synthetic config", () => {
    const checkedIn = JSON.parse(
      readFileSync(join(REPO_ROOT, "ci", "onboard-performance-budget.json"), "utf8"),
    ) as object;
    expect(validate(checkedIn), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(validConfig), JSON.stringify(validate.errors)).toBe(true);
  });

  it("requires the cold-path config at the root", () => {
    const { fullE2eColdPath: _, ...withoutColdPath } = validConfig;
    expect(validate(withoutColdPath)).toBe(false);
  });

  it("enforces the root-end budget against the root-start budget", () => {
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: {
          ...validConfig.fullE2eColdPath,
          rootEndToFirstTurnCompletionBudgetMs: 5_001,
        },
      }),
    ).toBe(false);
  });

  it.each(PHASE_NAMES)("requires the %s budget", (phaseName) => {
    const incompletePhases = { ...phaseBudgetsMs };
    delete incompletePhases[phaseName];
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: { ...validConfig.fullE2eColdPath, phaseBudgetsMs: incompletePhases },
      }),
    ).toBe(false);
  });

  it("rejects unknown, negative, and non-schema threshold values", () => {
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: {
          ...validConfig.fullE2eColdPath,
          phaseBudgetsMs: { ...phaseBudgetsMs, "nemoclaw.onboard.phase.typo": 1 },
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: {
          ...validConfig.fullE2eColdPath,
          rootStartToFirstTurnCompletionBudgetMs: -1,
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...validConfig,
        regressionWarning: { minDeltaMs: -1, minPercent: 20 },
      }),
    ).toBe(false);
  });
});
