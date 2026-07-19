// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareMcpForRebuild: vi.fn(),
  reattachMcpAfterDeleteFailure: vi.fn(),
  warnUnpreservedUserManagedFiles: vi.fn(),
  runOpenshell: vi.fn(
    (): {
      status: number | null;
      stdout: string;
      stderr: string;
      error?: NodeJS.ErrnoException;
    } => ({ status: 0, stdout: "", stderr: "" }),
  ),
  getSandbox: vi.fn(
    (_name: string): { name: string; agent: string; nimContainer?: string | null } | null => null,
  ),
  listSandboxes: vi.fn(() => ({ sandboxes: [] })),
  removeSandboxRegistryEntryWithReceipt: vi.fn(() => null),
  stopNimContainer: vi.fn(),
  stopNimContainerByName: vi.fn(),
}));

vi.mock("./rebuild-flow-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-flow-helpers")>()),
  warnUnpreservedUserManagedFiles: mocks.warnUnpreservedUserManagedFiles,
}));

vi.mock("./rebuild-mcp-phase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-mcp-phase")>()),
  prepareMcpForRebuild: mocks.prepareMcpForRebuild,
  reattachMcpAfterDeleteFailure: mocks.reattachMcpAfterDeleteFailure,
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("../../inference/nim", () => ({
  stopNimContainer: mocks.stopNimContainer,
  stopNimContainerByName: mocks.stopNimContainerByName,
}));

vi.mock("../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/registry")>()),
  getSandbox: mocks.getSandbox,
  listSandboxes: mocks.listSandboxes,
}));

vi.mock("./destroy", () => ({
  removeSandboxRegistryEntryWithReceipt: mocks.removeSandboxRegistryEntryWithReceipt,
}));

import { runRebuildDestroyPhase } from "./rebuild-destroy-phase";

describe("rebuild destroy validation diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    });
    mocks.reattachMcpAfterDeleteFailure.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains unexpected delete-edge diagnostics without logging credentials (#6195)", async () => {
    const secret = `nvapi-${"a".repeat(32)}`;
    const log = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "langchain-deepagents-code" },
        staleRecovery: false,
        backupManifest: null,
        log,
        bail,
        relockShieldsIfNeeded,
        validateAfterMcpPreparation: async () => {
          throw new Error(`route probe failed with ${secret}`);
        },
        onDeleted: vi.fn(),
      }),
    ).rejects.toThrow("DCode replacement validation failed before sandbox deletion.");

    const diagnostics = log.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("Unexpected DCode replacement validation failure");
    expect(diagnostics).toContain("route probe failed");
    expect(diagnostics).toContain("<REDACTED>");
    expect(diagnostics).not.toContain(secret);
    expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledOnce();
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
  });

  it("passes force=true to prepareMcpForRebuild when input.force is set (#7062)", async () => {
    const log = vi.fn();
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw" },
      staleRecovery: false,
      backupManifest: null,
      force: true,
      log,
      bail,
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted: vi.fn(),
    });

    expect(mocks.prepareMcpForRebuild).toHaveBeenCalledWith(
      "alpha",
      false,
      true,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("refuses sandbox deletion when read-only MCP state drifts at the delete edge (#7062)", async () => {
    const revalidateBeforeDelete = vi.fn().mockRejectedValue(new Error("live policy drifted"));
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{}],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      revalidateBeforeDelete,
    });
    const relockShieldsIfNeeded = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail,
        relockShieldsIfNeeded,
        onDeleted: vi.fn(),
      }),
    ).rejects.toThrow(
      "Failed to revalidate read-only MCP recovery before sandbox deletion: live policy drifted",
    );

    expect(revalidateBeforeDelete).toHaveBeenCalledOnce();
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(mocks.reattachMcpAfterDeleteFailure).not.toHaveBeenCalled();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
  });

  it("retains read-only MCP ownership when sandbox deletion fails (#7062)", async () => {
    const revalidateBeforeDelete = vi.fn().mockResolvedValue(undefined);
    const entry = { server: "github" };
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [entry],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      revalidateBeforeDelete,
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete failed" })
      .mockReturnValueOnce({ status: 0, stdout: "Phase: Ready\n", stderr: "" });
    const onDeleted = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail,
        relockShieldsIfNeeded,
        onDeleted,
      }),
    ).rejects.toThrow("Failed to delete sandbox.");

    expect(revalidateBeforeDelete).toHaveBeenCalledOnce();
    expect(revalidateBeforeDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOpenshell.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledWith("alpha", [], []);
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
    expect(mocks.runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.any(Object),
    );
  });

  it("converges as deleted when a nonzero delete is followed by exact NotFound (#7062)", async () => {
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [{ server: "github" }],
      scrubbedAdapterEntries: [],
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete interrupted" })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: 'status: Internal, message: "sandbox has no spec"',
      });
    const onDeleted = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);

    const result = await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
      staleRecovery: false,
      backupManifest: null,
      force: true,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded,
      onDeleted,
    });

    expect(result?.entries).toEqual([{ server: "github" }]);
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(mocks.stopNimContainerByName).toHaveBeenCalledWith("nim-alpha");
    expect(mocks.reattachMcpAfterDeleteFailure).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).not.toHaveBeenCalled();
  });

  it("preserves recovery ownership when post-delete state is partial or ambiguous (#7062)", async () => {
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [{ server: "github" }],
      scrubbedAdapterEntries: [],
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete interrupted" })
      .mockReturnValueOnce({ status: 0, stdout: "Phase: Terminating\n", stderr: "" });
    const onDeleted = vi.fn();
    const onDeleteStateAmbiguous = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded,
        onDeleted,
        onDeleteStateAmbiguous,
      }),
    ).rejects.toThrow(/exact post-delete state is ambiguous.*recovery state was preserved/i);

    expect(onDeleted).not.toHaveBeenCalled();
    expect(onDeleteStateAmbiguous).toHaveBeenCalledOnce();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(mocks.reattachMcpAfterDeleteFailure).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).not.toHaveBeenCalled();
  });

  it("does not treat missing-looking partial output from a timed-out probe as deleted (#7062)", async () => {
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [{ server: "github" }],
      scrubbedAdapterEntries: [],
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete interrupted" })
      .mockReturnValueOnce({
        status: null,
        stdout: "",
        stderr: 'status: Internal, message: "sandbox has no spec"',
        error: Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" }),
      });
    const onDeleted = vi.fn();
    const onDeleteStateAmbiguous = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded,
        onDeleted,
        onDeleteStateAmbiguous,
      }),
    ).rejects.toThrow(/exact post-delete state is ambiguous.*recovery state was preserved/i);

    expect(mocks.runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onDeleteStateAmbiguous).toHaveBeenCalledOnce();
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(mocks.reattachMcpAfterDeleteFailure).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).not.toHaveBeenCalled();
  });

  it("stops local NIM only after a read-only MCP rebuild deletes the sandbox (#7062)", async () => {
    const revalidateBeforeDelete = vi.fn().mockResolvedValue(undefined);
    const assertDeleteEdgeUnchanged = vi.fn();
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      revalidateBeforeDelete,
      assertDeleteEdgeUnchanged,
    });

    await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw" },
      staleRecovery: false,
      backupManifest: null,
      force: true,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted: vi.fn(),
    });

    expect(revalidateBeforeDelete).toHaveBeenCalledOnce();
    expect(assertDeleteEdgeUnchanged).toHaveBeenCalledOnce();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).toHaveBeenCalledWith("nim-alpha");
    expect(assertDeleteEdgeUnchanged.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOpenshell.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.runOpenshell.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stopNimContainerByName.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
