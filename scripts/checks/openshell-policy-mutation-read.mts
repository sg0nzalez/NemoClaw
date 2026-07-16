// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prevent provider-composed OpenShell policy entries from entering mutation
 * paths.
 *
 * invalidState: a refactor introduces an unclassified policy read or changes a
 * mutation to consume provider-composed `--full` output.
 * sourceBoundary: typed command builders own argv construction; this audit owns
 * exhaustive discovery and classification of their production call sites.
 * whyNotSourceFix: TypeScript cannot distinguish a command array after it
 * crosses the process runner, so this defense-in-depth check intentionally uses
 * deterministic source patterns plus repository-wide read-site discovery.
 * regressionTest: test/policy-mutation-read-discovery.test.ts injects
 * unaccounted reads and requires this audit to fail.
 * removalCondition: replace the source-pattern table when mutation and
 * diagnostic commands carry enforced tagged types through the runner boundary.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface AuditedMutationRead {
  readonly relativePath: string;
  readonly expectedReadCalls: number;
  readonly baseCommand: string;
  readonly unsafeBaseCommand?: string;
  readonly fullCommand: string;
  readonly diagnosticFullRead?: string;
}

export const MUTATION_READS: readonly AuditedMutationRead[] = [
  {
    relativePath: "src/lib/actions/sandbox/policy-get.ts",
    expectedReadCalls: 1,
    baseCommand: "runCapture(buildPolicyGetCommand(sandboxName))",
    fullCommand: "runCapture(buildPolicyGetFullCommand(sandboxName))",
  },
  {
    relativePath: "src/lib/policy/index.ts",
    expectedReadCalls: 6,
    baseCommand: "runCapture(buildPolicyGetCommand(sandboxName))",
    unsafeBaseCommand: "runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true })",
    fullCommand: "runCapture(buildPolicyGetFullCommand(sandboxName), { ignoreError: true })",
    diagnosticFullRead: "runCapture(buildPolicyGetFullCommand(sandboxName), { ignoreError: true })",
  },
  {
    relativePath: "nemoclaw/src/blueprint/runner.ts",
    expectedReadCalls: 1,
    baseCommand: '["openshell", "policy", "get", "--base", sandboxName]',
    fullCommand: '["openshell", "policy", "get", "--full", sandboxName]',
  },
  {
    relativePath: "src/lib/shields/index.ts",
    expectedReadCalls: 1,
    baseCommand: "runCapture(buildPolicyGetCommand(sandboxName))",
    unsafeBaseCommand: "runCapture(buildPolicyGetCommand(sandboxName), {",
    fullCommand: "runCapture(buildPolicyGetFullCommand(sandboxName))",
  },
];

const NON_MUTATION_POLICY_READS = [
  {
    relativePath: "src/lib/actions/sandbox/gateway-state.ts",
    expectedReadCalls: 2,
  },
  {
    relativePath: "src/lib/policy/commands.ts",
    expectedReadCalls: 2,
  },
] as const;

export interface DiscoveredPolicyReadSite {
  readonly relativePath: string;
  readonly readCalls: number;
}

const POLICY_GET_BUILDERS = new Set(["buildPolicyGetCommand", "buildPolicyGetFullCommand"]);

function calledName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function literalText(expression: ts.Expression): string | null {
  return ts.isStringLiteralLike(expression) ? expression.text : null;
}

function isDirectPolicyRead(expression: ts.ArrayLiteralExpression): boolean {
  const first = expression.elements[0];
  if (!first || !ts.isExpression(first)) return false;
  const firstText = literalText(first);
  const offset =
    firstText === "policy"
      ? 0
      : firstText === "openshell" ||
          (ts.isCallExpression(first) && calledName(first.expression) === "resolveOpenshellBinary")
        ? 1
        : -1;
  if (offset < 0) return false;
  const values = expression.elements.map((element) =>
    ts.isExpression(element) ? literalText(element) : null,
  );
  return (
    values[offset] === "policy" &&
    values[offset + 1] === "get" &&
    (values[offset + 2] === "--base" || values[offset + 2] === "--full")
  );
}

