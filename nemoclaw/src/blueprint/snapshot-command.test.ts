// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];
const REAL_TMP = fs.realpathSync(os.tmpdir());
const stdoutChunks: string[] = [];
let home = "";
let snapshotsDir = "";

async function loadCommand(): Promise<typeof import("./snapshot-command.js")> {
  vi.resetModules();
  vi.doMock("node:os", () => ({ homedir: () => home }));
  return import("./snapshot-command.js");
}

function writeSnapshot(timestamp: string, source = home): string {
  const snapshotDir = path.join(snapshotsDir, timestamp);
  fs.mkdirSync(path.join(snapshotDir, "openclaw"), { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "openclaw", "config.json"), "{}\n");
  fs.writeFileSync(
    path.join(snapshotDir, "snapshot.json"),
    JSON.stringify({ timestamp, source, file_count: 1, contents: ["config.json"] }),
  );
  return snapshotDir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-command-"));
  snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
  tempRoots.push(home);
  stdoutChunks.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stdoutText(): string {
  return stdoutChunks.join("");
}

describe("snapshot command", () => {
  it.each([{ argv: [] }, { argv: ["--help"] }, { argv: ["-h"] }])("shows usage for $argv", async ({
    argv,
  }) => {
    const { actionSnapshots } = await loadCommand();

    actionSnapshots(argv);

    expect(stdoutText()).toContain("Usage: snapshots <list|prune|delete>");
  });

  it("rejects an unknown subcommand", async () => {
    const { actionSnapshots } = await loadCommand();

    expect(() => actionSnapshots(["bogus"])).toThrow("Unknown snapshots subcommand");
  });

  it("lists no snapshots through the runner route", async () => {
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => home }));
    const { main } = await import("./runner.js");

    await main(["snapshots", "list"]);

    expect(stdoutText()).toContain("No snapshots found.");
  });

  it("lists snapshots while stripping control characters from mutable fields", async () => {
    writeSnapshot("20990101T000000Z", `${home}\u001b[31m/evil`);
    const { actionSnapshots } = await loadCommand();

    actionSnapshots(["list"]);

    expect(stdoutText()).toContain("20990101T000000Z");
    expect(stdoutText()).not.toContain("\u001b");
    expect(stdoutText()).toContain(`${home}?[31m/evil`);
  });

  it("prunes old snapshots and reports partial failures as errors", async () => {
    const older = writeSnapshot("20990101T000000Z");
    writeSnapshot("20990201T000000Z");
    vi.stubEnv("PATH", "");
    const { actionSnapshots } = await loadCommand();

    expect(() => actionSnapshots(["prune", "--keep", "1"])).toThrow(
      "Failed to prune 1 snapshot(s)",
    );
    expect(stdoutText()).toContain(`Failed:  ${older}`);
  });

  it.each(["3abc", "1.5", "9".repeat(400)])("rejects invalid --keep value %s", async (keep) => {
    const { actionSnapshots } = await loadCommand();

    expect(() => actionSnapshots(["prune", "--keep", keep])).toThrow(
      "--keep must be a non-negative integer",
    );
  });

  it.each([
    { argv: ["prune"] },
    { argv: ["delete"] },
  ])("rejects missing arguments for $argv", async ({ argv }) => {
    const { actionSnapshots } = await loadCommand();

    expect(() => actionSnapshots(argv)).toThrow();
  });

  it("rejects delete paths outside the snapshots root", async () => {
    const { actionSnapshots } = await loadCommand();

    expect(() => actionSnapshots(["delete", "--path", "/tmp/unauthorized"])).toThrow(
      "Snapshot path must be inside the snapshots directory",
    );
    expect(() => actionSnapshots(["delete", "--path", snapshotsDir])).toThrow(
      "Snapshot path must be inside the snapshots directory",
    );
  });

  it("deletes a snapshot and treats an absent child as already deleted", async () => {
    const snapshot = writeSnapshot("20990101T000000Z");
    const absent = path.join(snapshotsDir, "20990201T000000Z");
    const { actionSnapshots } = await loadCommand();

    actionSnapshots(["delete", "--path", snapshot]);
    actionSnapshots(["delete", "--path", absent]);

    expect(fs.existsSync(snapshot)).toBe(false);
    expect(stdoutText()).toContain(`Deleted snapshot: ${snapshot}`);
    expect(stdoutText()).toContain(`Deleted snapshot: ${absent}`);
  });

  it("surfaces the native Windows deletion limitation", async () => {
    const snapshot = writeSnapshot("20990101T000000Z");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { actionSnapshots } = await loadCommand();

    expect(() => actionSnapshots(["delete", "--path", snapshot])).toThrow(
      "Snapshot deletion is not supported on native Windows; use WSL.",
    );
    expect(() => actionSnapshots(["prune", "--keep", "0"])).toThrow(
      "Snapshot deletion is not supported on native Windows; use WSL.",
    );
  });
});
