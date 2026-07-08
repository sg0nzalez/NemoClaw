// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");
const pluginProjectDir = path.join(agentDir, "profile-plugin");
const pluginSourcePath = path.join(
  pluginProjectDir,
  "src",
  "nemoclaw_deepagents_profile",
  "__init__.py",
);
const pluginProjectPath = path.join(pluginProjectDir, "pyproject.toml");
const validatorPath = path.join(agentDir, "validate-nemotron-ultra-profile.py");

const EXPECTED_DCODE_VERSION = "0.1.34";
const EXPECTED_DEEPAGENTS_VERSION = "0.7.0a6";
const NATIVE_PROFILE_SHA256 = "c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7";
const UNMODIFIED_BOOTSTRAP_SHA256 =
  "005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf";
const CANONICAL_MODEL_SPEC = "nvidia:nvidia/nemotron-3-ultra-550b-a55b";
const MANAGED_MODEL_ALIASES = [
  "openai:nvidia/nemotron-3-ultra-550b-a55b",
  "openai:nvidia/nvidia/nemotron-3-ultra",
] as const;

const NATIVE_PROFILE_SOURCE = `"""Focused native Nemotron profile fixture."""

NATIVE_PROFILE_MARKER = "reviewed"
`;

const BOOTSTRAP_SOURCE = `"""Focused unmodified Deep Agents bootstrap fixture."""

BOOTSTRAP_MARKER = "unmodified"
`;

const tempRoots: string[] = [];

type PluginFixture = {
  root: string;
  nativeProfilePath: string;
  bootstrapPath: string;
};

