// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { type Command, Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

import {
  findCommandsOutsideNemoClawBase,
  findCommandsOwningHelpFlag,
  findMissingPublicCommandStatics,
} from "./oclif-pattern-discovery-helpers";

describe("oclif pattern command discovery", () => {
  it("discovers representative command ids from oclif's pattern config", async () => {
    const config = await OclifConfig.load(process.cwd());
    const discoveredIds = config.commands.map((command) => command.id).sort();

    expect(discoveredIds).toEqual(
      expect.arrayContaining([
        "onboard",
        "sandbox:status",
        "sandbox:channels:start",
        "inference:get",
      ]),
    );
  });

  it("does not rely on the removed compatibility command index", () => {
    expect(fs.existsSync(path.join(process.cwd(), "src", "lib", "commands", "index.ts"))).toBe(
      false,
    );
  });

  it("keeps discovered commands on the shared NemoClaw oclif base", async () => {
    const config = await OclifConfig.load(process.cwd());
    expect(await findCommandsOutsideNemoClawBase(config.commands)).toEqual([]);
  });

  it("keeps the help flag centralized on the shared base command", async () => {
    const config = await OclifConfig.load(process.cwd());
    expect(await findCommandsOwningHelpFlag(config.commands)).toEqual([]);
  });

  it("keeps public discovered commands documented in oclif statics", async () => {
    const config = await OclifConfig.load(process.cwd());
    expect(findMissingPublicCommandStatics(config.commands)).toEqual([]);
  });

  it("accepts Oclif's string form for command usage", () => {
    const command = {
      description: "Describe the command",
      examples: ["<%= config.bin %> example"],
      hidden: false,
      id: "example",
      summary: "Summarize the command",
      usage: "example",
    } as Command.Loadable;

    expect(findMissingPublicCommandStatics([command])).toEqual([]);
  });
});
