#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ExtensionTerminologyViolation = {
  readonly file: string;
  readonly line: number;
  readonly term: string;
  readonly detail: string;
};

type TerminologyRule = {
  readonly term: string;
  readonly pattern: RegExp;
  readonly detail: string;
  readonly include?: (context: string) => boolean;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SCAN_ROOTS = Object.freeze(["docs"]);
const DOCUMENTATION_FILE_PATTERN = /\.(?:md|mdx)$/i;
const SKIP_DIRS = new Set([".git", ".venv", "coverage", "dist", "node_modules"]);
const EXTENSION_SURFACE_PATTERN =
  /\b(?:extension|plugins?|packages?|lifecycle contributions?|public seams?|registr(?:y|ies))\b/i;
const RULES: readonly TerminologyRule[] = [
  {
    term: "NemoClaw plugin SDK",
    pattern: /\b(?:public\s+)?NemoClaw\s+(?:(?:plugin|extension)\s+)?SDK\b/i,
    detail: "describe any NemoClaw SDK as reserved, future, unavailable, or non-committed",
  },
  {
    term: "NemoClaw plugin registry",
    pattern: /\bNemoClaw\s+(?:plugin|extension|package)\s+registr(?:y|ies)\b/i,
    detail: "do not present a current public NemoClaw plugin, extension, or package registry",
  },
  {
    term: "NemoClaw CLI compatibility contract",
    pattern:
      /\bNemoClaw\b[^\n.?!]{0,80}\bCLI\b[^\n.?!]{0,80}\b(?:compatibility\s+contract|stable\s+contract|compatibility\s+guarantee|compatibility\s+promise)\b/i,
    detail: "do not present a current CLI compatibility contract for extension surfaces",
  },
  {
    term: "NemoClaw semantic-versioning promise",
    pattern:
      /\bNemoClaw\b[^\n.?!]{0,120}\b(?:semantic[-\s]+versioning|semver|SemVer)\b[^\n.?!]{0,80}\b(?:promise|guarantee|commitment|contract|stable|stability)\b/i,
    detail: "do not present a current semantic-versioning promise for extension surfaces",
  },
  {
    term: "NemoClaw migration guarantee",
    pattern:
      /\bNemoClaw\b[^\n.?!]{0,120}\bmigration\b[^\n.?!]{0,80}\b(?:guarantee|promise|commitment|contract|stable|compatibility)\b/i,
    detail: "do not present a current migration guarantee for extension surfaces",
  },
  {
    term: "NemoClaw compatibility commitment",
    pattern:
      /\bNemoClaw\b[^\n.?!]{0,120}\bcompatibility\b[^\n.?!]{0,80}\b(?:commitment|promise|guarantee|contract)\b/i,
    detail: "do not present a current compatibility commitment for extension surfaces",
    include: (context) => EXTENSION_SURFACE_PATTERN.test(context) && !/\bCLI\b/i.test(context),
  },
];
const ALLOWED_CONTEXT_PATTERN =
  /(?:^|[^\w])(?:reserved|future|not\s+(?:offered|available|committed|guaranteed|promised|stable|supported)|unavailable|non[-\s]?committed|no\s+(?:current|public|stable|supported|shipping)|does\s+not\s+(?:offer|commit|guarantee|promise|provide)|not\s+yet|unmet\s+gates?|candidate|proposed|before\s+(?:SDK\s+)?stabili[sz]ation)(?:$|[^\w])/i;

function isSkipped(absolutePath: string): boolean {
  const segments = path.relative(REPO_ROOT, absolutePath).split(path.sep);
  return segments.some((segment) => SKIP_DIRS.has(segment));
}

function* walkDocumentationFiles(directory: string): Generator<string> {
  if (!existsSync(directory) || isSkipped(directory)) return;

  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    if (isSkipped(absolutePath)) continue;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      yield* walkDocumentationFiles(absolutePath);
    } else if (stats.isFile() && DOCUMENTATION_FILE_PATTERN.test(entry)) {
      yield absolutePath;
    }
  }
}

function sentenceContext(
  source: string,
  index: number,
  matchLength: number,
): { readonly text: string; readonly start: number } {
  const start = Math.max(
    source.lastIndexOf("\n", index - 1),
    source.lastIndexOf(".", index - 1),
    source.lastIndexOf("!", index - 1),
    source.lastIndexOf("?", index - 1),
  );
  const after = index + matchLength;
  const ends = [
    source.indexOf("\n", after),
    source.indexOf(".", after),
    source.indexOf("!", after),
    source.indexOf("?", after),
  ].filter((position) => position >= 0);
  const end = ends.length === 0 ? source.length : Math.min(...ends);
  return { start: start + 1, text: source.slice(start + 1, end) };
}

function clauseContext(context: string, index: number, matchLength: number): string {
  const start = Math.max(context.lastIndexOf(",", index - 1), context.lastIndexOf(";", index - 1));
  const after = index + matchLength;
  const ends = [context.indexOf(",", after), context.indexOf(";", after)].filter(
    (position) => position >= 0,
  );
  const end = ends.length === 0 ? context.length : Math.min(...ends);
  return context.slice(start + 1, end);
}

function isAllowedContext(context: string, index: number, matchLength: number): boolean {
  return ALLOWED_CONTEXT_PATTERN.test(clauseContext(context, index, matchLength));
}

function lineForIndex(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

export function findExtensionTerminologyViolations(
  source: string,
  file: string,
): readonly ExtensionTerminologyViolation[] {
  const violations: ExtensionTerminologyViolation[] = [];

  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace("g", "")}g`);
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      const context = sentenceContext(source, index, match[0].length);
      const contextIndex = index - context.start;
      if (rule.include !== undefined && !rule.include(context.text)) continue;
      if (isAllowedContext(context.text, contextIndex, match[0].length)) continue;
      violations.push({
        file,
        line: lineForIndex(source, index),
        term: rule.term,
        detail: rule.detail,
      });
    }
  }

  return violations;
}

export function findRepositoryExtensionTerminologyViolations(
  roots: readonly string[] = DEFAULT_SCAN_ROOTS,
): readonly ExtensionTerminologyViolation[] {
  const violations: ExtensionTerminologyViolation[] = [];
  for (const root of roots) {
    const absoluteRoot = path.resolve(REPO_ROOT, root);
    for (const absolutePath of walkDocumentationFiles(absoluteRoot)) {
      const file = path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
      violations.push(...findExtensionTerminologyViolations(readFileSync(absolutePath, "utf8"), file));
    }
  }
  return violations;
}

function main(): void {
  const violations = findRepositoryExtensionTerminologyViolations();
  if (violations.length === 0) {
    console.log("Extension terminology check passed.");
    return;
  }

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} [${violation.term}] ${violation.detail}`);
  }
  console.error(`Found ${violations.length} extension terminology violation(s).`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  main();
}
