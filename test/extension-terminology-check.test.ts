// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findExtensionTerminologyViolations,
  findRepositoryExtensionTerminologyViolations,
} from "../scripts/checks/extension-terminology";
import { listChecks, runChecks } from "../scripts/checks/run";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_ROOT = path.join(REPO_ROOT, "test", ".tmp");
const TRUSTED_CI_WARNING = "repository terminology scan is intended for trusted CI check runs";
const temporaryRoots: string[] = [];
const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
const originalCi = process.env.CI;

function createTemporaryRoot(prefix: string): string {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const temporaryRoot = path.join(TEMP_ROOT, `${prefix}${randomUUID()}`);
  mkdirSync(temporaryRoot, { mode: 0o700 });
  return temporaryRoot;
}

function createExternalTemporaryRoot(prefix: string): string {
  const temporaryRoot = path.join(path.dirname(REPO_ROOT), `${prefix}${randomUUID()}`);
  mkdirSync(temporaryRoot, { mode: 0o700 });
  return temporaryRoot;
}

function writeNewFile(filePath: string, content: string): void {
  const descriptor = openSync(filePath, "wx", 0o600);
  try {
    writeSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

beforeEach(() => {
  process.env.CI = "true";
});

afterEach(() => {
  originalCi === undefined ? Reflect.deleteProperty(process.env, "CI") : (process.env.CI = originalCi);
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("extension terminology guard", () => {
  it.each([
    "reserved",
    "not offered",
    "not available",
    "not committed",
    "not guaranteed",
    "not promised",
    "not stable",
    "not supported",
    "unavailable",
    "non-committed",
    "non committed",
    "no current",
    "no public",
    "no stable",
    "no supported",
    "no shipping",
    "does not offer",
    "does not commit",
    "does not guarantee",
    "does not promise",
    "does not provide",
    "not yet",
    "unmet gates",
    "candidate and reserved",
    "proposed and unavailable",
    "future and not offered",
    "before SDK stabilization",
    "-reserved-",
    "pre-reserved-post",
    "-non-committed-",
    "pre-non-committed-post",
    "(reserved)",
    "reserved;",
    "reserved:",
    "reserved,",
    "reserved.",
    "not offered.",
    "not available.",
    "not committed.",
    "not guaranteed.",
    "not promised.",
    "not stable.",
    "not supported.",
    "unavailable.",
    "non-committed:",
    "non-committed.",
    "non–committed.",
    "no current.",
    "no public.",
    "no stable.",
    "no supported.",
    "no shipping.",
    "does not offer.",
    "does not commit.",
    "does not guarantee.",
    "does not promise.",
    "does not provide.",
    "not yet.",
    "unmet gates.",
    "before SDK stabilization.",
  ])("allows %s SDK wording", (allowedContext) => {
    const source = `The NemoClaw plugin SDK is ${allowedContext} for extension authors.`;

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toEqual([]);
  });

  it("allows reserved and future SDK wording", () => {
    const source = `The NemoClaw plugin SDK is reserved for a future decision and is not offered today.
A candidate public NemoClaw SDK remains unavailable until unmet gates are complete.
NemoClaw does not guarantee a migration guarantee for candidate lifecycle contributions.`;

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toEqual([]);
  });

  it.each([
    "Use the public NemoClaw plugin SDK to build a third-party lifecycle extension.",
    "Use the public NemoClaw extension SDK to build a third-party lifecycle extension.",
  ])("flags wording that presents a current public SDK", (source) => {
    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toMatchObject([
      {
        file: "docs/example.mdx",
        line: 1,
        term: "NemoClaw plugin SDK",
      },
    ]);
  });

  it("flags current registry and compatibility promises", () => {
    const source = `The NemoClaw plugin registry accepts third-party modules.
NemoClaw provides a CLI compatibility contract for extension packages.
NemoClaw makes a semantic versioning promise for lifecycle contributions.
NemoClaw provides a migration guarantee for extension authors.
NemoClaw publishes a compatibility commitment for external plugins.`;

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toMatchObject([
      { line: 1, term: "NemoClaw plugin registry" },
      { line: 2, term: "NemoClaw CLI compatibility contract" },
      { line: 3, term: "NemoClaw semantic-versioning promise" },
      { line: 4, term: "NemoClaw migration guarantee" },
      { line: 5, term: "NemoClaw compatibility commitment" },
    ]);
  });

  it.each([
    ["The NemoClaw plugin SDK is reserved and available today.", "NemoClaw plugin SDK"],
    [
      "The NemoClaw plugin SDK is reserved and available for extension authors.",
      "NemoClaw plugin SDK",
    ],
    ["The NemoClaw plugin SDK is reserved and supported.", "NemoClaw plugin SDK"],
    ["The NemoClaw plugin SDK is reserved and stable.", "NemoClaw plugin SDK"],
    ["The NemoClaw plugin SDK is reserved and public.", "NemoClaw plugin SDK"],
    ["The NemoClaw plugin registry is not offered but accepts modules today.", "NemoClaw plugin registry"],
    [
      "NemoClaw does not promise SemVer stability but provides a semantic-versioning guarantee for lifecycle contributions today.",
      "NemoClaw semantic-versioning promise",
    ],
  ])("flags same-clause reserved wording with current promises", (source, term) => {
    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toMatchObject([
      { line: 1, term },
    ]);
  });

  it("flags current SDK wording when allowed words describe another surface", () => {
    const source = "Unlike the reserved OpenClaw plugin SDK, the public NemoClaw extension SDK is available today.";

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toMatchObject([
      { line: 1, term: "NemoClaw plugin SDK" },
    ]);
  });

  it("flags current registry wording when allowed words describe unrelated work", () => {
    const source = "Future OpenClaw work is reserved, but the NemoClaw plugin registry accepts modules today.";

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toMatchObject([
      { line: 1, term: "NemoClaw plugin registry" },
    ]);
  });

  it.each([
    ["The candidate public NemoClaw SDK is available today.", "NemoClaw plugin SDK"],
    ["The proposed NemoClaw plugin registry accepts modules today.", "NemoClaw plugin registry"],
  ])("flags broad qualifier wording that still presents a current product promise", (source, term) => {
    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toMatchObject([
      { line: 1, term },
    ]);
  });

  it("flags a later current SDK promise after an earlier identical reserved term", () => {
    const source =
      "The NemoClaw plugin SDK is reserved, but the public NemoClaw plugin SDK is available today.";

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toMatchObject([
      { line: 1, term: "NemoClaw plugin SDK" },
    ]);
  });

  it.each(["...", "?!", "!?"])("handles %s before compatibility context", (delimiter) => {
    const source = `Reserved extension terminology${delimiter} NemoClaw provides a compatibility commitment for extension packages.`;

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toEqual([
      {
        detail: "do not present a current compatibility commitment for extension surfaces",
        file: "docs/example.mdx",
        line: 1,
        term: "NemoClaw compatibility commitment",
      },
    ]);
  });

  it("flags current product promises after repeated allowed-context terms", () => {
    const source = `The NemoClaw plugin SDK is ${"not ".repeat(10_000)}available today.`;

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toEqual([
      {
        detail: "describe any NemoClaw SDK as reserved, future, unavailable, or non-committed",
        file: "docs/example.mdx",
        line: 1,
        term: "NemoClaw plugin SDK",
      },
    ]);
  });

  it("handles long lines without excessive regex work", () => {
    const source = `The NemoClaw plugin SDK is reserved. ${"x".repeat(50_000)}`;

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toEqual([]);
  });

  it("handles repeated allowed-context terms without excessive regex work", () => {
    const source = Array.from({ length: 2_000 }, () => "The NemoClaw plugin SDK is not offered.").join("\n");
    const started = performance.now();

    expect(findExtensionTerminologyViolations(source, "docs/example.mdx")).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("keeps compatibility commitment scoped to extension surfaces", () => {
    expect(
      findExtensionTerminologyViolations(
        "NemoClaw provides a compatibility commitment for CLI tools.",
        "docs/example.mdx",
      ),
    ).toEqual([]);
    expect(
      findExtensionTerminologyViolations(
        "NemoClaw provides a compatibility commitment for internal tools.",
        "docs/example.mdx",
      ),
    ).toEqual([]);
    expect(
      findExtensionTerminologyViolations(
        "NemoClaw provides a compatibility commitment for CLI tools and extension packages.",
        "docs/example.mdx",
      ),
    ).toMatchObject([{ line: 1, term: "NemoClaw compatibility commitment" }]);
    const extensionViolations = findExtensionTerminologyViolations(
      "NemoClaw provides a compatibility commitment for extension packages.",
      "docs/example.mdx",
    );
    expect(extensionViolations).toEqual([
      {
        detail: "do not present a current compatibility commitment for extension surfaces",
        file: "docs/example.mdx",
        line: 1,
        term: "NemoClaw compatibility commitment",
      },
    ]);
  });

  it("warns and skips repository scans outside trusted CI", () => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-ci-warning-");
    temporaryRoots.push(root);
    const warnings: { file: string; message: string }[] = [];
    delete process.env.CI;
    writeNewFile(path.join(root, "violation.md"), "Use the public NemoClaw extension SDK today.");

    expect(
      findRepositoryExtensionTerminologyViolations({
        onWarning: (warning) => warnings.push(warning),
        roots: [root],
      }),
    ).toEqual([]);
    expect(warnings).toEqual([{ file: "<environment>", message: TRUSTED_CI_WARNING }]);
  });

  it("scans configured markdown and mdx documentation roots", () => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-");
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeNewFile(path.join(root, "allowed.mdx"), "The NemoClaw plugin SDK is reserved.");
    writeNewFile(
      path.join(root, "nested", "violation.md"),
      "Use the public NemoClaw extension SDK today.",
    );
    writeNewFile(path.join(root, "ignored.txt"), "The NemoClaw plugin registry accepts modules.");

    expect(findRepositoryExtensionTerminologyViolations([root])).toMatchObject([
      {
        file: path.relative(REPO_ROOT, path.join(root, "nested", "violation.md")),
        line: 1,
        term: "NemoClaw plugin SDK",
      },
    ]);
  });

  it.each([
    ".cache",
    ".eslintcache",
    ".next",
    ".parcel-cache",
    ".rspack",
    ".stylelintcache",
    ".swc",
    ".turbo",
    ".vercel",
    ".webpack",
    "build",
    "out",
    "target",
  ])("ignores generated documentation under %s", (directoryName) => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-skip-dir-");
    temporaryRoots.push(root);
    const skipped = path.join(root, directoryName);
    mkdirSync(skipped, { recursive: true });
    writeNewFile(path.join(skipped, "violation.md"), "Use the public NemoClaw extension SDK today.");

    expect(findRepositoryExtensionTerminologyViolations([root])).toEqual([]);
  });

  it("warns and skips oversized documentation files", () => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-large-file-");
    temporaryRoots.push(root);
    const warnings: { file: string; message: string }[] = [];
    const largeFile = path.join(root, "large.md");
    writeNewFile(largeFile, `${"x".repeat(1_000_001)} Use the public NemoClaw extension SDK today.`);

    expect(
      findRepositoryExtensionTerminologyViolations({
        onWarning: (warning) => warnings.push(warning),
        roots: [root],
      }),
    ).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({
        file: path.relative(REPO_ROOT, largeFile),
        message: "documentation file is too large for terminology scan",
      }),
    ]);
  });

  it("warns and skips scan roots outside the repository", () => {
    const warnings: { file: string; message: string }[] = [];
    const escapedRoot = path.dirname(REPO_ROOT);

    expect(
      findRepositoryExtensionTerminologyViolations({
        onWarning: (warning) => warnings.push(warning),
        roots: [escapedRoot],
      }),
    ).toEqual([]);
    expect(warnings).toEqual([
      {
        file: escapedRoot,
        message: "scan root escapes repository root",
      },
    ]);
  });

  it("warns and skips scan roots whose realpath escapes the repository", () => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-root-symlink-");
    const outside = createExternalTemporaryRoot("nemoclaw-extension-terminology-outside-root-");
    temporaryRoots.push(root, outside);
    const warnings: { file: string; message: string }[] = [];
    writeNewFile(path.join(outside, "violation.md"), "Use the public NemoClaw extension SDK today.");
    const symlinkRoot = path.join(root, "docs");
    symlinkSync(outside, symlinkRoot, "dir");

    expect(
      findRepositoryExtensionTerminologyViolations({
        onWarning: (warning) => warnings.push(warning),
        roots: [symlinkRoot],
      }),
    ).toEqual([]);
    expect(warnings).toEqual([
      {
        file: symlinkRoot,
        message: "scan root realpath escapes repository root",
      },
    ]);
  });

  it("warns and continues after filesystem scan errors", () => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-errors-");
    temporaryRoots.push(root);
    const warnings: { file: string; message: string }[] = [];
    mkdirSync(root, { recursive: true });
    const nonDirectoryRoot = path.join(root, "not-a-directory.txt");
    writeNewFile(path.join(root, "violation.md"), "Use the public NemoClaw extension SDK today.");
    writeNewFile(nonDirectoryRoot, "Use the public NemoClaw extension SDK today.");

    expect(
      findRepositoryExtensionTerminologyViolations({
        onWarning: (warning) => warnings.push(warning),
        roots: [root, nonDirectoryRoot],
      }),
    ).toMatchObject([{ file: path.relative(REPO_ROOT, path.join(root, "violation.md")) }]);
    expect(warnings).toEqual([
      expect.objectContaining({ file: path.relative(REPO_ROOT, nonDirectoryRoot) }),
    ]);
  });

  it.skipIf(process.platform === "win32" || runsAsRoot)(
    "warns and continues after permission errors",
    () => {
      const root = createTemporaryRoot("nemoclaw-extension-terminology-permission-");
      temporaryRoots.push(root);
      const warnings: { file: string; message: string }[] = [];
      const restricted = path.join(root, "restricted");
      mkdirSync(restricted, { recursive: true });
      chmodSync(restricted, 0o000);

      expect(
        findRepositoryExtensionTerminologyViolations({
          onWarning: (warning) => warnings.push(warning),
          roots: [root],
        }),
      ).toEqual([]);
      chmodSync(restricted, 0o700);
      expect(warnings).toEqual([
        expect.objectContaining({ file: path.relative(REPO_ROOT, restricted) }),
      ]);
    },
  );

  it("warns and continues after broken symlinks", () => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-broken-symlink-");
    temporaryRoots.push(root);
    const warnings: { file: string; message: string }[] = [];
    mkdirSync(root, { recursive: true });
    const broken = path.join(root, "missing.md");
    symlinkSync(path.join(root, "does-not-exist.md"), broken, "file");

    expect(
      findRepositoryExtensionTerminologyViolations({
        onWarning: (warning) => warnings.push(warning),
        roots: [root],
      }),
    ).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ file: path.relative(REPO_ROOT, broken) })]);
  });

  it("warns and continues after circular symlinks", () => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-circular-symlink-");
    temporaryRoots.push(root);
    const warnings: { file: string; message: string }[] = [];
    const nested = path.join(root, "nested");
    mkdirSync(nested, { recursive: true });
    symlinkSync(root, path.join(nested, "loop"), "dir");

    expect(
      findRepositoryExtensionTerminologyViolations({
        onWarning: (warning) => warnings.push(warning),
        roots: [root],
      }),
    ).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({ file: path.relative(REPO_ROOT, path.join(nested, "loop")) }),
    ]);
  });

  it("registers extension terminology without import-time execution", () => {
    const extensionCheck = listChecks().find((check) => check.name === "extension-terminology");

    expect(extensionCheck).toEqual({
      args: ["scripts/checks/extension-terminology.ts"],
      command: process.platform === "win32" ? "tsx.cmd" : "tsx",
      name: "extension-terminology",
    });
  });

  it("runs checks through an injectable runner", () => {
    const runner = vi.fn(() => ({ status: 0 }));

    expect(runChecks(runner)).toBe(0);
    expect(runner).toHaveBeenCalledTimes(listChecks().length);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["scripts/checks/extension-terminology.ts"],
        name: "extension-terminology",
      }),
    );
  });

  it("stops check execution after the first injected failure", () => {
    const runner = vi.fn((check: { readonly name: string }) => ({
      status: check.name === "extension-terminology" ? 7 : 0,
    }));

    expect(runChecks(runner)).toBe(7);
    expect(runner).toHaveBeenCalledTimes(
      listChecks().findIndex((check) => check.name === "extension-terminology") + 1,
    );
  });

  it("does not follow symlinks outside scanned documentation roots", () => {
    const root = createTemporaryRoot("nemoclaw-extension-terminology-symlink-");
    const outside = createTemporaryRoot("nemoclaw-extension-terminology-outside-");
    temporaryRoots.push(root, outside);
    const warnings: { file: string; message: string }[] = [];
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeNewFile(path.join(outside, "violation.md"), "Use the public NemoClaw extension SDK today.");
    symlinkSync(outside, path.join(root, "outside"), "dir");
    symlinkSync(path.join(outside, "violation.md"), path.join(root, "outside.md"), "file");

    expect(
      findRepositoryExtensionTerminologyViolations({
        onWarning: (warning) => warnings.push(warning),
        roots: [root],
      }),
    ).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({ file: path.relative(REPO_ROOT, path.join(root, "outside")) }),
      expect.objectContaining({ file: path.relative(REPO_ROOT, path.join(root, "outside.md")) }),
    ]);
  });

});
