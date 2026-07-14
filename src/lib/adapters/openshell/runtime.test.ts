// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshellCommand: vi.fn(),
}));

vi.mock("./client", () => ({
  captureOpenshellCommand: mocks.captureOpenshellCommand,
  captureOpenshellCommandAsync: vi.fn(),
  captureSandboxSshConfigCommand: vi.fn(),
  getInstalledOpenshellVersion: vi.fn(),
  runOpenshellCommand: vi.fn(),
}));

vi.mock("./resolve", () => ({
  resolveOpenshell: () => "/test/openshell",
}));

import { captureOpenshell } from "./runtime";

describe("OpenShell runtime capture", () => {
  beforeEach(() => {
    mocks.captureOpenshellCommand.mockReset();
    mocks.captureOpenshellCommand.mockReturnValue({ status: 0, output: "ok" });
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
});
