// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findExtensionTerminologyViolations,
  findRepositoryExtensionTerminologyViolations,
} from "../scripts/checks/extension-terminology";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_ROOT = path.join(REPO_ROOT, "test", ".tmp");
const temporaryRoots: string[] = [];

function createTemporaryRoot(prefix: string): string {
  mkdirSync(TEMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TEMP_ROOT, prefix));
}

function writeNewFile(filePath: string, content: string): void {
  const descriptor = openSync(filePath, "wx", 0o600);
  try {
    writeSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

afterEach(() => {
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
    "non-committed:",
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
