#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
  readonly scope?: "extension-surface-commitment";
};

type WalkOptions = {
  readonly root: string;
  readonly directory: string;
  readonly onWarning?: (warning: ScanWarning) => void;
  readonly visited?: Set<string>;
};

type ScanWarning = {
  readonly file: string;
  readonly message: string;
};

type ScanOptions = {
  readonly roots?: readonly string[];
  readonly onWarning?: (warning: ScanWarning) => void;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCUMENTATION_FILE_PATTERN = /\.(?:md|mdx)$/i;
const MAX_DOCUMENTATION_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".parcel-cache",
  ".turbo",
  ".venv",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);
const EXTENSION_SURFACE_PATTERN =
  /\b(?:extension|plugins?|packages?|lifecycle contributions?|public seams?|registr(?:y|ies))\b/i;
const RULES: readonly TerminologyRule[] = [
  {
    term: "NemoClaw plugin SDK",
    pattern: /\b(?:public\s+)?NemoClaw\s+(?:(?:plugin|extension)\s+)?SDK\b/gi,
    detail: "describe any NemoClaw SDK as reserved, future, unavailable, or non-committed",
  },
  {
    term: "NemoClaw plugin registry",
    pattern: /\bNemoClaw\s+(?:plugin|extension|package)\s+registr(?:y|ies)\b/gi,
    detail: "do not present a current public NemoClaw plugin, extension, or package registry",
  },
  {
    term: "NemoClaw CLI compatibility contract",
    pattern:
      /\bNemoClaw\b[^\n.?!]{0,80}\bCLI\b[^\n.?!]{0,80}\b(?:compatibility\s+contract|stable\s+contract|compatibility\s+guarantee|compatibility\s+promise)\b/gi,
    detail: "do not present a current CLI compatibility contract for extension surfaces",
  },
  {
    term: "NemoClaw semantic-versioning promise",
    pattern:
      /\bNemoClaw\b[^\n.?!]{0,120}\b(?:semantic[-\s]+versioning|semver|SemVer)\b[^\n.?!]{0,80}\b(?:promise|guarantee|commitment|contract|stable|stability)\b/gi,
    detail: "do not present a current semantic-versioning promise for extension surfaces",
  },
  {
    term: "NemoClaw migration guarantee",
    pattern:
      /\bNemoClaw\b[^\n.?!]{0,120}\bmigration\b[^\n.?!]{0,80}\b(?:guarantee|promise|commitment|contract|stable|compatibility)\b/gi,
    detail: "do not present a current migration guarantee for extension surfaces",
  },
  {
    term: "NemoClaw compatibility commitment",
    pattern:
      /\bNemoClaw\b[^\n.?!]{0,120}\bcompatibility\b[^\n.?!]{0,80}\b(?:commitment|promise|guarantee|contract)\b/gi,
    detail: "do not present a current compatibility commitment for extension surfaces",
    /**
     * Invalid state: docs making false current compatibility commitments for extension surfaces.
     * Source boundary: human-authored docs under docs/.
     * Source fix constraint: this linter is the drift-prevention fix.
     * Regression test: "keeps compatibility commitment scoped to extension surfaces".
     * Removal condition: replace with source-specific rules or schema-generated docs.
     */
    scope: "extension-surface-commitment",
  },
];
const ALLOWED_CONTEXT_PATTERNS = [
  /\breserved\b/i,
  /\bnot\s+(?:offered|available|committed|guaranteed|promised|stable|supported)\b/i,
  /\bunavailable\b/i,
  /\bnon[-\s\u2010-\u2015]?committed\b/i,
  /\bno\s+(?:current|public|stable|supported|shipping)\b/i,
  /\bdoes\s+not\s+(?:offer|commit|guarantee|promise|provide)\b/i,
  /\bnot\s+yet\b/i,
  /\bunmet\s+gates?\b/i,
  /\bbefore\s+(?:SDK\s+)?stabili[sz]ation\b/i,
] as const;
const CURRENT_PRODUCT_PROMISE_PATTERNS = [
  /\baccepts?|accepting\b/i,
  /\b(?:available|shipping)\s+(?:now|today)\b/i,
  /\b(?:is|are|remains?|becomes?|as)\s+(?:available|supported|stable|public)\b/i,
  /\b(?:and|or)\s+(?:available|supported|stable|public)\b/i,
  /\b(?<!not\s)(?<!no\s)(?:available|supported|stable|public)\s+(?:for|to)\b/i,
  /\b(?:provides?|offers?|publishes?|makes?)\b[^\n,;]{0,80}\b(?:commitment|contract|guarantee|promise|stability|stable|supported)\b/i,
] as const;

function isSkipped(absolutePath: string): boolean {
  const segments = path.relative(REPO_ROOT, absolutePath).split(path.sep);
  return segments.some((segment) => SKIP_DIRS.has(segment));
}

