// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildFreshOpenClawPluginIndexSqliteReadCommand,
  parseFreshOpenClawPluginExtensionDirs,
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