export function countPolicyReadCalls(source: string, fileName: string): number {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let readCalls = 0;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && POLICY_GET_BUILDERS.has(calledName(node.expression) ?? "")) {
      readCalls += 1;
    } else if (ts.isArrayLiteralExpression(node) && isDirectPolicyRead(node)) {
      readCalls += 1;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return readCalls;
}

function productionTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(entryPath);
    if (
      !entry.isFile() ||
      !/\.[cm]?ts$/u.test(entry.name) ||
      /\.(?:test|spec)\.[cm]?ts$/u.test(entry.name)
    ) {
      return [];
    }
    return [entryPath];
  });
}

export function discoverPolicyReadSites(repoRoot: string): DiscoveredPolicyReadSite[] {
  return ["src", "nemoclaw/src"]
    .flatMap((sourceRoot) => productionTypeScriptFiles(path.join(repoRoot, sourceRoot)))
    .flatMap((sourcePath) => {
      const source = readFileSync(sourcePath, "utf8");
      const readCalls = countPolicyReadCalls(source, sourcePath);
      return readCalls > 0
        ? [
            {
              relativePath: path.relative(repoRoot, sourcePath).split(path.sep).join("/"),
              readCalls,
            },
          ]
        : [];
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function auditOpenShellPolicyMutationReads(repoRoot = REPO_ROOT): string[] {
  const violations: string[] = [];
  for (const {
    relativePath,
    baseCommand,
    unsafeBaseCommand,
    fullCommand,
    diagnosticFullRead,
  } of MUTATION_READS) {
    const sourcePath = path.join(repoRoot, relativePath);
    if (!existsSync(sourcePath)) {
      violations.push(`${relativePath}: audited policy read source is missing`);
      continue;
    }
    const source = readFileSync(sourcePath, "utf8");
    if (!source.includes(baseCommand)) {
      violations.push(`${relativePath}: expected the audited policy mutation read to use --base`);
    }
    if (unsafeBaseCommand && source.includes(unsafeBaseCommand)) {
      violations.push(`${relativePath}: policy mutation reads must preserve command failures`);
    }
    if (!diagnosticFullRead && source.includes(fullCommand)) {
      violations.push(`${relativePath}: audited policy mutation read must never use --full output`);
    }
    if (diagnosticFullRead) {
      const diagnosticReads = source.split(diagnosticFullRead).length - 1;
      if (!source.includes(fullCommand) || diagnosticReads === 0) {
        violations.push(`${relativePath}: expected the audited diagnostic read to use --full`);
      }
      if (diagnosticReads !== 1) {
        violations.push(
          `${relativePath}: --full policy reads must remain isolated to the diagnostic path`,
        );
      }
    }
  }

  const discoveredReads = new Map(
    discoverPolicyReadSites(repoRoot).map((site) => [site.relativePath, site.readCalls]),
  );
  const auditedReads = [...MUTATION_READS, ...NON_MUTATION_POLICY_READS];
  for (const { relativePath, expectedReadCalls } of auditedReads) {
    const discoveredCount = discoveredReads.get(relativePath) ?? 0;
    if (discoveredCount !== expectedReadCalls) {
      violations.push(
        `${relativePath}: expected ${expectedReadCalls} audited policy read call(s), found ${discoveredCount}`,
      );
    }
    discoveredReads.delete(relativePath);
  }
  for (const [relativePath, readCalls] of discoveredReads) {
    violations.push(
      `${relativePath}: found ${readCalls} unaccounted policy read call(s); classify every read before merge`,
    );
  }

  return violations;
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const violations = auditOpenShellPolicyMutationReads();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }

  console.log(
    "OpenShell policy mutations use --base; read-only diagnostics isolate --full output.",
  );
}
