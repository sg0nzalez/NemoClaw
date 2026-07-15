// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshellCommand: vi.fn(),
  captureOpenshellCommandBinary: vi.fn(),
}));

vi.mock("./client", () => ({
  captureOpenshellCommand: mocks.captureOpenshellCommand,
  captureOpenshellCommandBinary: mocks.captureOpenshellCommandBinary,
  captureOpenshellCommandAsync: vi.fn(),
  getInstalledOpenshellVersion: vi.fn(),
  runOpenshellCommand: vi.fn(),
}));

vi.mock("./resolve", () => ({
  resolveOpenshell: () => "/test/openshell",
}));

import { ROOT } from "../../runner";
import { captureOpenshell, captureOpenshellBinary } from "./runtime";

describe("OpenShell runtime capture", () => {
  beforeEach(() => {
    mocks.captureOpenshellCommand.mockReset();
    mocks.captureOpenshellCommand.mockReturnValue({ status: 0, output: "ok" });
    mocks.captureOpenshellCommandBinary.mockReset();
    mocks.captureOpenshellCommandBinary.mockReturnValue({
      status: 0,
      stdout: Buffer.from("ok"),
      stderr: Buffer.alloc(0),
    });
  });

  it("forwards binary stdin to the command capture boundary", () => {
    const input = Buffer.from([0, 255, 10]);
    const args = ["sandbox", "exec", "--name", "alpha", "--", "cat"];

    captureOpenshell(args, { input });

    expect(mocks.captureOpenshellCommand).toHaveBeenCalledWith(
      "/test/openshell",
      args,
      expect.objectContaining({ input }),
    );
    expect(mocks.captureOpenshellCommand.mock.calls[0]?.[2]?.input).toBe(input);
  });

  it("runs raw captures from the standard NemoClaw working directory", () => {
    const input = Buffer.from([0, 255, 10]);
    const args = ["sandbox", "exec", "--name", "alpha", "--", "cat"];

    captureOpenshellBinary(args, { input, maxBuffer: 4096, timeout: 30_000 });

    expect(mocks.captureOpenshellCommandBinary).toHaveBeenCalledWith("/test/openshell", args, {
      cwd: ROOT,
      env: undefined,
      replaceEnv: undefined,
      input,
      maxBuffer: 4096,
      timeout: 30_000,
    });
  });
});
