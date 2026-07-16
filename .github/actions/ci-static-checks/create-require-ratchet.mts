// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Enforce the createRequire allowlist ratchet from the base-trusted CI action.
 *
 * Pull requests execute this file from the action checked out at the immutable
 * base SHA. The comparison therefore cannot be weakened by changing the PR's
 * scripts/checks implementation or returning early from its local check.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type TrustedCreateRequireAllowlists = Readonly<{
  cli: readonly string[];
  testSupport: readonly string[];
}>;

const ALLOWLIST_PATHS = [
  "scripts/checks/test-create-require-budget.mts",
  "scripts/checks/test-create-require-budget.ts",
] as const;

const ALLOWLIST_EXPORTS = {
  CLI_CREATE_REQUIRE_FILES: "cli",
  TEST_SUPPORT_CREATE_REQUIRE_FILES: "testSupport",
} as const;

function arrayLiteral(initializer: ts.Expression | undefined): ts.ArrayLiteralExpression | null {
  let expression = initializer;
  while (
    expression &&
    (ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isParenthesizedExpression(expression))
  ) {
    expression = expression.expression;
  }
  return expression && ts.isArrayLiteralExpression(expression) ? expression : null;
}

export function extractTrustedCreateRequireAllowlists(
  sourceText: string,
  fileName: string = ALLOWLIST_PATHS[0],
): TrustedCreateRequireAllowlists {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const values: Partial<Record<keyof TrustedCreateRequireAllowlists, string[]>> = {};

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const target = ALLOWLIST_EXPORTS[declaration.name.text as keyof typeof ALLOWLIST_EXPORTS];
      if (!target) continue;
      const array = arrayLiteral(declaration.initializer);
      if (!array || array.elements.some((element) => !ts.isStringLiteralLike(element))) {
        throw new Error(`${declaration.name.text} must be a literal string array`);
      }
      if (values[target]) throw new Error(`${declaration.name.text} must be declared exactly once`);
      values[target] = array.elements.map((element) => (element as ts.StringLiteralLike).text);
    }
  }

  if (!values.cli || !values.testSupport) {
    throw new Error("createRequire allowlist source must declare both reviewed allowlists");
  }
  return { cli: values.cli, testSupport: values.testSupport };
}

export function trustedCreateRequireExpansionFailure(
  current: TrustedCreateRequireAllowlists,
  baseline: TrustedCreateRequireAllowlists,
): string | null {
  const cliAdditions = current.cli.filter((file) => !baseline.cli.includes(file)).sort();
  const supportAdditions = current.testSupport
    .filter((file) => !baseline.testSupport.includes(file))
    .sort();
  if (cliAdditions.length === 0 && supportAdditions.length === 0) return null;

  return [
    "createRequire allowlists must not expand relative to the merge base.",
    ...cliAdditions.map((file) => `- CLI_CREATE_REQUIRE_FILES: ${file}`),
    ...supportAdditions.map((file) => `- TEST_SUPPORT_CREATE_REQUIRE_FILES: ${file}`),
  ].join("\n");
}

function resolveMergeBase(repoRoot: string): string | null {
  const baseBranch = process.env.GITHUB_BASE_REF?.trim();
  const baseRef = baseBranch ? `origin/${baseBranch}` : "origin/main";
  const mergeBase = spawnSync("git", ["merge-base", "HEAD", baseRef], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    if (baseBranch) {
      throw new Error(`could not resolve the pull-request merge base against ${baseRef}`);
    }
    return null;
  }
  return mergeBase.stdout.trim();
}

function currentAllowlistSource(repoRoot: string): { path: string; source: string } {
  for (const relativePath of ALLOWLIST_PATHS) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (existsSync(absolutePath)) {
      return { path: relativePath, source: readFileSync(absolutePath, "utf8") };
    }
  }
  throw new Error("current checkout does not contain the createRequire budget check");
}

function baselineAllowlistSource(
  repoRoot: string,
  revision: string,
): { path: string; source: string } {
  for (const relativePath of ALLOWLIST_PATHS) {
    const result = spawnSync("git", ["show", `${revision}:${relativePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status === 0) return { path: relativePath, source: result.stdout };
  }
  throw new Error(`merge base ${revision} does not contain the createRequire budget check`);
}

export function verifyTrustedCreateRequireRatchet(repoRoot: string): string | null {
  const revision = resolveMergeBase(repoRoot);
  if (!revision) return null;
  const current = currentAllowlistSource(repoRoot);
  const baseline = baselineAllowlistSource(repoRoot, revision);
  return trustedCreateRequireExpansionFailure(
    extractTrustedCreateRequireAllowlists(current.source, current.path),
    extractTrustedCreateRequireAllowlists(baseline.source, baseline.path),
  );
}

function main(): void {
  const repoRoot = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const failure = verifyTrustedCreateRequireRatchet(repoRoot);
  if (failure) {
    console.error(failure);
    process.exitCode = 1;
    return;
  }
  console.log("Base-trusted createRequire allowlist ratchet passed.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
