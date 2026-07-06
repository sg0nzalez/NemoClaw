// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURES_ROOT = path.join(REPO_ROOT, "test", "e2e", "fixtures");
const REVIEW_PATH = path.join(
  REPO_ROOT,
  "docs",
  "security",
  "e2e-weather-plugin-fixture-dependency-review.md",
);

function collectFixtureLockfiles(dir: string): string[] {
  const lockfiles: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      lockfiles.push(...collectFixtureLockfiles(entryPath));
    } else if (entry.name === "package-lock.json") {
      lockfiles.push(path.relative(REPO_ROOT, entryPath).split(path.sep).join("/"));
    }
  }
  return lockfiles.sort();
}

describe("E2E fixture dependency review", () => {
  const review = fs.readFileSync(REVIEW_PATH, "utf8");

  it("records every committed fixture lockfile in the checked-in review", () => {
    const lockfiles = collectFixtureLockfiles(FIXTURES_ROOT);
    expect(lockfiles.length).toBeGreaterThan(0);
    for (const lockfile of lockfiles) {
      expect(review, lockfile).toContain(`- \`${lockfile}\``);
    }
  });

  it("records the fixture threat controls and revalidation contract", () => {
    for (const marker of [
      "npm ci --ignore-scripts",
      "read-only `contents` permission",
      "full-SHA-pinned actions",
      "disables checkout credential persistence",
      "receives no repository secrets",
      "npm audit --package-lock-only --ignore-scripts --json",
      "accepted residual risk is limited to this secret-free E2E lane with read-only contents permission",
      "Rerun it whenever `package.json` or `package-lock.json` changes",
    ]) {
      expect(review).toContain(marker);
    }
  });

  it("keeps installed fixture dependencies on exact versions", () => {
    const weatherFixture = path.join(FIXTURES_ROOT, "plugins", "weather");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(weatherFixture, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    }

    const lockfileText = fs.readFileSync(path.join(weatherFixture, "package-lock.json"), "utf8");
    const lockfileDigest = createHash("sha256").update(lockfileText).digest("hex");
    expect(review).toContain(`SHA-256 \`${lockfileDigest}\``);

    const lockfile = JSON.parse(lockfileText) as {
      packages?: Record<string, { resolved?: unknown; integrity?: unknown }>;
    };
    for (const [packagePath, entry] of Object.entries(lockfile.packages ?? {})) {
      if (packagePath.length === 0) continue;
      expect(entry.resolved, packagePath).toEqual(expect.any(String));
      expect(entry.integrity, packagePath).toEqual(expect.any(String));
    }
  });
});
