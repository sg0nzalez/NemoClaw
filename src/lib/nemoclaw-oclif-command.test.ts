// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { NemoClawCommand } from "./nemoclaw-oclif-command";

class JsonProbeCommand extends NemoClawCommand {
  static id = "json-probe";
  static flags = {};

  public async run(): Promise<void> {
    this.parsed = true;
    this.logJson({ ok: true });
  }
}

describe("NemoClawCommand", () => {
  it("formats JSON output consistently", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await JsonProbeCommand.run([], process.cwd());

    expect(log).toHaveBeenCalledWith(JSON.stringify({ ok: true }, null, 2));
    log.mockRestore();
  });
});
