// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execSandbox } = vi.hoisted(() => ({ execSandbox: vi.fn() }));

vi.mock("../adapters/openshell/sandbox-control-routing.js", () => ({
  execSandboxReadOnlyWithGrpcFallback: execSandbox,
}));

vi.mock("../adapters/openshell/client.js", () => ({
  parseVersionFromText: (value = "") => {
    const match = String(value).match(/([0-9]+\.[0-9]+\.[0-9]+)/);
    return match ? match[1] : null;
  },
  versionGte: (left = "0.0.0", right = "0.0.0") => {
    const lhs = String(left)
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
    const rhs = String(right)
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
    const length = Math.max(lhs.length, rhs.length);
    for (let i = 0; i < length; i++) {
      const a = lhs[i] || 0;
      const b = rhs[i] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return true;
  },
}));

const { EXPECTED_VERSION_BY_AGENT } = vi.hoisted(() => ({
  EXPECTED_VERSION_BY_AGENT: {
    openclaw: "2026.5.27",
    "hermes-calendar-pin": "2026.6.19",
    "high-major-semver": "999.9.9",
    "low-year-semver": "2010.0.0",
  } as Record<string, string>,
}));

vi.mock("../agent/defs.js", () => ({
  loadAgent: vi.fn((name: string) => ({
    name,
    displayName: name === "openclaw" ? "OpenClaw" : "Hermes Agent",
    versionCommand: name === "openclaw" ? "openclaw --version" : "hermes --version",
    expectedVersion: EXPECTED_VERSION_BY_AGENT[name] ?? "0.17.0",
    stateDirs: [],
    configPaths: { dir: "/sandbox/.openclaw" },
  })),
}));

// state/registry captures the registry path at module scope, so HOME must be
// redirected before it loads. Static ESM imports are hoisted above this
// assignment, hence the dynamic imports below; reassigning HOME from
// beforeEach() would be too late and every registerSandbox() would land in the
// developer's real ~/.nemoclaw/sandboxes.json (#6553).
const TEST_HOME = mkdtempSync(join(tmpdir(), "sandbox-ver-test-"));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

const registry = await import("../state/registry.js");
const { checkAgentVersion, formatStalenessWarning } = await import("./version.js");

const TEST_REGISTRY_FILE = join(TEST_HOME, ".nemoclaw", "sandboxes.json");

function resetTestRegistry(): void {
  mkdirSync(dirname(TEST_REGISTRY_FILE), { recursive: true });
  writeFileSync(TEST_REGISTRY_FILE, JSON.stringify({ sandboxes: {}, defaultSandbox: null }));
}

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("registry isolation", () => {
  it("resolves the registry inside the test HOME, never the real one (#6553)", async () => {
    expect(registry.REGISTRY_FILE).toBe(TEST_REGISTRY_FILE);
    expect(registry.REGISTRY_FILE.startsWith(TEST_HOME)).toBe(true);
  });
});

describe("checkAgentVersion", () => {
  beforeEach(() => {
    resetTestRegistry();
    execSandbox.mockReset().mockResolvedValue({ status: 1, stdout: "", stderr: "failed" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fast path: uses cached agentVersion from registry", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.27",
    });

    const result = await checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.isStale).toBe(false);
  });

  it("fast path: detects stale version from registry", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.3.11",
    });

    const result = await checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.3.11");
    expect(result.isStale).toBe(true);
  });

  it("fast path: same version is not stale", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.27",
    });

    const result = await checkAgentVersion("test-sb");
    expect(result.isStale).toBe(false);
  });

  it("slow path: probes through sandbox exec when no cached version", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null, gatewayPort: 19080 });

    execSandbox.mockResolvedValue({
      status: 0,
      stdout: "OpenClaw 2026.5.27 (abc123)\n",
      stderr: "",
    });

    const result = await checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("sandbox-exec");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.isStale).toBe(false);
    expect(execSandbox).toHaveBeenCalledWith("nemoclaw-19080", {
      sandboxName: "test-sb",
      command: ["sh", "-c", "openclaw --version"],
      maxOutputBytes: 64 * 1024,
      timeoutMs: 15_000,
    });

    // Should have cached the version in registry
    const updated = registry.getSandbox("test-sb");
    expect(updated?.agentVersion).toBe("2026.5.27");
  });

  it("returns an unknown verdict when sandbox exec fails so callers do not read isStale as verified current", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    const result = await checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("unknown");
    expect(result.unavailableReason).toBe("probe-failed");
    expect(result.isStale).toBe(false);
  });

  it("treats a returned sandbox exec error as an unknown probe without caching output", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null, gatewayPort: 19080 });
    execSandbox.mockResolvedValue({
      status: null,
      stdout: "OpenClaw 2026.5.27\n",
      stderr: "",
      error: new Error("output limit exceeded"),
    });

    const result = await checkAgentVersion("test-sb");

    expect(result.detectionMethod).toBe("unknown");
    expect(result.unavailableReason).toBe("probe-failed");
    expect(registry.getSandbox("test-sb")?.agentVersion).toBeNull();
  });

  it("can skip live probing when no cached version is available", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    const result = await checkAgentVersion("test-sb", { skipProbe: true });

    expect(result.detectionMethod).toBe("unavailable");
    expect(result.sandboxVersion).toBeNull();
    expect(result.isStale).toBe(false);
    expect(execSandbox).not.toHaveBeenCalled();
  });

  it("force probe bypasses cached version", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.3.11",
    });

    execSandbox.mockResolvedValue({
      status: 0,
      stdout: "OpenClaw 2026.5.27 (abc123)\n",
      stderr: "",
    });

    const result = await checkAgentVersion("test-sb", { forceProbe: true });
    expect(result.detectionMethod).toBe("sandbox-exec");
    expect(result.sandboxVersion).toBe("2026.5.27");
  });

  it("force probe returns unknown when the live probe fails so cached metadata cannot silently mask drift", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.18",
    });

    const result = await checkAgentVersion("test-sb", { forceProbe: true });

    expect(result.detectionMethod).toBe("unknown");
    expect(result.unavailableReason).toBe("probe-failed");
    expect(result.sandboxVersion).toBeNull();
    expect(result.isStale).toBe(false);
    expect(execSandbox).toHaveBeenCalledOnce();
  });

  it("does not flag an update for a hermes runtime that matches the expected semver", async () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes",
      agentVersion: "0.17.0",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.isStale).toBe(false);
  });

  it("flags a hermes runtime that is behind the expected semver", async () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes",
      agentVersion: "0.16.9",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.sandboxVersion).toBe("0.16.9");
    expect(result.isStale).toBe(true);
  });

  it("flags a scheme-mismatched cached version as stale so the rebuild flow realigns runtime and manifest (#6049)", async () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes-calendar-pin",
      agentVersion: "0.17.0",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("treats a semver with a four-digit major that does not start with 20 as semver, not calendar (#6049)", async () => {
    registry.registerSandbox({
      name: "high-major-sb",
      agent: "high-major-semver",
      agentVersion: "1000.0.0",
    });

    const result = await checkAgentVersion("high-major-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("1000.0.0");
    expect(result.verificationFailed).toBe(false);
    expect(result.isStale).toBe(false);
  });

  it("flags a same-scheme semver when the sandbox trails a four-digit-major expected pin (#6049)", async () => {
    registry.registerSandbox({
      name: "high-major-sb",
      agent: "high-major-semver",
      agentVersion: "999.9.8",
    });

    const result = await checkAgentVersion("high-major-sb");
    expect(result.verificationFailed).toBe(false);
    expect(result.isStale).toBe(true);
  });

  it("treats a semver with a pre-2020 four-digit major as semver, not calendar (#6049)", async () => {
    registry.registerSandbox({
      name: "low-year-sb",
      agent: "low-year-semver",
      agentVersion: "2010.0.0",
    });

    const result = await checkAgentVersion("low-year-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2010.0.0");
    expect(result.schemeMismatch).toBeFalsy();
    expect(result.isStale).toBe(false);
  });

  it("without a manifest version_scheme, falls back to shape classification so a matching-shape cached value is treated as current (#6049)", async () => {
    registry.registerSandbox({ name: "openclaw-sb", agent: null, agentVersion: "2026.5.27" });

    const result = await checkAgentVersion("openclaw-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.schemeMismatch).toBeFalsy();
    expect(result.isStale).toBe(false);
  });

  it("flags a calendar-manifest agent with a semver runtime as scheme-mismatched and stale (#6049)", async () => {
    registry.registerSandbox({ name: "openclaw-sb", agent: "openclaw", agentVersion: "1.2.3" });

    const result = await checkAgentVersion("openclaw-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("1.2.3");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("emits a structured JSON payload to stderr when a scheme mismatch is detected (#6049)", async () => {
    registry.registerSandbox({
      name: "hermes-warn-sb",
      agent: "hermes-calendar-pin",
      agentVersion: "0.17.0",
    });

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      await checkAgentVersion("hermes-warn-sb");
    } finally {
      process.stderr.write = originalWrite;
    }

    const line = stderrChunks.join("");
    const jsonStart = line.indexOf("{");
    const payload = JSON.parse(line.slice(jsonStart).trim());
    expect(payload).toEqual({
      event: "sandbox_version_scheme_mismatch",
      sandbox: "hermes-warn-sb",
      sandboxVersion: "0.17.0",
      expectedVersion: "2026.6.19",
      action: "flagged_as_stale",
    });
  });

  it("flags a scheme mismatch discovered during a sandbox probe as stale (#6049)", async () => {
    registry.registerSandbox({ name: "hermes-sb", agent: "hermes-calendar-pin" });

    execSandbox.mockResolvedValue({
      status: 0,
      stdout: "hermes 0.17.0\n",
      stderr: "",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("sandbox-exec");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("surfaces the reason when checkAgentVersion cannot inspect the sandbox", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    const result = await checkAgentVersion("test-sb", { skipProbe: true });

    expect(result.detectionMethod).toBe("unavailable");
    expect(result.unavailableReason).toBe("skip-probe");
  });

  it("probes a hermes runtime through sandbox exec and does not flag a matching semver", async () => {
    registry.registerSandbox({ name: "hermes-sb", agent: "hermes" });

    execSandbox.mockResolvedValue({
      status: 0,
      stdout: "hermes 0.17.0\n",
      stderr: "",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("sandbox-exec");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.isStale).toBe(false);
  });
});

describe("formatStalenessWarning", () => {
  beforeEach(() => {
    resetTestRegistry();
    registry.registerSandbox({ name: "my-sb", agent: null });
  });

  it("includes sandbox name, versions, and rebuild hint", async () => {
    const lines = formatStalenessWarning("my-sb", {
      sandboxVersion: "2026.3.11",
      expectedVersion: "2026.5.27",
      isStale: true,
      verificationFailed: false,
      detectionMethod: "registry",
    });
    const joined = lines.join("\n");
    expect(joined).toContain("my-sb");
    expect(joined).toContain("2026.3.11");
    expect(joined).toContain("2026.5.27");
    expect(joined).toContain("rebuild");
  });
});
