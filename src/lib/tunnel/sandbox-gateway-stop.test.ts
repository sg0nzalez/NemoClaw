// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import type { SandboxEntry } from "../state/registry";
import { type SandboxGatewayStopDeps, stopSandboxChannels } from "./sandbox-gateway-stop";

function spawnResult(status: number | null, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

function registeredAgent(
  values: Partial<AgentDefinition> & Pick<AgentDefinition, "name" | "displayName">,
): AgentDefinition {
  return values as AgentDefinition;
}

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

function harness() {
  const getSandbox = vi.fn<NonNullable<SandboxGatewayStopDeps["getSandbox"]>>(() => sandbox());
  const getRegisteredAgent = vi.fn<NonNullable<SandboxGatewayStopDeps["getRegisteredAgent"]>>(
    () => null,
  );
  const resolveOpenshell = vi.fn<NonNullable<SandboxGatewayStopDeps["resolveOpenshell"]>>(
    () => "/usr/local/bin/openshell",
  );
  const runProcess = vi.fn<NonNullable<SandboxGatewayStopDeps["runProcess"]>>(() => spawnResult(0));
  const info = vi.fn<(message: string) => void>();
  const warn = vi.fn<(message: string) => void>();
  const deps: SandboxGatewayStopDeps = {
    getSandbox,
    getRegisteredAgent,
    resolveOpenshell,
    runProcess,
    info,
    warn,
  };
  return {
    deps,
    getRegisteredAgent,
    getSandbox,
    info,
    resolveOpenshell,
    runProcess,
    warn,
  };
}

describe("stopSandboxChannels", () => {
  it("uses gateway-scoped openshell sandbox exec through stdin", () => {
    const h = harness();

    stopSandboxChannels("my-sandbox", h.deps);

    expect(h.runProcess).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      ["sandbox", "exec", "--name", "my-sandbox", "--gateway", "nemoclaw", "--", "sh", "-s"],
      expect.objectContaining({
        input: expect.stringContaining("find_gateway_pids"),
        timeout: 20000,
      }),
    );
  });

  it("treats stop script exit 1 as already stopped", () => {
    const h = harness();
    h.runProcess.mockReturnValueOnce(spawnResult(1));

    stopSandboxChannels("my-sandbox", h.deps);

    expect(h.info).toHaveBeenCalledWith("OpenClaw gateway was not running inside sandbox.");
  });

  it("does not transiently kill a supervisor-managed Hermes gateway (#6392)", () => {
    const h = harness();
    const hermes = registeredAgent({
      name: "hermes",
      displayName: "Hermes Agent",
      gateway_command: "hermes gateway run",
      forward_ports: [18789, 8642],
    });
    h.getSandbox.mockReturnValue(sandbox({ agent: "hermes" }));
    h.getRegisteredAgent.mockReturnValue(hermes);

    stopSandboxChannels("my-sandbox", h.deps);

    expect(h.runProcess).not.toHaveBeenCalled();
    expect(h.info.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Hermes Agent gateway is managed by the sandbox",
    );
  });

  it("does not treat a terminal agent command as a gateway process", () => {
    const h = harness();
    const terminal = registeredAgent({
      name: "langchain-deepagents-code",
      displayName: "LangChain Deep Agents Code",
      runtime: {
        kind: "terminal",
        interactive_command: "dcode",
        headless_command: "dcode -n",
      },
    });
    h.getSandbox.mockReturnValue(sandbox({ agent: "langchain-deepagents-code" }));
    h.getRegisteredAgent.mockReturnValue(terminal);

    stopSandboxChannels("dcode-sandbox", h.deps);

    expect(h.runProcess).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(
      "LangChain Deep Agents Code has no gateway runtime; skipping in-sandbox gateway stop.",
    );
  });

  it("uses the default OpenClaw contract when the target registry row is missing", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(null);

    stopSandboxChannels("openclaw-target", h.deps);

    expect(h.getRegisteredAgent).toHaveBeenCalledWith(null);
    expect(h.runProcess).toHaveBeenCalledTimes(1);
    expect(h.info.mock.calls.map((call) => call[0]).join("\n")).not.toContain("Hermes Agent");
  });

  it("fails closed when the sandbox registry cannot be read", () => {
    const h = harness();
    h.getSandbox.mockImplementation(() => {
      throw new Error("invalid registry data");
    });

    expect(() => stopSandboxChannels("my-sandbox", h.deps)).not.toThrow();

    expect(h.getRegisteredAgent).not.toHaveBeenCalled();
    expect(h.runProcess).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read the sandbox registry for 'my-sandbox'"),
    );
  });

  it("fails closed when the persisted gateway binding is invalid", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ agent: "openclaw", gatewayPort: 0 }));

    stopSandboxChannels("my-sandbox", h.deps);

    expect(h.resolveOpenshell).not.toHaveBeenCalled();
    expect(h.runProcess).not.toHaveBeenCalled();
    expect(h.warn.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Invalid persisted sandbox gateway binding",
    );
  });

  it("fails closed when a registered non-OpenClaw agent cannot be loaded", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ agent: "missing-agent" }));

    stopSandboxChannels("my-sandbox", h.deps);

    expect(h.runProcess).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve registered agent 'missing-agent'"),
    );
  });

  it("warns when sandbox exec reports the gateway may still be running", () => {
    const h = harness();
    h.runProcess.mockReturnValueOnce(spawnResult(2, "", "205"));

    stopSandboxChannels("my-sandbox", h.deps);

    const output = h.warn.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("Could not stop OpenClaw gateway inside sandbox");
    expect(output).toContain("gateway may still be running");
    expect(output).toContain("205");
  });

  it("warns when spawn returns null status", () => {
    const h = harness();
    h.runProcess.mockReturnValueOnce(spawnResult(null));

    stopSandboxChannels("my-sandbox", h.deps);

    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("exit unknown"));
  });

  it("warns when openshell is not found", () => {
    const h = harness();
    h.resolveOpenshell.mockReturnValue(null);

    stopSandboxChannels("my-sandbox", h.deps);

    expect(h.runProcess).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      "openshell not found — cannot stop OpenClaw gateway inside sandbox.",
    );
  });

  it("routes shutdown through the sandbox's persisted non-default gateway", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ gatewayName: "nemoclaw-18080", gatewayPort: 18080 }));

    stopSandboxChannels("my-sandbox", h.deps);

    expect(h.runProcess).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      expect.arrayContaining(["--gateway", "nemoclaw-18080"]),
      expect.any(Object),
    );
  });

  it("targets launcher, re-exec, and identity-guarded bare gateway forms", () => {
    const h = harness();

    stopSandboxChannels("my-sandbox", h.deps);

    const script = String(h.runProcess.mock.calls[0][2].input);
    expect(script).toContain("openclaw-gateway");
    expect(script).toContain("openclaw[[:space:]]+gateway");
    expect(script).toContain("openclaw[[:space:]]*$");
    expect(script).toContain("identity_files_trusted");
  });

  it("rejects malformed sandbox names before any spawn", () => {
    const h = harness();

    expect(() => stopSandboxChannels("../escape", h.deps)).toThrow("Invalid sandbox name");
    expect(h.getSandbox).not.toHaveBeenCalled();
    expect(h.runProcess).not.toHaveBeenCalled();
  });
});
