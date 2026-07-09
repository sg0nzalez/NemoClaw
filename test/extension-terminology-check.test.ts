// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { findExtensionTerminologyViolations } from "../scripts/checks/extension-terminology";

describe("extension terminology guard", () => {
  it.each([
    "reserved",
    "future",
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
    "candidate",
    "proposed",
    "before SDK stabilization",
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

  it("flags wording that presents a current public SDK", () => {
    const source = "Use the public NemoClaw plugin SDK to build a third-party lifecycle extension.";

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
        "NemoClaw provides a compatibility commitment for extension packages.",
        "docs/example.mdx",
      ),
    ).toMatchObject([{ term: "NemoClaw compatibility commitment" }]);
  });
});
