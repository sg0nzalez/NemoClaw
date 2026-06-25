// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// We test stopSandboxChannels / stopAll by temporarily replacing the
// compiled resolve-openshell module's export and spying on spawnSync.
// This avoids vi.mock() hoisting issues with CommonJS require chains.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const resolveOpenshellModule = require("../../../dist/lib/adapters/openshell/resolve");

import {
  stopSandboxChannels,
  stopAll,
  GATEWAY_STOP_SCRIPT,
} from "../../../dist/lib/tunnel/services";

// ---------------------------------------------------------------------------
// stopSandboxChannels
// ---------------------------------------------------------------------------

describe("stopSandboxChannels", () => {
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>;
  let originalResolve: typeof resolveOpenshellModule.resolveOpenshell;

  beforeEach(() => {
    originalResolve = resolveOpenshellModule.resolveOpenshell;
    resolveOpenshellModule.resolveOpenshell = vi.fn(() => "/usr/local/bin/openshell");
    // Spy on child_process.spawnSync used by the compiled dist module.
    // The dist code does `require("node:child_process").spawnSync`, so
    // we spy on the same module that the compiled code loaded.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require("node:child_process");
    spawnSyncSpy = vi.spyOn(cp, "spawnSync").mockReturnValue({ status: 0 });
  });

  afterEach(() => {
    resolveOpenshellModule.resolveOpenshell = originalResolve;
    spawnSyncSpy.mockRestore();
  });

  it("uses kubectl via the OpenShell gateway container for privileged shutdown", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: "pod/my-sandbox-0\n" })
      .mockReturnValueOnce({ status: 0 });

    stopSandboxChannels("my-sandbox");

    expect(spawnSyncSpy).toHaveBeenNthCalledWith(
      1,
      "docker",
      [
        "exec",
        "openshell-cluster-nemoclaw",
        "kubectl",
        "get",
        "pods",
        "-n",
        "openshell",
        "-o",
        "name",
      ],
      expect.objectContaining({ timeout: 10000 }),
    );
    expect(spawnSyncSpy).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "exec",
        "openshell-cluster-nemoclaw",
        "kubectl",
        "exec",
        "-n",
        "openshell",
        "-c",
        "agent",
        "pod/my-sandbox-0",
        "--",
        "sh",
        "-lc",
        expect.any(String),
      ],
      expect.objectContaining({ timeout: 20000 }),
    );
    const args = spawnSyncSpy.mock.calls[1][1] as string[];
    const script = args[args.length - 1];
    expect(script).toContain("ps -eo user=,pid=,args=");
    expect(script).toContain("openclaw-gateway");
    expect(script).toContain("kill -TERM $pids");
    expect(script).toContain("kill -KILL $remaining");
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("OpenClaw gateway stopped inside sandbox");
    logSpy.mockRestore();
  });

  it("falls back to openshell sandbox exec when the gateway container is unavailable", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy.mockReturnValueOnce({ status: 1, stdout: "" }).mockReturnValueOnce({ status: 0 });

    stopSandboxChannels("my-sandbox");

    expect(spawnSyncSpy).toHaveBeenNthCalledWith(
      2,
      "/usr/local/bin/openshell",
      ["sandbox", "exec", "--name", "my-sandbox", "--", "sh", "-lc", expect.any(String)],
      expect.objectContaining({ timeout: 20000 }),
    );
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("OpenClaw gateway stopped inside sandbox");
    logSpy.mockRestore();
  });

  it("treats stop script exit 1 (no process matched) as already stopped", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: "pod/my-sandbox-0\n" })
      .mockReturnValueOnce({ status: 1 });

    stopSandboxChannels("my-sandbox");

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("OpenClaw gateway was not running inside sandbox");
    logSpy.mockRestore();
  });

  it("warns when privileged shutdown reports the gateway may still be running", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: "pod/my-sandbox-0\n" })
      .mockReturnValueOnce({ status: 2, stderr: "205" });

    stopSandboxChannels("my-sandbox");

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Could not stop in-sandbox gateway");
    expect(output).toContain("gateway may still be running");
    expect(output).toContain("205");
    logSpy.mockRestore();
  });

  it("warns when spawn returns null status (timeout)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: "pod/my-sandbox-0\n" })
      .mockReturnValueOnce({ status: null });

    stopSandboxChannels("my-sandbox");

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Could not stop in-sandbox gateway");
    logSpy.mockRestore();
  });

  it("warns when privileged shutdown is unavailable and openshell is not found", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    resolveOpenshellModule.resolveOpenshell = vi.fn(() => null);
    spawnSyncSpy.mockReturnValueOnce({ status: 1, stdout: "" });

    stopSandboxChannels("my-sandbox");

    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("openshell not found");
    logSpy.mockRestore();
  });

  it("uses --name flag for fallback sandbox selection (not positional)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy.mockReturnValueOnce({ status: 1, stdout: "" }).mockReturnValueOnce({ status: 0 });

    stopSandboxChannels("my-sandbox");

    const args = spawnSyncSpy.mock.calls[1][1] as string[];
    expect(args[1]).toBe("exec");
    expect(args[2]).toBe("--name");
    expect(args[3]).toBe("my-sandbox");
    logSpy.mockRestore();
  });

  it("targets both launcher and re-exec'd gateway process forms", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: "pod/my-sandbox-0\n" })
      .mockReturnValueOnce({ status: 0 });

    stopSandboxChannels("my-sandbox");

    const args = spawnSyncSpy.mock.calls[1][1] as string[];
    const script = args[args.length - 1];
    // Must match all three gateway argv forms: the launcher
    // ("openclaw gateway run"), the re-exec'd binary ("openclaw-gateway"),
    // and the post-startup form where OpenClaw rewrites argv to a bare
    // "openclaw" via process.title (#4951).
    expect(script).toContain("openclaw-gateway");
    expect(script).toContain("openclaw[[:space:]]+gateway");
    expect(script).toContain("openclaw[[:space:]]*$");
    logSpy.mockRestore();
  });

  it("rejects malformed sandbox names before spawning docker or openshell", () => {
    expect(() => stopSandboxChannels("../escape")).toThrow("Invalid sandbox name");
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GATEWAY_STOP_SCRIPT — executed end-to-end against real processes.
//
// Linux-only: relies on `ps -eo args=`, awk, and POSIX signals. CI runs on
// Linux. These tests spawn fake processes that reproduce each gateway argv
// form and assert the script finds and kills them (and leaves non-gateway
// processes alone). This is the real guard for #4951: the bare "openclaw"
// process (argv rewritten via process.title) must be detected and stopped.
// ---------------------------------------------------------------------------

describe("GATEWAY_STOP_SCRIPT (executed)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require("node:child_process");
  const children: Array<{ pid?: number }> = [];

  afterEach(() => {
    const pids = children
      .splice(0)
      .map((child) => child.pid)
      .filter((pid): pid is number => pid !== undefined);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  // Spawn a long-lived process with a chosen argv[0]. `cat` takes no arguments,
  // so argv stays exactly `title`; an open (unwritten) stdin pipe keeps it
  // blocked and alive until the stop script signals it. A /dev/null stdin
  // ("ignore") would hit EOF and exit immediately, so use a pipe.
  function spawnWithArgv0(title: string): number {
    const child = cp.spawn("bash", ["-c", `exec -a '${title}' cat`], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    children.push(child);
    assert(child.pid, `failed to spawn process with argv0 ${title}`);
    return child.pid;
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function runStopScript(script = GATEWAY_STOP_SCRIPT): number {
    const result = cp.spawnSync("sh", ["-lc", script], {
      encoding: "utf-8",
      timeout: 20000,
    });
    assert(result.status !== null, `stop script did not exit: ${result.signal} ${result.stderr}`);
    return result.status;
  }

  function stopScriptWithGatewayIdentity(
    pid: number,
    mode = 0o600,
    pidContent = `${pid}\n`,
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "nemoclaw-gateway-stop-identity-"));
    const pidFile = join(dir, "nemoclaw-gateway.pid");
    const markerFile = join(dir, "nemoclaw-gateway-local");
    writeFileSync(pidFile, pidContent, { mode });
    writeFileSync(markerFile, "", { mode });
    chmodSync(pidFile, mode);
    chmodSync(markerFile, mode);
    return GATEWAY_STOP_SCRIPT.replaceAll("/tmp/nemoclaw-gateway.pid", pidFile)
      .replaceAll("/tmp/nemoclaw-gateway-local", markerFile)
      .replace(
        'allowed_bare_users="gateway,sandbox"',
        `allowed_bare_users="gateway,sandbox,${process.env.USER ?? ""}"`,
      )
      .replace(
        'trusted_identity_owners="root,gateway,sandbox"',
        `trusted_identity_owners="root,gateway,sandbox,${process.env.USER ?? ""}"`,
      );
  }

  it.runIf(process.platform === "linux")("kills openclaw-gateway argv0 process", async () => {
    const pid = spawnWithArgv0("openclaw-gateway");
    expect(isAlive(pid)).toBe(true);

    expect(runStopScript()).toBe(0);

    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid)).toBe(false);
  });

  it.runIf(process.platform === "linux")("kills openclaw gateway run command form", async () => {
    const pid = spawnWithArgv0("openclaw gateway run");
    expect(isAlive(pid)).toBe(true);

    expect(runStopScript()).toBe(0);

    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid)).toBe(false);
  });

  it.runIf(process.platform === "linux")(
    "finds and kills a gateway whose argv was rewritten to bare 'openclaw' (#4951)",
    async () => {
      const pid = spawnWithArgv0("openclaw");
      expect(isAlive(pid)).toBe(true);

      expect(runStopScript(stopScriptWithGatewayIdentity(pid))).toBe(0);

      // Give the kernel a moment to reap after SIGTERM.
      await new Promise((r) => setTimeout(r, 300));
      expect(isAlive(pid)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "exits 1 (not running) and spares a bare openclaw process without gateway identity",
    () => {
      const decoy = spawnWithArgv0("openclaw");

      expect(runStopScript()).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "exits 1 (not running) and spares bare openclaw when gateway identity files are unsafe",
    () => {
      const decoy = spawnWithArgv0("openclaw");

      expect(runStopScript(stopScriptWithGatewayIdentity(decoy, 0o644))).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects malformed gateway pid file contents instead of digit-stripping to another PID",
    () => {
      const decoy = spawnWithArgv0("openclaw");

      expect(runStopScript(stopScriptWithGatewayIdentity(decoy, 0o600, `x${decoy}y\n`))).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "exits 1 (not running) and spares non-gateway processes",
    () => {
      // A process whose name merely starts with "openclaw" must not match.
      const decoy = spawnWithArgv0("openclawish");

      expect(runStopScript()).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// stopAll — sandbox channel integration
// ---------------------------------------------------------------------------

describe("stopAll with sandbox channels", () => {
  let pidDir: string;
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>;
  let originalResolve: typeof resolveOpenshellModule.resolveOpenshell;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-sandbox-test-"));
    originalResolve = resolveOpenshellModule.resolveOpenshell;
    resolveOpenshellModule.resolveOpenshell = vi.fn(() => "/usr/local/bin/openshell");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require("node:child_process");
    spawnSyncSpy = vi.spyOn(cp, "spawnSync").mockReturnValue({ status: 0 });
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
    resolveOpenshellModule.resolveOpenshell = originalResolve;
    spawnSyncSpy.mockRestore();
  });

  it("stops in-sandbox channels when sandboxName is provided", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: "pod/test-sb-0\n" })
      .mockReturnValueOnce({ status: 0 });

    stopAll({ pidDir, sandboxName: "test-sb" });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["kubectl", "exec", "-n", "openshell", "-c", "agent"]),
      expect.any(Object),
    );
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("OpenClaw gateway stopped");
    expect(output).toContain("All services stopped");
    logSpy.mockRestore();
  });

  it("warns when no sandbox name is available", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedNemoclaw = process.env.NEMOCLAW_SANDBOX;
    const savedNemoclawName = process.env.NEMOCLAW_SANDBOX_NAME;
    const savedSandbox = process.env.SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.SANDBOX_NAME;

    try {
      stopAll({ pidDir });
    } finally {
      if (savedNemoclaw !== undefined) process.env.NEMOCLAW_SANDBOX = savedNemoclaw;
      if (savedNemoclawName !== undefined) process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawName;
      if (savedSandbox !== undefined) process.env.SANDBOX_NAME = savedSandbox;
    }

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No sandbox name available");
    expect(output).toContain("All services stopped");
    logSpy.mockRestore();
  });

  it("still stops cloudflared even when sandbox exec fails", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    spawnSyncSpy.mockReturnValue({ status: 255 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir, sandboxName: "test-sb" });
    logSpy.mockRestore();

    // cloudflared PID file should be cleaned up regardless
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
  });

  it("reads sandbox name from NEMOCLAW_SANDBOX env when not in opts", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const saved = process.env.NEMOCLAW_SANDBOX;
    process.env.NEMOCLAW_SANDBOX = "env-sandbox";

    try {
      stopAll({ pidDir });
    } finally {
      if (saved !== undefined) {
        process.env.NEMOCLAW_SANDBOX = saved;
      } else {
        delete process.env.NEMOCLAW_SANDBOX;
      }
    }

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      expect.arrayContaining(["env-sandbox"]),
      expect.any(Object),
    );
    logSpy.mockRestore();
  });

  it("reads sandbox name from NEMOCLAW_SANDBOX_NAME when NEMOCLAW_SANDBOX is unset", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedNemoclaw = process.env.NEMOCLAW_SANDBOX;
    const savedNemoclawName = process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    process.env.NEMOCLAW_SANDBOX_NAME = "named-sandbox";

    try {
      stopAll({ pidDir });
    } finally {
      if (savedNemoclaw !== undefined) {
        process.env.NEMOCLAW_SANDBOX = savedNemoclaw;
      } else {
        delete process.env.NEMOCLAW_SANDBOX;
      }
      if (savedNemoclawName !== undefined) {
        process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawName;
      } else {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      }
    }

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      expect.arrayContaining(["named-sandbox"]),
      expect.any(Object),
    );
    logSpy.mockRestore();
  });

  it("prefers NEMOCLAW_SANDBOX_NAME over NEMOCLAW_SANDBOX (consistent with resolveDefaultSandboxName)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedNemoclaw = process.env.NEMOCLAW_SANDBOX;
    const savedNemoclawName = process.env.NEMOCLAW_SANDBOX_NAME;
    const savedSandbox = process.env.SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "name-sandbox";
    process.env.NEMOCLAW_SANDBOX = "other-sandbox";
    delete process.env.SANDBOX_NAME;

    try {
      stopAll({ pidDir });
    } finally {
      if (savedNemoclaw !== undefined) process.env.NEMOCLAW_SANDBOX = savedNemoclaw;
      else delete process.env.NEMOCLAW_SANDBOX;
      if (savedNemoclawName !== undefined) process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawName;
      else delete process.env.NEMOCLAW_SANDBOX_NAME;
      if (savedSandbox !== undefined) process.env.SANDBOX_NAME = savedSandbox;
      else delete process.env.SANDBOX_NAME;
    }

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      expect.arrayContaining(["name-sandbox"]),
      expect.any(Object),
    );
    logSpy.mockRestore();
  });

  it("uses the effective env-selected sandbox for sandbox cleanup with explicit host pidDir", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedNemoclaw = process.env.NEMOCLAW_SANDBOX;
    const savedNemoclawName = process.env.NEMOCLAW_SANDBOX_NAME;
    const savedSandbox = process.env.SANDBOX_NAME;
    const pidRoot = mkdtempSync(join(tmpdir(), "nemoclaw-services-pid-root-"));
    const effectivePidDir = join(pidRoot, "nemoclaw-services-name-sandbox");
    const lowerPriorityPidDir = join(pidRoot, "nemoclaw-services-other-sandbox");
    rmSync(effectivePidDir, { recursive: true, force: true });
    rmSync(lowerPriorityPidDir, { recursive: true, force: true });
    mkdirSync(effectivePidDir, { recursive: true, mode: 0o700 });
    mkdirSync(lowerPriorityPidDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(effectivePidDir, "cloudflared.pid"), "999999999");
    writeFileSync(join(lowerPriorityPidDir, "cloudflared.pid"), "999999999");
    process.env.NEMOCLAW_SANDBOX_NAME = "name-sandbox";
    process.env.NEMOCLAW_SANDBOX = "other-sandbox";
    delete process.env.SANDBOX_NAME;

    try {
      stopAll({ pidDir: effectivePidDir });

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        "/usr/local/bin/openshell",
        expect.arrayContaining(["name-sandbox"]),
        expect.any(Object),
      );
      expect(existsSync(join(effectivePidDir, "cloudflared.pid"))).toBe(false);
      expect(existsSync(join(lowerPriorityPidDir, "cloudflared.pid"))).toBe(true);
    } finally {
      if (savedNemoclaw !== undefined) process.env.NEMOCLAW_SANDBOX = savedNemoclaw;
      else delete process.env.NEMOCLAW_SANDBOX;
      if (savedNemoclawName !== undefined) process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawName;
      else delete process.env.NEMOCLAW_SANDBOX_NAME;
      if (savedSandbox !== undefined) process.env.SANDBOX_NAME = savedSandbox;
      else delete process.env.SANDBOX_NAME;
      rmSync(pidRoot, { recursive: true, force: true });
      logSpy.mockRestore();
    }
  });

  it("rejects malformed env var sandbox names before calling stopSandboxChannels", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedNemoclaw = process.env.NEMOCLAW_SANDBOX;
    const savedNemoclawName = process.env.NEMOCLAW_SANDBOX_NAME;
    const savedSandbox = process.env.SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    process.env.NEMOCLAW_SANDBOX_NAME = "bad name";
    delete process.env.SANDBOX_NAME;

    try {
      stopAll({ pidDir });
    } finally {
      if (savedNemoclaw !== undefined) process.env.NEMOCLAW_SANDBOX = savedNemoclaw;
      else delete process.env.NEMOCLAW_SANDBOX;
      if (savedNemoclawName !== undefined) process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawName;
      else delete process.env.NEMOCLAW_SANDBOX_NAME;
      if (savedSandbox !== undefined) process.env.SANDBOX_NAME = savedSandbox;
      else delete process.env.SANDBOX_NAME;
    }

    // Should NOT have called openshell sandbox exec with the bad name
    expect(spawnSyncSpy).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Invalid sandbox name");
    expect(output).toContain("All services stopped");
    logSpy.mockRestore();
  });

  it("rejects path-traversal sandbox names from env vars", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedNemoclaw = process.env.NEMOCLAW_SANDBOX;
    const savedNemoclawName = process.env.NEMOCLAW_SANDBOX_NAME;
    const savedSandbox = process.env.SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    process.env.NEMOCLAW_SANDBOX_NAME = "../../etc/passwd";
    delete process.env.SANDBOX_NAME;

    try {
      stopAll({ pidDir });
    } finally {
      if (savedNemoclaw !== undefined) process.env.NEMOCLAW_SANDBOX = savedNemoclaw;
      else delete process.env.NEMOCLAW_SANDBOX;
      if (savedNemoclawName !== undefined) process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawName;
      else delete process.env.NEMOCLAW_SANDBOX_NAME;
      if (savedSandbox !== undefined) process.env.SANDBOX_NAME = savedSandbox;
      else delete process.env.SANDBOX_NAME;
    }

    expect(spawnSyncSpy).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Invalid sandbox name");
    logSpy.mockRestore();
  });
});
