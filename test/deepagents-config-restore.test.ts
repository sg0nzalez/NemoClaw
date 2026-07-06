// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-config-restore-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "..");
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

type SandboxStateModule = typeof import("../src/lib/state/sandbox.js");

const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as SandboxStateModule;

afterAll(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function writeAgentRegistry(sandboxName: string, agent: string): void {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          policies: [],
          agent,
        },
      },
    }),
  );
}

function writeBackup(sandboxName: string, dirName: string): string {
  const backupPath = path.join(BACKUPS_ROOT, sandboxName, dirName);
  fs.mkdirSync(backupPath, { recursive: true });
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify(
      {
        version: 1,
        sandboxName,
        timestamp: dirName,
        agentType: "langchain-deepagents-code",
        agentVersion: null,
        expectedVersion: null,
        stateDirs: [],
        stateFiles: [{ path: "config.toml", strategy: "copy" }],
        dir: "/sandbox/.deepagents",
        backupPath,
        blueprintDigest: null,
      },
      null,
      2,
    ),
  );
  return backupPath;
}

describe("Deep Agents Code generated config restore", () => {
  it("can skip restoring generated config.toml after provider/model drift recreate (#6311)", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-restore-skip-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const fakeRoot = path.join(fixture, "sandbox-root");
      const deepAgentsDir = path.join(fakeRoot, ".deepagents");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(deepAgentsDir, { recursive: true });
      fs.writeFileSync(path.join(deepAgentsDir, "config.toml"), 'model = "new-model"\n');

      const openshell = path.join(binDir, "openshell");
      writeExecutable(
        openshell,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-deepagents\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
      );

      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const deepAgentsDir = path.join(${JSON.stringify(fakeRoot)}, ".deepagents");
const cmd = process.argv[process.argv.length - 1] || "";
function readStdin() {
  const chunks = [];
  for (;;) {
    const buf = Buffer.alloc(65536);
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { break; }
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks);
}
if (cmd.includes(".nemoclaw-restore") && cmd.includes("config.toml")) {
  fs.writeFileSync(path.join(deepAgentsDir, "config.toml"), readStdin());
  process.exit(0);
}
process.exit(0);
`,
      );

      writeAgentRegistry("deepagents", "langchain-deepagents-code");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

      const backupPath = writeBackup("deepagents", "2026-07-06T10-00-00-000Z");
      fs.writeFileSync(path.join(backupPath, "config.toml"), 'model = "old-model"\n');

      const restore = sandboxState.restoreSandboxState("deepagents", backupPath, {
        skipStateFiles: ["config.toml"],
      });

      expect(restore.success).toBe(true);
      expect(restore.restoredFiles).toEqual([]);
      expect(fs.readFileSync(path.join(deepAgentsDir, "config.toml"), "utf-8")).toBe(
        'model = "new-model"\n',
      );
    } finally {
      oldOpenshell === undefined
        ? delete process.env.NEMOCLAW_OPENSHELL_BIN
        : (process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell);
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
