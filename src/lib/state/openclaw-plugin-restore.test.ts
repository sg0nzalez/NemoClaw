// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseFreshOpenClawPluginExtensionDirs } from "./openclaw-plugin-restore";

const OPENCLAW_DIR = "/sandbox/.openclaw";

function install(installPath: string): Record<string, unknown> {
  return { source: "path", installPath };
}

describe("parseFreshOpenClawPluginExtensionDirs", () => {
  it("returns sorted validated directories for direct extension installs", () => {
    expect(
      parseFreshOpenClawPluginExtensionDirs(
        {
          version: 1,
          installRecords: {
            weather: install(`${OPENCLAW_DIR}/extensions/weather`),
            nemoclaw: install(`${OPENCLAW_DIR}/extensions/nemoclaw`),
          },
        },
        OPENCLAW_DIR,
      ),
    ).toEqual({ ok: true, extensionDirs: ["nemoclaw", "weather"] });
  });

  it("ignores npm installs outside extensions and accepts scoped IDs with encoded directories", () => {
    expect(
      parseFreshOpenClawPluginExtensionDirs(
        {
          version: 1,
          installRecords: {
            "@scope/weather": install(`${OPENCLAW_DIR}/extensions/scope__weather`),
            diagnostics: install(`${OPENCLAW_DIR}/npm/node_modules/diagnostics`),
            "foo+bar": install(`${OPENCLAW_DIR}/extensions/foo+bar`),
            "my plugin": install(`${OPENCLAW_DIR}/extensions/my plugin`),
          },
        },
        OPENCLAW_DIR,
      ),
    ).toEqual({ ok: true, extensionDirs: ["foo+bar", "my plugin", "scope__weather"] });
  });

  it.each([
    ["a traversal ID", { "../weather": install(`${OPENCLAW_DIR}/extensions/../weather`) }],
    ["a nested install path", { weather: install(`${OPENCLAW_DIR}/extensions/nested/weather`) }],
    ["a noncanonical install path", { weather: install(`${OPENCLAW_DIR}/extensions/../weather`) }],
    ["a glob extension directory", { weather: install(`${OPENCLAW_DIR}/extensions/*`) }],
    ["non-object metadata", { weather: "invalid" }],
  ])("rejects %s", (_label, installs) => {
    const result = parseFreshOpenClawPluginExtensionDirs(
      { version: 1, installRecords: installs },
      OPENCLAW_DIR,
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringMatching(/unsafe|invalid/),
      }),
    );
  });

  it("rejects an unbounded install set before constructing restore commands", () => {
    const installs = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => {
        const id = `plugin-${index}`;
        return [id, install(`${OPENCLAW_DIR}/extensions/${id}`)];
      }),
    );
    expect(
      parseFreshOpenClawPluginExtensionDirs({ version: 1, installRecords: installs }, OPENCLAW_DIR),
    ).toEqual({
      ok: false,
      error: "fresh OpenClaw registry has too many plugin installs (129)",
    });
  });
});
