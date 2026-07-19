// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeBaselineExclusions } from "./registry-normalization";

const originalHome = process.env.HOME;
const temporaryHomes: string[] = [];

async function loadRegistryWith(
  sandboxes: Record<string, unknown>,
  defaultSandbox: unknown = null,
) {
  return loadRegistryDocument({ defaultSandbox, sandboxes });
}

async function loadRegistryDocument(document: unknown) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-normalization-"));
  temporaryHomes.push(home);
  const configDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "sandboxes.json"), JSON.stringify(document), {
    mode: 0o600,
  });

  process.env.HOME = home;
  vi.resetModules();
  return import("./registry");
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("sandbox registry normalization", () => {
  it.each([
    null,
    [],
    42,
    "invalid",
  ])("treats a non-object top-level registry document as empty: %j", async (document) => {
    const registry = await loadRegistryDocument(document);

    expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: null });
  });

  it("drops a malformed sandboxes container at the file boundary", async () => {
    const registry = await loadRegistryDocument({
      defaultSandbox: 42,
      sandboxes: "not-an-object",
    });

    expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: null });
  });

  it("drops object-shaped entries that do not contain a usable sandbox name", async () => {
    const registry = await loadRegistryWith({
      missing: { createdAt: "2026-07-09T00:00:00.000Z" },
      empty: { name: "" },
      whitespace: { name: "   " },
      wrongType: { name: 42 },
      mismatched: { name: "different" },
      valid: { name: "valid", createdAt: "2026-07-09T00:00:00.000Z" },
    });

    expect(registry.listSandboxes().sandboxes).toEqual([
      { name: "valid", createdAt: "2026-07-09T00:00:00.000Z" },
    ]);
  });

  it("preserves a stale pointer for diagnostics but repairs it on registration", async () => {
    const registry = await loadRegistryWith({ mismatched: { name: "different" } }, "mismatched");

    expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: "mismatched" });

    registry.registerSandbox({ name: "replacement" });

    expect(registry.listSandboxes().defaultSandbox).toBe("replacement");

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBe("replacement");
    expect(persisted.defaultSelectionRevision).toBe(1);
  });

  it("advances the ownership revision when persistence repairs a stale pointer", async () => {
    const registry = await loadRegistryWith({}, "ghost");

    registry.save(registry.load());

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBeNull();
    expect(persisted.defaultSelectionRevision).toBe(1);
  });

  it("does not retain a default inherited from Object.prototype", async () => {
    const registry = await loadRegistryWith({}, "constructor");

    registry.save(registry.load());

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBeNull();
    expect(persisted.defaultSelectionRevision).toBe(1);
  });
});

describe("baseline exclusion normalization (#7178)", () => {
  it("keeps well-formed entries and trims key/digest", () => {
    expect(
      normalizeBaselineExclusions([
        {
          key: "  nous_research  ",
          digest: "  abc  ",
          acknowledgedAt: "t",
          appliedAgentVersion: "1",
        },
      ]),
    ).toEqual([
      { key: "nous_research", digest: "abc", acknowledgedAt: "t", appliedAgentVersion: "1" },
    ]);
  });

  it("preserves an explicitly unknown applied agent version", () => {
    expect(
      normalizeBaselineExclusions([
        { key: "nous_research", digest: "abc", appliedAgentVersion: null },
      ]),
    ).toEqual([{ key: "nous_research", digest: "abc", appliedAgentVersion: null }]);
  });

  it("fails closed when any persisted record is malformed", () => {
    expect(() =>
      normalizeBaselineExclusions([
        { key: "good", digest: "def" },
        { key: "", digest: "abc" },
      ]),
    ).toThrow(/without a key or digest.*before rebuilding/i);
    expect(() => normalizeBaselineExclusions(["not-an-object"])).toThrow(
      /malformed baseline exclusion.*before rebuilding/i,
    );
  });

  it("collapses duplicate keys, last wins", () => {
    expect(
      normalizeBaselineExclusions([
        { key: "dup", digest: "first" },
        { key: "dup", digest: "second" },
      ]),
    ).toEqual([{ key: "dup", digest: "second" }]);
  });

  it("returns undefined only for a legacy registry without the field", () => {
    expect(normalizeBaselineExclusions(undefined)).toBeUndefined();
    expect(normalizeBaselineExclusions([])).toBeUndefined();
    expect(() => normalizeBaselineExclusions("nope")).toThrow(/must be an array/i);
    expect(() => normalizeBaselineExclusions([{ key: "", digest: "" }])).toThrow(
      /without a key or digest/i,
    );
  });
});

describe("baseline exclusion registry helpers (#7178)", () => {
  it("round-trips add, get, and remove keyed by baseline entry", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha", agent: "hermes" });

    expect(registry.getBaselineExclusions("alpha")).toEqual([]);

    expect(
      registry.addBaselineExclusion("alpha", {
        key: "nous_research",
        digest: "d1",
        appliedAgentVersion: null,
      }),
    ).toBe(true);
    const stored = registry.getBaselineExclusions("alpha");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      key: "nous_research",
      digest: "d1",
      appliedAgentVersion: null,
    });
    expect(typeof stored[0].acknowledgedAt).toBe("string");

    expect(registry.removeBaselineExclusion("alpha", "nous_research")).toBe(true);
    expect(registry.getBaselineExclusions("alpha")).toEqual([]);
    expect(registry.removeBaselineExclusion("alpha", "nous_research")).toBe(false);
  });

  it("keeps exclusions independent from a same-named custom preset", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha", agent: "hermes" });

    registry.addCustomPolicy("alpha", { name: "brave", content: "version: 1\n" });
    registry.addBaselineExclusion("alpha", { key: "brave", digest: "d1" });

    expect(registry.getCustomPolicies("alpha").map((p) => p.name)).toEqual(["brave"]);
    expect(registry.getBaselineExclusions("alpha").map((e) => e.key)).toEqual(["brave"]);

    registry.removeBaselineExclusion("alpha", "brave");
    expect(registry.getCustomPolicies("alpha").map((p) => p.name)).toEqual(["brave"]);
    expect(registry.getBaselineExclusions("alpha")).toEqual([]);
  });

  it("refuses to load mixed valid and malformed persisted exclusions", async () => {
    const registry = await loadRegistryWith({
      alpha: {
        name: "alpha",
        baselineExclusions: [
          { key: "good", digest: "d1" },
          { key: "", digest: "d2" },
        ],
      },
    });

    expect(() => registry.listSandboxes()).toThrow(/without a key or digest.*before rebuilding/i);
  });
});
