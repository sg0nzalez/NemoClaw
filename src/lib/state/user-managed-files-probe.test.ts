// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const execReadOnly = vi.hoisted(() => vi.fn());
const getSandbox = vi.hoisted(() => vi.fn());
const loadAgent = vi.hoisted(() => vi.fn());

vi.mock("../adapters/openshell/sandbox-control-routing.js", () => ({
  execSandboxReadOnlyWithGrpcFallback: execReadOnly,
}));
vi.mock("./registry.js", () => ({ getSandbox }));
vi.mock("../agent/defs.js", () => ({ loadAgent }));

import { probeUserManagedFiles, USER_MANAGED_FILES_BASE } from "./user-managed-files-probe";

describe("probeUserManagedFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSandbox.mockReturnValue({
      name: "alpha",
      agent: "fake-agent",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
    });
    loadAgent.mockReturnValue({ userManagedFiles: [".env", ".mcp.json"] });
    execReadOnly.mockResolvedValue({
      status: 0,
      stdout: ".env\n.mcp.json\n",
      stderr: "",
    });
  });

  it("probes declared files at the sandbox root through the named gateway", async () => {
    await expect(probeUserManagedFiles("alpha")).resolves.toEqual({
      declared: [".env", ".mcp.json"],
      existing: [".env", ".mcp.json"],
    });

    expect(USER_MANAGED_FILES_BASE).toBe("/sandbox");
    expect(execReadOnly).toHaveBeenCalledWith("nemoclaw-9090", {
      sandboxName: "alpha",
      command: [
        "sh",
        "-c",
        "if [ -f '/sandbox/.env' ]; then printf '%s\\n' '.env'; fi; if [ -f '/sandbox/.mcp.json' ]; then printf '%s\\n' '.mcp.json'; fi 2>/dev/null",
      ],
      timeoutMs: 30_000,
    });
  });

  it("supports nested and shell-quoted declared paths", async () => {
    loadAgent.mockReturnValue({ userManagedFiles: [".hermes/.env", "user's.env"] });
    execReadOnly.mockResolvedValue({ status: 0, stdout: ".hermes/.env\n", stderr: "" });

    const result = await probeUserManagedFiles("alpha");

    expect(result.existing).toEqual([".hermes/.env"]);
    const command = execReadOnly.mock.calls[0]?.[1].command[2] as string;
    expect(command).toContain("'/sandbox/.hermes/.env'");
    expect(command).toContain("'/sandbox/user'\\''s.env'");
  });

  it("returns no existing files for an empty successful response", async () => {
    execReadOnly.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

    await expect(probeUserManagedFiles("alpha")).resolves.toEqual({
      declared: [".env", ".mcp.json"],
      existing: [],
    });
  });

  it("throws with bounded diagnostics when the probe cannot produce output", async () => {
    execReadOnly.mockResolvedValue({
      status: null,
      stdout: "",
      stderr: "connection refused",
      error: new Error("UNAVAILABLE"),
    });

    await expect(probeUserManagedFiles("alpha")).rejects.toThrow(
      "user-managed file probe failed: connection refused",
    );
  });

  it("preserves partial successful output from a nonzero remote command", async () => {
    execReadOnly.mockResolvedValue({ status: 1, stdout: ".env\n", stderr: "partial" });

    await expect(probeUserManagedFiles("alpha")).resolves.toEqual({
      declared: [".env", ".mcp.json"],
      existing: [".env"],
    });
  });

  it("skips the control plane when the agent declares no user-managed files", async () => {
    loadAgent.mockReturnValue({ userManagedFiles: [] });

    await expect(probeUserManagedFiles("alpha")).resolves.toEqual({
      declared: [],
      existing: [],
    });
    expect(execReadOnly).not.toHaveBeenCalled();
  });
});