type ProbeResult = {
  aliases: boolean[];
  canonicalPresent: boolean;
  error: string | null;
  registryKeys: string[];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeFixtureFile(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function makePluginFixture(
  options: {
    dcode?: string;
    deepagents?: string;
    nativeProfileSource?: string;
    bootstrapSource?: string;
  } = {},
): PluginFixture {
  const dcodeVersion = options.dcode ?? EXPECTED_DCODE_VERSION;
  const deepagentsVersion = options.deepagents ?? EXPECTED_DEEPAGENTS_VERSION;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-profile-plugin-fixture-"));
  tempRoots.push(root);

  writeFixtureFile(root, "deepagents_code/__init__.py", '"""DCode fixture."""\n');
  writeFixtureFile(root, "deepagents/__init__.py", '"""Deep Agents fixture."""\n');
  writeFixtureFile(
    root,
    "deepagents/profiles/__init__.py",
    "from deepagents.profiles.harness.harness_profiles import register_harness_profile\n",
  );
  writeFixtureFile(root, "deepagents/profiles/harness/__init__.py", '"""Harness fixture."""\n');
  writeFixtureFile(
    root,
    "deepagents/profiles/harness/harness_profiles.py",
    `import os

_HARNESS_PROFILES = {}


def register_harness_profile(key, profile):
    _HARNESS_PROFILES[key] = profile
    if os.environ.get("NEMOCLAW_TEST_FAIL_KEY") == key:
        raise RuntimeError(f"injected registration failure for {key}")
`,
  );
  const nativeProfilePath = writeFixtureFile(
    root,
    "deepagents/profiles/harness/_nvidia_nemotron_3_ultra.py",
    options.nativeProfileSource ?? NATIVE_PROFILE_SOURCE,
  );
  const bootstrapPath = writeFixtureFile(
    root,
    "deepagents/profiles/_builtin_profiles.py",
    options.bootstrapSource ?? BOOTSTRAP_SOURCE,
  );
  writeFixtureFile(
    root,
    `deepagents_code-${dcodeVersion}.dist-info/METADATA`,
    `Metadata-Version: 2.1\nName: deepagents-code\nVersion: ${dcodeVersion}\n`,
  );
  writeFixtureFile(
    root,
    `deepagents-${deepagentsVersion}.dist-info/METADATA`,
    `Metadata-Version: 2.1\nName: deepagents\nVersion: ${deepagentsVersion}\n`,
  );

  return { root, nativeProfilePath, bootstrapPath };
}

function prepareFixturePlugin(
  nativeSource = NATIVE_PROFILE_SOURCE,
  bootstrapSource = BOOTSTRAP_SOURCE,
): string {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-profile-plugin-source-"));
  tempRoots.push(pluginRoot);
  const source = fs
    .readFileSync(pluginSourcePath, "utf8")
    .replaceAll(NATIVE_PROFILE_SHA256, sha256(nativeSource))
    .replaceAll(UNMODIFIED_BOOTSTRAP_SHA256, sha256(bootstrapSource));
  return writeFixtureFile(pluginRoot, "nemoclaw_deepagents_profile/__init__.py", source);
}

function runPlugin(
  fixture: PluginFixture,
  options: {
    aliasState?: "complete" | "conflict" | "partial";
    failKey?: string;
    pluginPath?: string;
    registerCalls?: number;
    withCanonical?: boolean;
  } = {},
) {
  const pluginPath = options.pluginPath ?? prepareFixturePlugin();
  const pluginRoot = path.dirname(path.dirname(pluginPath));
  const script = `import json
from deepagents.profiles.harness.harness_profiles import _HARNESS_PROFILES

canonical = object()
if ${(options.withCanonical ?? true) ? "True" : "False"}:
    _HARNESS_PROFILES[${JSON.stringify(CANONICAL_MODEL_SPEC)}] = canonical

state = ${JSON.stringify(options.aliasState ?? "")}
aliases = ${JSON.stringify(MANAGED_MODEL_ALIASES)}
if state == "complete":
    for key in aliases:
        _HARNESS_PROFILES[key] = canonical
elif state == "partial":
    _HARNESS_PROFILES[aliases[0]] = canonical
elif state == "conflict":
    for key in aliases:
        _HARNESS_PROFILES[key] = object()

from nemoclaw_deepagents_profile import register

error = None
try:
    for _ in range(${options.registerCalls ?? 1}):
        register()
except Exception as exc:
    error = str(exc)

print(json.dumps({
    "aliases": [_HARNESS_PROFILES.get(key) is canonical for key in aliases],
    "canonicalPresent": _HARNESS_PROFILES.get(${JSON.stringify(CANONICAL_MODEL_SPEC)}) is canonical,
    "error": error,
    "registryKeys": sorted(_HARNESS_PROFILES),
}))
raise SystemExit(1 if error else 0)
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: `${fixture.root}${path.delimiter}${pluginRoot}`,
      ...(options.failKey ? { NEMOCLAW_TEST_FAIL_KEY: options.failKey } : {}),
    },
  });
  return {
    ...result,
    probe: JSON.parse(result.stdout) as ProbeResult,
  };
}

function expectOfficialSourcesUnchanged(
  fixture: PluginFixture,
  nativeSource = NATIVE_PROFILE_SOURCE,
  bootstrapSource = BOOTSTRAP_SOURCE,
): void {
  expect(fs.readFileSync(fixture.nativeProfilePath, "utf8")).toBe(nativeSource);
  expect(fs.readFileSync(fixture.bootstrapPath, "utf8")).toBe(bootstrapSource);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("LangChain Deep Agents Code managed Nemotron profile plugin (#6424)", () => {
  it("declares the supported Deep Agents harness-profile entry point", () => {
    const project = fs.readFileSync(pluginProjectPath, "utf8");

    expect(project).toContain('name = "nemoclaw-deepagents-profile"');
    expect(project).toContain('version = "0.1.0"');
    expect(project).toContain('[project.entry-points."deepagents.harness_profiles"]');
    expect(project).toContain('nemoclaw-managed-aliases = "nemoclaw_deepagents_profile:register"');
    expect(project).toContain('"deepagents-code==0.1.34"');
    expect(project).toContain('"deepagents==0.7.0a6"');
  });

  it("pins official package versions and unmodified wheel source digests", () => {
    const plugin = fs.readFileSync(pluginSourcePath, "utf8");

    for (const expected of [
      EXPECTED_DCODE_VERSION,
      EXPECTED_DEEPAGENTS_VERSION,
      NATIVE_PROFILE_SHA256,
      UNMODIFIED_BOOTSTRAP_SHA256,
      CANONICAL_MODEL_SPEC,
      ...MANAGED_MODEL_ALIASES,
    ]) {
      expect(plugin).toContain(expected);
    }
    expect(plugin).toContain("from deepagents.profiles import register_harness_profile");
    expect(plugin).not.toMatch(/write_bytes|write_text|os\.replace|\.replace\(path\)/);
  });

  it("keeps isolated discovery, source, graph, and dispatch checks in the image validator", () => {
    const validator = fs.readFileSync(validatorPath, "utf8");

    for (const expected of [
      '"nemoclaw-deepagents-profile": "0.1.0"',
      'group="deepagents.harness_profiles"',
      '"nemoclaw-managed-aliases"',
      '"nemoclaw_deepagents_profile:register"',
      NATIVE_PROFILE_SHA256,
      UNMODIFIED_BOOTSTRAP_SHA256,
      "create_deep_agent(model=managed_models[0])",
      "validate_parser_dispatch_parity()",
      "DENIED_DISPATCH_COMMAND",
      '"Shell command rejected"',
      "create_cli_agent(",
      "graph.invoke(",
      '"NemotronProgressBudgetMiddleware"',
      '"FinalAnswerGuardMiddleware"',
    ]) {
      expect(validator).toContain(expected);
    }
    expect(validator).toContain("def require(condition: bool, message: str)");
    expect(validator).not.toMatch(/^\s*assert\b/m);
  });

  it("registers both aliases against the canonical profile without changing wheel sources", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { registerCalls: 2 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.probe.error).toBeNull();
    expect(result.probe.aliases).toEqual([true, true]);
    expect(result.probe.canonicalPresent).toBe(true);
    expect(result.probe.registryKeys).toEqual(
      [...MANAGED_MODEL_ALIASES, CANONICAL_MODEL_SPEC].sort(),
    );
    expectOfficialSourcesUnchanged(fixture);
  });

  it.each([
    ["Deep Agents Code", { dcode: "0.1.35" }, "deepagents-code==0.1.34"],
    ["Deep Agents", { deepagents: "0.7.0a7" }, "deepagents==0.7.0a6"],
  ] as const)("fails closed on %s version drift", (_label, versions, message) => {
    const fixture = makePluginFixture(versions);
    const result = runPlugin(fixture);

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toContain(message);
    expect(result.probe.aliases).toEqual([false, false]);
    expectOfficialSourcesUnchanged(fixture);
  });

  it.each([
    ["native profile", "native"],
    ["bootstrap", "bootstrap"],
  ] as const)("rejects drifted %s source without changing either wheel file", (_label, target) => {
    const drift = "# drift\n";
    const nativeSource =
      target === "native" ? NATIVE_PROFILE_SOURCE + drift : NATIVE_PROFILE_SOURCE;
    const bootstrapSource = target === "bootstrap" ? BOOTSTRAP_SOURCE + drift : BOOTSTRAP_SOURCE;
    const fixture = makePluginFixture({
      nativeProfileSource: nativeSource,
      bootstrapSource,
    });
    const result = runPlugin(fixture);

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toMatch(/does not match the reviewed Deep Agents/i);
    expect(result.probe.aliases).toEqual([false, false]);
    expectOfficialSourcesUnchanged(fixture, nativeSource, bootstrapSource);
  });

  it.each([
    ["missing", (sourcePath: string) => fs.rmSync(sourcePath)],
    [
      "linked",
      (sourcePath: string) => {
        fs.rmSync(sourcePath);
        fs.symlinkSync("/dev/null", sourcePath);
      },
    ],
  ] as const)("rejects a %s official source file", (_mode, replaceSource) => {
    const fixture = makePluginFixture();
    replaceSource(fixture.nativeProfilePath);

    const result = runPlugin(fixture);

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toMatch(/not a trusted regular file/i);
    expect(result.probe.aliases).toEqual([false, false]);
    expect(fs.readFileSync(fixture.bootstrapPath, "utf8")).toBe(BOOTSTRAP_SOURCE);
  });

  it("rejects a missing canonical profile without creating aliases", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { withCanonical: false });

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toContain("canonical profile");
    expect(result.probe.aliases).toEqual([false, false]);
    expect(result.probe.registryKeys).toEqual([]);
    expectOfficialSourcesUnchanged(fixture);
  });

  it.each([
    "partial",
    "conflict",
  ] as const)("rejects %s managed alias state without further registry changes", (aliasState) => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { aliasState });

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toMatch(/partial|conflict/i);
    expect(result.probe.registryKeys).toHaveLength(aliasState === "partial" ? 2 : 3);
    expectOfficialSourcesUnchanged(fixture);
  });

  it("rolls back the first alias when the second registration fails", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { failKey: MANAGED_MODEL_ALIASES[1] });

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toContain("injected registration failure");
    expect(result.probe.aliases).toEqual([false, false]);
    expect(result.probe.registryKeys).toEqual([CANONICAL_MODEL_SPEC]);
    expectOfficialSourcesUnchanged(fixture);
  });

  it("accepts an already-complete registration without duplicating aliases", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { aliasState: "complete", registerCalls: 2 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.probe.aliases).toEqual([true, true]);
    expect(result.probe.registryKeys).toHaveLength(3);
    expectOfficialSourcesUnchanged(fixture);
  });
});
