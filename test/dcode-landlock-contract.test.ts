// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const OPENSHELL_FIXTURE_PREFIX = "openshell-";
const OPENSHELL_FIXTURE_SUFFIX = "-landlock-hard-requirement-missing-read-only-path.log";

function readRepoFile(...segments: string[]): string {
  return readFileSync(path.join(REPO_ROOT, ...segments), "utf8");
}

describe("DCode Landlock release contract", () => {
  it("keeps the schema, managed policy, and operator docs on hard_requirement (#5795)", () => {
    const schema = JSON.parse(readRepoFile("schemas", "sandbox-policy.schema.json")) as {
      properties: { landlock: { properties: { compatibility: { enum: string[] } } } };
    };
    const policy = YAML.parse(
      readRepoFile("agents", "langchain-deepagents-code", "policy-additions.yaml"),
    ) as { landlock?: { compatibility?: string } };

    expect(schema.properties.landlock.properties.compatibility.enum).toEqual([
      "best_effort",
      "hard_requirement",
    ]);
    expect(policy.landlock?.compatibility).toBe("hard_requirement");

    for (const doc of [
      ["docs", "deployment", "sandbox-hardening.mdx"],
      ["docs", "reference", "enterprise-readiness.mdx"],
      ["docs", "reference", "troubleshooting.mdx"],
      ["docs", "security", "best-practices.mdx"],
    ]) {
      expect(readRepoFile(...doc), doc.join("/")).toContain("hard_requirement");
    }
  });

  it("pins the classifier fixture to the exact supported OpenShell release (#5795)", () => {
    const blueprint = YAML.parse(readRepoFile("nemoclaw-blueprint", "blueprint.yaml")) as {
      min_openshell_version?: string;
      max_openshell_version?: string;
    };
    const version = blueprint.min_openshell_version;

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(blueprint.max_openshell_version).toBe(version);

    const fixture = readRepoFile(
      "test",
      "fixtures",
      `${OPENSHELL_FIXTURE_PREFIX}${version}${OPENSHELL_FIXTURE_SUFFIX}`,
    );
    expect(fixture).toBe(
      "Created sandbox: dcode-landlock-contract\n" +
        "Error: Failed to prepare sandbox: Landlock path unavailable in hard_requirement mode: " +
        "/definitely-missing-nemoclaw-landlock-contract (read_only): failed to open " +
        '"/definitely-missing-nemoclaw-landlock-contract": No such file or directory (os error 2)\n',
    );
  });
});
