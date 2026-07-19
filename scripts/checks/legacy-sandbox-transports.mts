// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Freezes the statically recognizable direct host-to-sandbox transport surface
 * while NemoClaw moves to OpenShell's gRPC API. Literal calls and same-file
 * immutable aliases must be removed or re-reviewed explicitly. This check is a
 * review tripwire, not a general-purpose data-flow analysis.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type LegacySandboxTransportKind =
  | "docker-exec-command"
  | "docker-exec-builder"
  | "openshell-ssh-config"
  | "privileged-sandbox-exec"
  | "ssh-command"
  | "ssh-temp-config"
  | "sshfs-command";

export interface LegacySandboxTransportSite {
  relativePath: string;
  kind: LegacySandboxTransportKind;
  calls: number;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REVIEWED_INVENTORY_PATH = "ci/legacy-sandbox-transports.json";
const LEGACY_SANDBOX_TRANSPORT_KINDS = new Set<LegacySandboxTransportKind>([
  "docker-exec-command",
  "docker-exec-builder",
  "openshell-ssh-config",
  "privileged-sandbox-exec",
  "ssh-command",
  "ssh-temp-config",
  "sshfs-command",
]);

/** Load the reviewed baseline from the CODEOWNERS-protected CI inventory. */
export function loadReviewedLegacySandboxTransportSites(
  repoRoot = REPO_ROOT,
): readonly LegacySandboxTransportSite[] {
  const inventoryPath = path.join(repoRoot, REVIEWED_INVENTORY_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(inventoryPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read reviewed legacy sandbox transport inventory ${inventoryPath}: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${REVIEWED_INVENTORY_PATH} must contain an array`);
  }

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${REVIEWED_INVENTORY_PATH}[${String(index)}] must be an object`);
    }
    const { relativePath, kind, calls } = entry as Record<string, unknown>;
    if (
      typeof relativePath !== "string" ||
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath.split("/").includes("..")
    ) {
      throw new Error(
        `${REVIEWED_INVENTORY_PATH}[${String(index)}].relativePath must be a safe repository-relative path`,
      );
    }
    if (
      typeof kind !== "string" ||
      !LEGACY_SANDBOX_TRANSPORT_KINDS.has(kind as LegacySandboxTransportKind)
    ) {
      throw new Error(`${REVIEWED_INVENTORY_PATH}[${String(index)}].kind is invalid`);
    }
    if (!Number.isSafeInteger(calls) || (calls as number) < 1) {
      throw new Error(`${REVIEWED_INVENTORY_PATH}[${String(index)}].calls must be positive`);
    }
    const site = {
      relativePath,
      kind: kind as LegacySandboxTransportKind,
      calls: calls as number,
    };
    const key = `${site.relativePath}:${site.kind}`;
    if (seen.has(key)) throw new Error(`${REVIEWED_INVENTORY_PATH} contains duplicate ${key}`);
    seen.add(key);
    return site;
  });
}

const HELPER_KINDS = new Map<string, LegacySandboxTransportKind>([
  ["captureSandboxSshConfig", "openshell-ssh-config"],
  ["captureSandboxSshConfigCommand", "openshell-ssh-config"],
  ["createTempSshConfig", "ssh-temp-config"],
  ["dockerExecArgv", "docker-exec-builder"],
  ["privilegedSandboxExecArgv", "privileged-sandbox-exec"],
]);

const COMMAND_CALLS = new Set([
  "execFile",
  "execFileSync",
  "run",
  "runCapture",
  "runCaptureImpl",
  "runSync",
  "spawn",
  "spawnSync",
]);

const SHELL_COMMAND_CALLS = new Set(["exec", "execSync"]);

const DOCKER_COMMAND_CALLS = new Set([
  "dockerCapture",
  "dockerExecFileSync",
  "dockerRun",
  "dockerSpawn",
  "dockerSpawnSync",
  "runDocker",
]);

const NON_SANDBOX_SSH_ROOTS = ["src/lib/actions/dns/", "src/lib/deploy/"] as const;

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

function repoPath(repoRoot: string, sourcePath: string): string {
  return path.relative(repoRoot, sourcePath).split(path.sep).join("/");
}

function expressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

type ConstBindings = ReadonlyMap<string, ts.Expression | null>;

function collectConstBindings(sourceFile: ts.SourceFile): ConstBindings {
  const bindings = new Map<string, ts.Expression | null>();

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const name = node.name.text;
      bindings.set(name, bindings.has(name) ? null : node.initializer);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return bindings;
}

function resolveAlias(
  expression: ts.Expression,
  bindings: ConstBindings,
  seen = new Set<string>(),
): ts.Expression {
  if (!ts.isIdentifier(expression) || seen.has(expression.text)) return expression;
  const binding = bindings.get(expression.text);
  if (!binding) return expression;
  seen.add(expression.text);
  return resolveAlias(binding, bindings, seen);
}

