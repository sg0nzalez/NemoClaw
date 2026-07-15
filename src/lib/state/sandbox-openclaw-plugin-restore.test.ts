// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execSandboxReadOnlyWithGrpcFallback } from "../adapters/openshell/sandbox-control-routing";

vi.mock("../adapters/openshell/sandbox-control-routing", () => ({
  execSandboxReadOnlyWithGrpcFallback: vi.fn(),
}));

import {
  discoverFreshOpenClawPluginExtensionDirs,
  OPENCLAW_PLUGIN_INDEX_LEGACY_PY,
  OPENCLAW_PLUGIN_INDEX_SQLITE_PY,
} from "./openclaw-plugin-restore";

const OPENCLAW_DIR = "/sandbox/.openclaw";
const MAX_PLUGIN_REGISTRY_BYTES = 1024 * 1024;

function sandboxExecResult(
  status: number | null,
  stdout: string,
  options: { error?: Error; signal?: NodeJS.Signals | null } = {},
): Awaited<ReturnType<typeof execSandboxReadOnlyWithGrpcFallback>> {
  return {
    status,
    stdout,
    stderr: "",
    ...(options.error ? { error: options.error } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function discover() {
  return discoverFreshOpenClawPluginExtensionDirs("gateway-one", "sandbox-one", OPENCLAW_DIR);
}

describe("fresh OpenClaw plugin registry reads", () => {
  const execMock = vi.mocked(execSandboxReadOnlyWithGrpcFallback);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an oversized SQLite registry response before JSON.parse", async () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    execMock.mockResolvedValue(sandboxExecResult(0, " ".repeat(5 * 1024 * 1024)));

    await expect(discover()).resolves.toEqual({
      ok: false,
      error: "fresh OpenClaw plugin install registry response too large",
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledOnce();
    expect(execMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        command: ["sh", "-c", expect.stringContaining('python3 -I - "$db" "$cfg"')],
        stdin: OPENCLAW_PLUGIN_INDEX_SQLITE_PY,
        maxOutputBytes: MAX_PLUGIN_REGISTRY_BYTES,
        timeoutMs: 30_000,
      }),
    );
  });

  it("classifies a bounded-output transport failure before parsing truncated output", async () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    const error = new Error("sandbox exec output limit exceeded");
    execMock.mockResolvedValue(
      sandboxExecResult(null, " ".repeat(MAX_PLUGIN_REGISTRY_BYTES + 8192), {
        error,
        signal: "SIGTERM",
      }),
    );

    await expect(discover()).resolves.toEqual({
      ok: false,
      error: "fresh OpenClaw plugin install registry response too large",
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledOnce();
  });

  it("rejects an oversized legacy registry response after the status-2 fallback", async () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    execMock
      .mockResolvedValueOnce(sandboxExecResult(2, ""))
      .mockResolvedValueOnce(sandboxExecResult(0, " ".repeat(5 * 1024 * 1024)));

    await expect(discover()).resolves.toEqual({
      ok: false,
      error: "fresh OpenClaw plugin install registry response too large",
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ stdin: OPENCLAW_PLUGIN_INDEX_LEGACY_PY }),
    );
    for (const call of execMock.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          maxOutputBytes: MAX_PLUGIN_REGISTRY_BYTES,
          timeoutMs: 30_000,
        }),
      );
    }
  });

  it.each([10, 11])("does not use the legacy fallback for SQLite status %i", async (status) => {
    execMock.mockResolvedValue(sandboxExecResult(status, ""));

    await expect(discover()).resolves.toEqual({
      ok: false,
      error: "could not read fresh OpenClaw plugin install registry",
    });
    expect(execMock).toHaveBeenCalledOnce();
  });
});