function relativeFile(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

function warnFile(
  onWarning: ((warning: ScanWarning) => void) | undefined,
  absolutePath: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  onWarning?.({ file: relativeFile(absolutePath), message });
}

function warnRoot(
  onWarning: ((warning: ScanWarning) => void) | undefined,
  root: string,
  message: string,
): void {
  onWarning?.({ file: root, message });
}

function isWithinDirectory(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function* walkDocumentationFiles(options: WalkOptions): Generator<string> {
  const { directory, onWarning, root } = options;
  const visited = options.visited ?? new Set<string>();
  if (!existsSync(directory) || isSkipped(directory)) return;

  let directoryRealPath: string;
  try {
    directoryRealPath = realpathSync(directory);
  } catch (error) {
    warnFile(onWarning, directory, error);
    return;
  }
  if (visited.has(directoryRealPath)) {
    warnFile(onWarning, directory, "circular symbolic link target was already scanned");
    return;
  }
  visited.add(directoryRealPath);

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    warnFile(onWarning, directory, error);
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry);
    if (isSkipped(absolutePath)) continue;
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(absolutePath);
    } catch (error) {
      warnFile(onWarning, absolutePath, error);
      continue;
    }
    if (stats.isSymbolicLink()) {
      try {
        // This CI-only documentation linter tolerates the lstat/realpath TOCTOU window.
        const resolvedPath = realpathSync(absolutePath);
        if (!isWithinDirectory(root, resolvedPath)) {
          warnFile(onWarning, absolutePath, "symbolic link target is outside the scan root");
        } else if (visited.has(resolvedPath)) {
          warnFile(onWarning, absolutePath, "circular symbolic link target was already scanned");
        }
      } catch (error) {
        warnFile(onWarning, absolutePath, error);
      }
      continue;
    }
    if (stats.isDirectory()) {
      yield* walkDocumentationFiles({ directory: absolutePath, onWarning, root, visited });
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
  let start = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (source[cursor] === "\n" || source[cursor] === "." || source[cursor] === "!" || source[cursor] === "?") {
      start = cursor + 1;
      break;
    }
  }

  let end = source.length;
  for (let cursor = index + matchLength; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\n" || source[cursor] === "." || source[cursor] === "!" || source[cursor] === "?") {
      end = cursor;
      break;
    }
  }
  return { start, text: source.slice(start, end) };
}

function clauseContext(context: string, index: number, matchLength: number): string {
  const start = Math.max(
    context.lastIndexOf(",", index - 1),
    context.lastIndexOf(";", index - 1),
  );
  const after = index + matchLength;
  const ends = [context.indexOf(",", after), context.indexOf(";", after)].filter(
    (position) => position >= 0,
  );
  const end = ends.length === 0 ? context.length : Math.min(...ends);
  return context.slice(start + 1, end);
}

function hasCurrentProductPromise(context: string): boolean {
  return CURRENT_PRODUCT_PROMISE_PATTERNS.some((pattern) => pattern.test(context));
}

function isAllowedContext(context: string, index: number, matchLength: number): boolean {
  const clause = clauseContext(context, index, matchLength);
  return (
    ALLOWED_CONTEXT_PATTERNS.some((allowedContext) => allowedContext.test(clause)) &&
    !hasCurrentProductPromise(clause)
  );
}

function isExtensionSurfaceCommitment(context: string, index: number, matchLength: number): boolean {
  const clause = clauseContext(context, index, matchLength);
  if (/\bCLI\b[^,;]{0,40}\bcompatibility\s+contract\b/i.test(clause)) return false;
  return (
    EXTENSION_SURFACE_PATTERN.test(clause) ||
    (EXTENSION_SURFACE_PATTERN.test(context) && !/\bCLI\b/i.test(clause))
  );
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
    for (const match of source.matchAll(rule.pattern)) {
      const index = match.index ?? 0;
      const context = sentenceContext(source, index, match[0].length);
      const contextIndex = index - context.start;
      if (
        rule.scope === "extension-surface-commitment" &&
        !isExtensionSurfaceCommitment(context.text, contextIndex, match[0].length)
      ) {
        continue;
      }
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
  options: ScanOptions | readonly string[] = {},
): readonly ExtensionTerminologyViolation[] {
  const scanOptions: ScanOptions = Array.isArray(options) ? { roots: options } : options;
  const violations: ExtensionTerminologyViolation[] = [];
  for (const root of scanOptions.roots ?? ["docs"]) {
    const absoluteRoot = path.resolve(REPO_ROOT, root);
    if (!isWithinDirectory(REPO_ROOT, absoluteRoot)) {
      warnRoot(scanOptions.onWarning, root, "scan root escapes repository root");
      continue;
    }
    for (const absolutePath of walkDocumentationFiles({
      directory: absoluteRoot,
      onWarning: scanOptions.onWarning,
      root: absoluteRoot,
    })) {
      const file = relativeFile(absolutePath);
      try {
        const size = lstatSync(absolutePath).size;
        if (size > MAX_DOCUMENTATION_FILE_BYTES) {
          warnFile(scanOptions.onWarning, absolutePath, "documentation file is too large for terminology scan");
          continue;
        }
        violations.push(...findExtensionTerminologyViolations(readFileSync(absolutePath, "utf8"), file));
      } catch (error) {
        warnFile(scanOptions.onWarning, absolutePath, error);
      }
    }
  }
  return violations;
}

function main(): void {
  const violations = findRepositoryExtensionTerminologyViolations({
    onWarning: (warning) => console.warn(`${warning.file}: ${warning.message}`),
  });
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
