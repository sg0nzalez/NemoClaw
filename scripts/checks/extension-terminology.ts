// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
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

export type ScanWarning = {
  readonly file: string;
  readonly message: string;
};

export type RepositoryScanResult = {
  readonly violations: readonly ExtensionTerminologyViolation[];
  readonly warnings: readonly ScanWarning[];
};

type ScanOptions = {
  readonly roots?: readonly string[];
  readonly onWarning?: (warning: ScanWarning) => void;
};

const CHECK_RUNNER_ENV = "NEMOCLAW_CHECK_RUNNER";
const CHECK_RUNNER_VALUE = "extension-terminology";
const CHECK_RUNNER_CONTRACT_WARNING =
  "extension-terminology: repository terminology scan only runs through the repository check runner";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCUMENTATION_FILE_PATTERN = /\.(?:md|mdx)$/i;
const MAX_DOCUMENTATION_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set([
  ".cache",
  ".eslintcache",
  ".git",
  ".next",
  ".parcel-cache",
  ".rspack",
  ".stylelintcache",
  ".swc",
  ".turbo",
  ".venv",
  ".vercel",
  ".webpack",
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

function isRootList(options: ScanOptions | readonly string[]): options is readonly string[] {
  return Array.isArray(options);
}

function readCheckedDocumentationFile(absolutePath: string): string | null {
  const descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("documentation path is not a regular file");
    if (stats.size > MAX_DOCUMENTATION_FILE_BYTES) return null;
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
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
        /**
         * Invalid state: symlink races could change targets between lstat and realpath.
         * Source boundary: trusted repository documentation check runs.
         * Source fix constraint: fd-based no-follow traversal is not portable in Node here.
         * Regression test: "does not follow symlinks outside scanned documentation roots".
         * Removal condition: replace before reusing this scanner for untrusted repositories.
         */
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

/**
 * @internal Accidental direct-run guard for the repository check-runner contract.
 */
function assertCheckRunnerContract(onWarning: ((warning: ScanWarning) => void) | undefined): void {
  if (process.env[CHECK_RUNNER_ENV] === CHECK_RUNNER_VALUE) return;
  warnRoot(onWarning, "<environment>", CHECK_RUNNER_CONTRACT_WARNING);
  throw new Error(CHECK_RUNNER_CONTRACT_WARNING);
}

export function scanRepositoryExtensionTerminology(
  options: ScanOptions | readonly string[] = {},
): RepositoryScanResult {
  const scanOptions: ScanOptions = isRootList(options) ? { roots: options } : options;
  const warnings: ScanWarning[] = [];
  const onWarning = (warning: ScanWarning): void => {
    warnings.push(warning);
    scanOptions.onWarning?.(warning);
  };
  assertCheckRunnerContract(onWarning);
  const violations: ExtensionTerminologyViolation[] = [];
  for (const root of scanOptions.roots ?? ["docs"]) {
    const absoluteRoot = path.resolve(REPO_ROOT, root);
    if (!isWithinDirectory(REPO_ROOT, absoluteRoot)) {
      warnRoot(onWarning, root, "scan root escapes repository root");
      continue;
    }
    let realRoot: string;
    try {
      realRoot = realpathSync(absoluteRoot);
    } catch (error) {
      warnRoot(onWarning, root, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!isWithinDirectory(REPO_ROOT, realRoot)) {
      warnRoot(onWarning, root, "scan root realpath escapes repository root");
      continue;
    }
    for (const absolutePath of walkDocumentationFiles({
      directory: absoluteRoot,
      onWarning,
      root: realRoot,
    })) {
      const file = relativeFile(absolutePath);
      try {
        const source = readCheckedDocumentationFile(absolutePath);
        if (source === null) {
          warnFile(onWarning, absolutePath, "documentation file is too large for terminology scan");
          continue;
        }
        violations.push(...findExtensionTerminologyViolations(source, file));
      } catch (error) {
        warnFile(onWarning, absolutePath, error);
      }
    }
  }
  return { violations, warnings };
}

export function findRepositoryExtensionTerminologyViolations(
  options: ScanOptions | readonly string[] = {},
): readonly ExtensionTerminologyViolation[] {
  const result = scanRepositoryExtensionTerminology(options);
  if (result.warnings.length > 0) {
    throw new Error(
      `Extension terminology check could not scan ${result.warnings.length} configured documentation path(s).`,
    );
  }
  return result.violations;
}

function main(): void {
  let result: RepositoryScanResult;
  try {
    const roots = process.argv.slice(2);
    result = scanRepositoryExtensionTerminology({
      onWarning: (warning) => console.warn(`${warning.file}: ${warning.message}`),
      roots: roots.length === 0 ? undefined : roots,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (result.warnings.length > 0) {
    console.error(
      `Extension terminology check could not scan ${result.warnings.length} configured documentation path(s).`,
    );
    process.exitCode = 1;
    return;
  }
  if (result.violations.length === 0) {
    console.log("Extension terminology check passed.");
    return;
  }

  for (const violation of result.violations) {
    console.error(`${violation.file}:${violation.line} [${violation.term}] ${violation.detail}`);
  }
  console.error(`Found ${result.violations.length} extension terminology violation(s).`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  main();
}