function resolvedExpressionName(expression: ts.Expression, bindings: ConstBindings): string | null {
  return expressionName(resolveAlias(expression, bindings));
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function commandFromArgument(
  argument: ts.Expression | undefined,
  bindings: ConstBindings,
): string | null {
  if (!argument) return null;
  const resolved = resolveAlias(argument, bindings);
  const direct = literalText(resolved);
  if (direct) return direct;
  if (!ts.isArrayLiteralExpression(resolved)) return null;
  const first = resolved.elements[0];
  return first && ts.isExpression(first) ? literalText(resolveAlias(first, bindings)) : null;
}

function shellCommandPrefix(
  argument: ts.Expression | undefined,
  bindings: ConstBindings,
): readonly [string, string | undefined] | null {
  if (!argument) return null;
  const command = literalText(resolveAlias(argument, bindings));
  if (command === null) return null;
  const [executable, subcommand] = command.trimStart().split(/\s+/u, 2);
  if (!executable) return null;
  return [path.posix.basename(executable), subcommand];
}

function increment(
  counts: Map<LegacySandboxTransportKind, number>,
  kind: LegacySandboxTransportKind,
) {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

function scanSource(
  relativePath: string,
  sourceText: string,
): Map<LegacySandboxTransportKind, number> {
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const counts = new Map<LegacySandboxTransportKind, number>();
  const bindings = collectConstBindings(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isArrayLiteralExpression(node)) {
      const first = literalText(node.elements[0]);
      const second = literalText(node.elements[1]);
      if (first === "docker" && second === "exec") {
        increment(counts, "docker-exec-command");
      }
      if (first === "sandbox" && second === "ssh-config") {
        increment(counts, "openshell-ssh-config");
      }
    }

    if (ts.isCallExpression(node)) {
      const name = resolvedExpressionName(node.expression, bindings);
      const helperKind = name ? HELPER_KINDS.get(name) : undefined;
      if (helperKind) increment(counts, helperKind);
      if (name !== null && DOCKER_COMMAND_CALLS.has(name)) {
        const firstDockerArg = commandFromArgument(node.arguments[0], bindings);
        if (firstDockerArg === "exec") increment(counts, "docker-exec-command");
      }

      const commandArgumentIndex = name === "collect" ? 2 : 0;
      if (name === "collect" || (name !== null && COMMAND_CALLS.has(name))) {
        const command = commandFromArgument(node.arguments[commandArgumentIndex], bindings);
        const scansSandboxSsh = !NON_SANDBOX_SSH_ROOTS.some((root) =>
          relativePath.startsWith(root),
        );
        if (scansSandboxSsh && command === "ssh") increment(counts, "ssh-command");
        if (command === "sshfs") increment(counts, "sshfs-command");
      }
      if (name !== null && SHELL_COMMAND_CALLS.has(name)) {
        const prefix = shellCommandPrefix(node.arguments[0], bindings);
        const scansSandboxSsh = !NON_SANDBOX_SSH_ROOTS.some((root) =>
          relativePath.startsWith(root),
        );
        if (scansSandboxSsh && prefix?.[0] === "ssh") increment(counts, "ssh-command");
        if (prefix?.[0] === "sshfs") increment(counts, "sshfs-command");
        if (prefix?.[0] === "docker" && prefix[1] === "exec") {
          increment(counts, "docker-exec-command");
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return counts;
}

export function discoverLegacySandboxTransportSites(
  repoRoot: string,
): LegacySandboxTransportSite[] {
  return ["src", "nemoclaw/src"]
    .flatMap((sourceRoot) => productionTypeScriptFiles(path.join(repoRoot, sourceRoot)))
    .flatMap((sourcePath) => {
      const relativePath = repoPath(repoRoot, sourcePath);
      return [...scanSource(relativePath, readFileSync(sourcePath, "utf8"))].map(
        ([kind, calls]) => ({ relativePath, kind, calls }),
      );
    })
    .sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) || left.kind.localeCompare(right.kind),
    );
}

function siteKey(site: Pick<LegacySandboxTransportSite, "relativePath" | "kind">): string {
  return `${site.relativePath}:${site.kind}`;
}

export function auditLegacySandboxTransports(
  repoRoot = REPO_ROOT,
  reviewedSites: readonly LegacySandboxTransportSite[] = loadReviewedLegacySandboxTransportSites(
    repoRoot,
  ),
): string[] {
  const violations: string[] = [];
  const discovered = new Map(
    discoverLegacySandboxTransportSites(repoRoot).map((site) => [siteKey(site), site]),
  );

  for (const reviewed of reviewedSites) {
    const key = siteKey(reviewed);
    const current = discovered.get(key);
    if (!current) {
      violations.push(`${key}: reviewed legacy transport is gone; remove this allowlist entry`);
    } else if (current.calls !== reviewed.calls) {
      violations.push(
        `${key}: expected ${reviewed.calls} reviewed call(s), found ${current.calls}`,
      );
    }
    discovered.delete(key);
  }

  for (const site of discovered.values()) {
    violations.push(`${siteKey(site)}: found ${site.calls} unreviewed legacy transport call(s)`);
  }

  return violations;
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const violations = auditLegacySandboxTransports();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }

  console.log("Legacy sandbox SSH, SSHFS, and Docker-exec sites match the reviewed inventory.");
}
