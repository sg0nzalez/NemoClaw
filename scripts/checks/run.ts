// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs local repository checks that are not first-class Biome rules. */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type CheckCommand = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type CheckRunner = (check: CheckCommand) => { readonly status: number | null };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = process.platform === "win32" ? "tsx.cmd" : "tsx";
const CHECKS: readonly CheckCommand[] = [
  {
    name: "direct-credential-env",
    command: TSX,
    args: [
      "scripts/checks/direct-credential-env.ts",
      "src/lib/onboard.ts",
      "src/lib/onboard/provider-key-bridge.ts",
      "src/lib/onboard/providers.ts",
    ],
  },
  {
    name: "local-credential-helper-pin",
    command: TSX,
    args: ["scripts/checks/local-credential-helper-pin.ts"],
  },
  {
    name: "no-coverage-ignore",
    command: TSX,
    args: ["scripts/checks/no-coverage-ignore.ts"],
  },
  {
    name: "openshell-policy-mutation-read",
    command: TSX,
    args: ["scripts/checks/openshell-policy-mutation-read.ts"],
  },
  {
    name: "layer-import-boundaries",
    command: TSX,
    args: ["scripts/checks/layer-import-boundaries.ts"],
  },
  {
    name: "no-test-dist-imports",
    command: TSX,
    args: ["scripts/checks/no-test-dist-imports.ts"],
  },
  {
    name: "test-create-require-budget",
    command: TSX,
    args: ["scripts/checks/test-create-require-budget.ts"],
  },
  {
    name: "vitest-project-overlap",
    command: TSX,
    args: ["scripts/checks/vitest-project-overlap.ts"],
  },
  {
    name: "test-title-style",
    command: TSX,
    args: ["scripts/checks/test-title-style.ts"],
  },
  {
    name: "extension-terminology",
    command: TSX,
    args: ["scripts/checks/extension-terminology.ts"],
    env: {
      REPOSITORY_CHECK_RUNNER: "extension-terminology",
      REPOSITORY_CHECK_SCRIPT: "scripts/checks/extension-terminology.ts",
    },
  },
  {
    name: "no-unit-blocks-in-live-e2e",
    command: TSX,
    args: ["scripts/checks/no-unit-blocks-in-live-e2e.ts"],
  },
];

export function listChecks(): readonly CheckCommand[] {
  return CHECKS.map((check) => ({
    ...check,
    args: [...check.args],
    env: check.env === undefined ? undefined : { ...check.env },
  }));
}

export function runChecks(
  runner: CheckRunner = (check) =>
    spawnSync(check.command, [...check.args], {
      cwd: REPO_ROOT,
      env: check.env === undefined ? process.env : { ...process.env, ...check.env },
      stdio: "inherit",
    }),
): number {
  for (const check of CHECKS) {
    const result = runner(check);
    if (result.status !== 0) {
      console.error(`Check failed: ${check.name}`);
      return result.status ?? 1;
    }
  }
  return 0;
}

function main(): void {
  process.exitCode = runChecks();
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  main();
}
