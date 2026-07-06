// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS } from "./openclaw-managed-extensions";
import {
  buildFreshOpenClawPluginIndexSqliteReadCommand,
  parseFreshOpenClawPluginExtensionDirs,
  parseOpenClawImagePluginInstalls,
  planOpenClawPluginRestore,
} from "./openclaw-plugin-restore";

const OPENCLAW_DIR = "/sandbox/.openclaw";

function install(installPath: string): Record<string, unknown> {
  return { source: "path", installPath };
}

const CREATE_PLUGIN_INDEX_SQLITE_PY = [
  "import json, sqlite3, sys",
  "conn = sqlite3.connect(sys.argv[1])",
  "conn.execute('CREATE TABLE installed_plugin_index (index_key TEXT PRIMARY KEY, install_records_json TEXT)')",
  "records = json.loads(sys.argv[2])",
  "if records is not None: conn.execute('INSERT INTO installed_plugin_index VALUES (?, ?)', ('installed-plugin-index', json.dumps(records)))",
  "conn.commit()",
  "conn.close()",
].join("\n");

function createPluginIndexDatabase(dbPath: string, records: unknown): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  execFileSync("python3", ["-c", CREATE_PLUGIN_INDEX_SQLITE_PY, dbPath, JSON.stringify(records)]);
}

describe("buildFreshOpenClawPluginIndexSqliteReadCommand", () => {
  it("reads canonical install records from the OpenClaw SQLite index", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      const dbPath = path.join(root, "state", "openclaw.sqlite");
      const records = { weather: install(`${OPENCLAW_DIR}/extensions/weather`) };
      createPluginIndexDatabase(dbPath, records);

      const stdout = execFileSync(
        "bash",
        ["-c", buildFreshOpenClawPluginIndexSqliteReadCommand(root)],
        { encoding: "utf8" },
      );
      expect(JSON.parse(stdout)).toEqual({ version: 1, installRecords: records });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the SQLite database has no installed-plugin-index row", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      createPluginIndexDatabase(path.join(root, "state", "openclaw.sqlite"), null);
      expect(() =>
        execFileSync("bash", ["-c", buildFreshOpenClawPluginIndexSqliteReadCommand(root)]),
      ).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses exit status 2 only when the canonical SQLite database is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      const result = spawnSync("bash", [
        "-c",
        buildFreshOpenClawPluginIndexSqliteReadCommand(root),
      ]);
      expect(result.status).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a broken SQLite database symlink instead of using legacy fallback", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      const dbPath = path.join(root, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.symlinkSync(path.join(root, "missing.sqlite"), dbPath);
      const result = spawnSync("bash", [
        "-c",
        buildFreshOpenClawPluginIndexSqliteReadCommand(root),
      ]);
      expect(result.status).toBe(10);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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
    ).toEqual({
      ok: true,
      extensionDirs: ["nemoclaw", "weather"],
      pluginInstalls: [
        { id: "nemoclaw", installPath: `${OPENCLAW_DIR}/extensions/nemoclaw` },
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` },
      ],
    });
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
    ).toEqual({
      ok: true,
      extensionDirs: ["foo+bar", "my plugin", "scope__weather"],
      pluginInstalls: expect.arrayContaining([
        { id: "@scope/weather", installPath: `${OPENCLAW_DIR}/extensions/scope__weather` },
        { id: "diagnostics", installPath: `${OPENCLAW_DIR}/npm/node_modules/diagnostics` },
        { id: "foo+bar", installPath: `${OPENCLAW_DIR}/extensions/foo+bar` },
        { id: "my plugin", installPath: `${OPENCLAW_DIR}/extensions/my plugin` },
      ]),
    });
  });

  it.each([
    ["a traversal ID", { "../weather": install(`${OPENCLAW_DIR}/extensions/../weather`) }],
    ["a nested install path", { weather: install(`${OPENCLAW_DIR}/extensions/nested/weather`) }],
    ["a noncanonical install path", { weather: install(`${OPENCLAW_DIR}/extensions/../weather`) }],
    ["an oversized install path", { weather: install(`/${"a".repeat(4096)}`) }],
    [
      "an excessively deep install path",
      { weather: install(`/${Array.from({ length: 65 }, () => "a").join("/")}`) },
    ],
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

  it("accepts the 64-component install-path boundary", () => {
    const installPath = `/${Array.from({ length: 64 }, () => "a").join("/")}`;
    expect(
      parseFreshOpenClawPluginExtensionDirs(
        { version: 1, installRecords: { weather: install(installPath) } },
        OPENCLAW_DIR,
      ),
    ).toEqual({
      ok: true,
      extensionDirs: [],
      pluginInstalls: [{ id: "weather", installPath }],
    });
  });
});

describe("parseOpenClawImagePluginInstalls", () => {
  it("preserves known-empty provenance and validates populated records", () => {
    expect(parseOpenClawImagePluginInstalls([], OPENCLAW_DIR)).toEqual({
      ok: true,
      extensionDirs: [],
      pluginInstalls: [],
    });
    expect(
      parseOpenClawImagePluginInstalls(
        [
          { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` },
          { id: "npm-tool", installPath: `${OPENCLAW_DIR}/npm/node_modules/npm-tool` },
        ],
        OPENCLAW_DIR,
      ),
    ).toEqual({
      ok: true,
      extensionDirs: ["weather"],
      pluginInstalls: [
        { id: "npm-tool", installPath: `${OPENCLAW_DIR}/npm/node_modules/npm-tool` },
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` },
      ],
    });
  });

  it.each([
    ["unsafe ID", [{ id: "../weather", installPath: `${OPENCLAW_DIR}/extensions/weather` }]],
    [
      "duplicate ID",
      [
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` },
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/forecast` },
      ],
    ],
    [
      "duplicate install path",
      [
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` },
        { id: "forecast", installPath: `${OPENCLAW_DIR}/extensions/weather` },
      ],
    ],
    ["relative path", [{ id: "weather", installPath: "extensions/weather" }]],
  ])("rejects %s", (_label, provenance) => {
    expect(parseOpenClawImagePluginInstalls(provenance, OPENCLAW_DIR)).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });
});

