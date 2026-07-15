// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { STATE_FILE_RESTORE_PYTHON } from "./state-file-restore.js";

const fixtures: string[] = [];

function fixture(): { base: string; remotePath: string; stateRoot: string } {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-file-program-")),
  );
  fixtures.push(base);
  const stateRoot = path.join(base, "state-root");
  fs.mkdirSync(stateRoot);
  return {
    base,
    stateRoot,
    remotePath: path.join(base, "nemoclaw-state-restore-fixture"),
  };
}

function runProgram(
  remotePath: string,
  stateRoot: string,
  relativePath: string,
  strategy: "copy" | "sqlite_backup",
  refresh: boolean,
  expectedDigest?: string,
) {
  const digest = createHash("sha256").update(fs.readFileSync(remotePath)).digest("hex");
  return spawnSync(
    "python3",
    [
      "-I",
      "-",
      remotePath,
      stateRoot,
      relativePath,
      strategy,
      refresh ? "1" : "0",
      expectedDigest ?? digest,
    ],
    {
      input: STATE_FILE_RESTORE_PYTHON,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    },
  );
}

afterEach(() => {
  for (const item of fixtures.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

describe("staged state-file restore program", () => {
  it("copies through pinned descriptors and refreshes OpenClaw recovery anchors", () => {
    const { remotePath, stateRoot } = fixture();
    const contents = Buffer.from('{"restored":true}\n');
    fs.writeFileSync(remotePath, contents, { mode: 0o600 });

    const result = runProgram(remotePath, stateRoot, "nested/openclaw.json", "copy", true);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("STATE_FILE_OK");
    expect(fs.existsSync(remotePath)).toBe(false);
    const destination = path.join(stateRoot, "nested", "openclaw.json");
    expect(fs.readFileSync(destination)).toEqual(contents);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(`${destination}.last-good`)).toEqual(contents);
    expect(fs.readFileSync(path.join(stateRoot, "nested", ".config-hash"), "utf8")).toMatch(
      /^[0-9a-f]{64}  openclaw\.json\n$/,
    );
  });

  it("restores SQLite with backup and quick-check semantics", () => {
    const { remotePath, stateRoot } = fixture();
    const create = spawnSync(
      "python3",
      [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v text)'); c.execute(\"insert into t values ('restored')\"); c.commit(); c.close()",
        remotePath,
      ],
      { encoding: "utf8" },
    );
    expect(create.status, create.stderr).toBe(0);

    const result = runProgram(remotePath, stateRoot, "db/state.sqlite", "sqlite_backup", false);

    expect(result.status, result.stderr).toBe(0);
    const query = spawnSync(
      "python3",
      [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('select v from t').fetchone()[0]); c.close()",
        path.join(stateRoot, "db", "state.sqlite"),
      ],
      { encoding: "utf8" },
    );
    expect(query.status, query.stderr).toBe(0);
    expect(query.stdout.trim()).toBe("restored");
    expect(fs.existsSync(remotePath)).toBe(false);
  });

  it("rejects malformed SQLite without changing the destination or leaking stages", () => {
    const { remotePath, stateRoot } = fixture();
    const destinationDir = path.join(stateRoot, "db");
    const destination = path.join(destinationDir, "state.sqlite");
    fs.mkdirSync(destinationDir);
    fs.writeFileSync(destination, "untouched destination\n");
    fs.writeFileSync(remotePath, "not a sqlite database\n", { mode: 0o600 });

    const result = runProgram(remotePath, stateRoot, "db/state.sqlite", "sqlite_backup", false);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(destination, "utf8")).toBe("untouched destination\n");
    expect(
      fs.readdirSync(destinationDir).filter((entry) => entry.startsWith(".nemoclaw-")),
    ).toEqual([]);
  });

  it("preflights recovery anchors before replacing any live file", () => {
    const { base, remotePath, stateRoot } = fixture();
    const destinationDir = path.join(stateRoot, "nested");
    const destination = path.join(destinationDir, "openclaw.json");
    const lastGood = `${destination}.last-good`;
    const attackTarget = path.join(base, "hash-target");
    fs.mkdirSync(destinationDir);
    fs.writeFileSync(destination, "live before\n");
    fs.writeFileSync(lastGood, "anchor before\n");
    fs.writeFileSync(attackTarget, "hash target before\n");
    fs.symlinkSync(attackTarget, path.join(destinationDir, ".config-hash"));
    fs.writeFileSync(remotePath, "replacement\n", { mode: 0o600 });

    const result = runProgram(remotePath, stateRoot, "nested/openclaw.json", "copy", true);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(destination, "utf8")).toBe("live before\n");
    expect(fs.readFileSync(lastGood, "utf8")).toBe("anchor before\n");
    expect(fs.readFileSync(attackTarget, "utf8")).toBe("hash target before\n");
    expect(
      fs.readdirSync(destinationDir).filter((entry) => entry.startsWith(".nemoclaw-")),
    ).toEqual([]);
  });

  it("rejects a staged payload whose uploaded digest does not match", () => {
    const { remotePath, stateRoot } = fixture();
    const destination = path.join(stateRoot, "config.json");
    fs.writeFileSync(destination, "untouched\n");
    fs.writeFileSync(remotePath, "replacement\n", { mode: 0o600 });

    const result = runProgram(remotePath, stateRoot, "config.json", "copy", false, "0".repeat(64));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("digest mismatch");
    expect(fs.readFileSync(destination, "utf8")).toBe("untouched\n");
  });

  it("rejects a staged payload writable by the sandbox group", () => {
    const { remotePath, stateRoot } = fixture();
    fs.writeFileSync(remotePath, "replacement\n", { mode: 0o620 });
    fs.chmodSync(remotePath, 0o620);

    const result = runProgram(remotePath, stateRoot, "config.json", "copy", false);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe staged state file");
    expect(fs.existsSync(path.join(stateRoot, "config.json"))).toBe(false);
  });

  it.each(["staged", "root"] as const)("rejects a symlinked %s component", (kind) => {
    const { base, remotePath, stateRoot } = fixture();
    const destination = path.join(stateRoot, "config.json");
    fs.writeFileSync(destination, "untouched");
    const realPayload = path.join(base, "real-payload");
    fs.writeFileSync(realPayload, "replacement", { mode: 0o600 });
    const rootLink = path.join(base, "state-root-link");
    fs.symlinkSync(stateRoot, rootLink);
    fs.symlinkSync(realPayload, remotePath);
    const selectedRemote = kind === "staged" ? remotePath : realPayload;
    const selectedRoot = kind === "root" ? rootLink : stateRoot;

    const result = runProgram(selectedRemote, selectedRoot, "config.json", "copy", false);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(destination, "utf8")).toBe("untouched");
  });
});