describe("planOpenClawPluginRestore", () => {
  it("preserves fresh plugins while excluding removed previous plugins from the archive", () => {
    const result = planOpenClawPluginRestore({
      agentType: "openclaw",
      dir: OPENCLAW_DIR,
      localDirs: ["extensions"],
      freshImagePluginInstalls: [
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` },
      ],
      previousImagePluginInstalls: [
        { id: "forecast", installPath: `${OPENCLAW_DIR}/extensions/forecast` },
      ],
    });

    const preservedExtensionDirs = [
      ...new Set([...OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS, "weather"]),
    ].sort();
    expect(result).toEqual({
      ok: true,
      freshExtensionDirs: ["weather"],
      previousExtensionDirs: ["forecast"],
      preservedExtensionDirs,
      archiveExcludedExtensionDirs: [...preservedExtensionDirs, "forecast"].sort(),
      requiredFreshExtensionDirs: ["weather"],
    });
  });

  it("returns an empty extension plan when the backup does not contain extensions", () => {
    expect(
      planOpenClawPluginRestore({
        agentType: "openclaw",
        dir: OPENCLAW_DIR,
        localDirs: ["workspace"],
        freshImagePluginInstalls: [
          { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` },
        ],
      }),
    ).toEqual({
      ok: true,
      freshExtensionDirs: [],
      previousExtensionDirs: [],
      preservedExtensionDirs: [],
      archiveExcludedExtensionDirs: [],
      requiredFreshExtensionDirs: [],
    });
  });

  it("fails closed on invalid previous plugin provenance", () => {
    expect(
      planOpenClawPluginRestore({
        agentType: "openclaw",
        dir: OPENCLAW_DIR,
        localDirs: ["extensions"],
        freshImagePluginInstalls: [],
        previousImagePluginInstalls: [{ id: "weather", installPath: "extensions/weather" }],
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
  });
});
