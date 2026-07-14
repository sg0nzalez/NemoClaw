// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeStateDirectoryRestoreMetadata,
  MAX_STATE_DIRECTORY_RESTORE_DIRS,
  MAX_STATE_DIRECTORY_RESTORE_MANAGED_EXTENSIONS,
  MAX_STATE_DIRECTORY_RESTORE_METADATA_BYTES,
  STATE_DIRECTORY_RESTORE_MAGIC,
  STATE_DIRECTORY_RESTORE_PYTHON,
  STATE_DIRECTORY_RESTORE_VERSION,
} from "./sandbox-restore-payload.js";

interface TarEntry {
  name: string;
  type?: "directory" | "file" | "hardlink" | "symlink" | "fifo" | "sparse";
  linkname?: string;
  data?: Buffer;
  declaredSize?: number;
  mode?: number;
}

const fixtures: string[] = [];

function writeAscii(target: Buffer, offset: number, length: number, value: string): void {
  target.write(value, offset, Math.min(length, Buffer.byteLength(value)), "ascii");
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  writeAscii(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarArchive(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const data = entry.data ?? Buffer.alloc(0);
    writeAscii(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, entry.mode ?? 0o755);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.declaredSize ?? data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    const type = entry.type ?? "file";
    header[156] = {
      directory: 0x35,
      file: 0x30,
      hardlink: 0x31,
      symlink: 0x32,
      fifo: 0x36,
      sparse: 0x53,
    }[type];
    writeAscii(header, 157, 100, entry.linkname ?? "");
    writeAscii(header, 257, 6, "ustar\0");
    writeAscii(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header);
    chunks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function framedPayload(
  directories: readonly string[],
  managedExtensions: readonly (readonly [string, boolean])[],
  archive: Buffer,
): Buffer {
  const metadata = Buffer.from(JSON.stringify({ directories, managedExtensions }), "utf8");
  const header = Buffer.alloc(STATE_DIRECTORY_RESTORE_MAGIC.length + 5);
  STATE_DIRECTORY_RESTORE_MAGIC.copy(header);
  header.writeUInt8(STATE_DIRECTORY_RESTORE_VERSION, STATE_DIRECTORY_RESTORE_MAGIC.length);
  header.writeUInt32BE(metadata.length, STATE_DIRECTORY_RESTORE_MAGIC.length + 1);
  return Buffer.concat([header, metadata, archive]);
}

function truncatedRegularArchive(): Buffer {
  const archive = tarArchive([
    { name: "workspace", type: "directory" },
    { name: "workspace/data", data: Buffer.alloc(1024, 0x41) },
  ]);
  return archive.subarray(0, 512 + 512 + 100);
}

function fixture(): { base: string; remotePath: string; stateRoot: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-program-")));
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
  program = STATE_DIRECTORY_RESTORE_PYTHON,
  expectedDigest?: string,
  timeout = 30_000,
) {
  const digest = createHash("sha256").update(fs.readFileSync(remotePath)).digest("hex");
  return spawnSync("python3", ["-I", "-", remotePath, stateRoot, expectedDigest ?? digest], {
    input: program,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024,
  });
}

afterEach(() => {
  for (const item of fixtures.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

describe("framed state directory restore", () => {
  it("preserves managed extensions, strips special modes, and extracts in bounded Python", () => {
    const { remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "extensions", "managed"), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "extensions", "managed", "keep"), "fresh");
    fs.mkdirSync(path.join(stateRoot, "extensions", "stale"), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "extensions", "stale", "remove"), "old");
    const archive = tarArchive([
      { name: "extensions", type: "directory" },
      { name: "extensions/user", type: "directory" },
      { name: "extensions/user/tool", data: Buffer.from("restored"), mode: 0o4755 },
      { name: "extensions/user/node_modules", type: "directory" },
      { name: "extensions/user/node_modules/.bin", type: "directory" },
      {
        name: "extensions/user/node_modules/.bin/tool",
        type: "symlink",
        linkname: "../tool/bin.js",
      },
    ]);
    fs.writeFileSync(remotePath, framedPayload(["extensions"], [["managed", true]], archive), {
      mode: 0o600,
    });

    const result = runProgram(remotePath, stateRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("RESTORE_OK");
    expect(fs.existsSync(remotePath)).toBe(false);
    expect(fs.readFileSync(path.join(stateRoot, "extensions", "managed", "keep"), "utf8")).toBe(
      "fresh",
    );
    expect(fs.existsSync(path.join(stateRoot, "extensions", "stale"))).toBe(false);
    const restored = path.join(stateRoot, "extensions", "user", "tool");
    expect(fs.readFileSync(restored, "utf8")).toBe("restored");
    expect(fs.statSync(restored).mode & 0o7000).toBe(0);
    expect(
      fs.readlinkSync(path.join(stateRoot, "extensions", "user", "node_modules", ".bin", "tool")),
    ).toBe("../tool/bin.js");
  });

  it("creates a missing parent for an explicitly declared nested state directory", () => {
    const { remotePath, stateRoot } = fixture();
    fs.writeFileSync(
      remotePath,
      framedPayload(
        ["agent/skills"],
        [],
        tarArchive([
          { name: "agent/skills", type: "directory" },
          { name: "agent/skills/SKILL.md", data: Buffer.from("restored\n") },
        ]),
      ),
      { mode: 0o600 },
    );

    const result = runProgram(remotePath, stateRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(stateRoot, "agent", "skills", "SKILL.md"), "utf8")).toBe(
      "restored\n",
    );
  });

  it("rejects replacement of a preserved managed extension after cleanup", () => {
    const { remotePath, stateRoot } = fixture();
    const managedPath = path.join(stateRoot, "extensions", "managed");
    fs.mkdirSync(managedPath, { recursive: true });
    fs.writeFileSync(path.join(managedPath, "keep"), "fresh");
    fs.writeFileSync(
      remotePath,
      framedPayload(
        ["extensions"],
        [["managed", true]],
        tarArchive([{ name: "extensions", type: "directory" }]),
      ),
      { mode: 0o600 },
    );
    const extractionCall = "        extract_archive(stream, tar_offset, root_fd, records)";
    const raceProgram = STATE_DIRECTORY_RESTORE_PYTHON.replace(
      extractionCall,
      String.raw`        attack_fd = open_dir_at(root_fd, ["extensions"], False)
        try:
            os.replace("managed", "managed-before-race", src_dir_fd=attack_fd, dst_dir_fd=attack_fd)
            os.mkdir("managed", 0o700, dir_fd=attack_fd)
        finally:
            os.close(attack_fd)
        extract_archive(stream, tar_offset, root_fd, records)`,
    );
    expect(raceProgram).not.toBe(STATE_DIRECTORY_RESTORE_PYTHON);

    const result = runProgram(remotePath, stateRoot, raceProgram);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("managed extension changed during restore");
    expect(result.stdout).not.toContain("RESTORE_OK");
    expect(
      fs.readFileSync(path.join(stateRoot, "extensions", "managed-before-race", "keep"), "utf8"),
    ).toBe("fresh");
  });

  it("pins a newly created root for absent optional managed extensions", () => {
    const { remotePath, stateRoot } = fixture();
    fs.writeFileSync(
      remotePath,
      framedPayload(
        ["extensions"],
        [["optional", false]],
        tarArchive([{ name: "extensions", type: "directory" }]),
      ),
      { mode: 0o600 },
    );
    const extractionCall = "        extract_archive(stream, tar_offset, root_fd, records)";
    const raceProgram = STATE_DIRECTORY_RESTORE_PYTHON.replace(
      extractionCall,
      String.raw`        os.replace("extensions", "extensions-before-race", src_dir_fd=root_fd, dst_dir_fd=root_fd)
        os.mkdir("extensions", 0o700, dir_fd=root_fd)
        extract_archive(stream, tar_offset, root_fd, records)`,
    );
    expect(raceProgram).not.toBe(STATE_DIRECTORY_RESTORE_PYTHON);

    const result = runProgram(remotePath, stateRoot, raceProgram);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("managed extension root changed during restore");
    expect(result.stdout).not.toContain("RESTORE_OK");
  });

  it.each([
    ["traversal", { name: "../escape", data: Buffer.from("x") }],
    ["hard link", { name: "workspace/hard", type: "hardlink", linkname: "workspace/file" }],
    ["special file", { name: "workspace/pipe", type: "fifo" }],
    ["sparse file", { name: "workspace/sparse", type: "sparse", declaredSize: 4096 }],
    ["unsafe link", { name: "workspace/leak", type: "symlink", linkname: "/etc/passwd" }],
  ] as const)("rejects a %s member table before target mutation", (_label, entry) => {
    const { remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "workspace"));
    const marker = path.join(stateRoot, "workspace", "keep");
    fs.writeFileSync(marker, "untouched");
    fs.writeFileSync(remotePath, framedPayload(["workspace"], [], tarArchive([entry])), {
      mode: 0o600,
    });

    const result = runProgram(remotePath, stateRoot);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");
  });

  it.each([
    ["empty archive", tarArchive([])],
    ["implicit root", tarArchive([{ name: "workspace/child", data: Buffer.from("x") }])],
    ["unusable root mode", tarArchive([{ name: "workspace", type: "directory", mode: 0o000 }])],
    [
      "non-directory ancestor",
      tarArchive([
        { name: "workspace", type: "directory" },
        { name: "workspace/file", data: Buffer.alloc(0) },
        { name: "workspace/file/child", data: Buffer.from("x") },
      ]),
    ],
    [
      "late non-directory ancestor",
      tarArchive([
        { name: "workspace", type: "directory" },
        { name: "workspace/file/child", data: Buffer.from("x") },
        { name: "workspace/file", data: Buffer.alloc(0) },
      ]),
    ],
    ["truncated regular payload", truncatedRegularArchive()],
  ] as const)("rejects an unsafe %s before cleaning the target", (_label, archive) => {
    const { remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "workspace"));
    const marker = path.join(stateRoot, "workspace", "keep");
    fs.writeFileSync(marker, "untouched");
    fs.writeFileSync(remotePath, framedPayload(["workspace"], [], archive), { mode: 0o600 });

    const result = runProgram(remotePath, stateRoot);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");
  });

  it("rejects an oversized metadata length before target mutation", () => {
    const { remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "workspace"));
    const marker = path.join(stateRoot, "workspace", "keep");
    fs.writeFileSync(marker, "untouched");
    const header = Buffer.alloc(STATE_DIRECTORY_RESTORE_MAGIC.length + 5);
    STATE_DIRECTORY_RESTORE_MAGIC.copy(header);
    header.writeUInt8(STATE_DIRECTORY_RESTORE_VERSION, STATE_DIRECTORY_RESTORE_MAGIC.length);
    header.writeUInt32BE(
      MAX_STATE_DIRECTORY_RESTORE_METADATA_BYTES + 1,
      STATE_DIRECTORY_RESTORE_MAGIC.length + 1,
    );
    fs.writeFileSync(remotePath, header, { mode: 0o600 });

    const result = runProgram(remotePath, stateRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("metadata exceeds limit");
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");
  });

  it("rejects an archive whose physical tar bytes exceed the fixed cap", () => {
    const { remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "workspace"));
    const marker = path.join(stateRoot, "workspace", "keep");
    fs.writeFileSync(marker, "untouched");
    const archive = tarArchive([
      { name: "workspace", type: "directory" },
      { name: "workspace/data", data: Buffer.alloc(1024) },
    ]);
    fs.writeFileSync(remotePath, framedPayload(["workspace"], [], archive), { mode: 0o600 });
    const boundedProgram = STATE_DIRECTORY_RESTORE_PYTHON.replace(
      "MAX_ARCHIVE = 256 * 1024 * 1024",
      "MAX_ARCHIVE = 2 * 1024",
    );

    const result = runProgram(remotePath, stateRoot, boundedProgram);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("archive exceeds limit");
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");
  });

  it("rejects an uploaded directory payload with a mismatched digest", () => {
    const { remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "workspace"));
    const marker = path.join(stateRoot, "workspace", "keep");
    fs.writeFileSync(marker, "untouched");
    fs.writeFileSync(
      remotePath,
      framedPayload(["workspace"], [], tarArchive([{ name: "workspace", type: "directory" }])),
      { mode: 0o600 },
    );

    const result = runProgram(
      remotePath,
      stateRoot,
      STATE_DIRECTORY_RESTORE_PYTHON,
      "0".repeat(64),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("digest mismatch");
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");
  });

  it("rejects a high-cardinality conflict within the fixed runtime budget", () => {
    const { remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "workspace"));
    const marker = path.join(stateRoot, "workspace", "keep");
    fs.writeFileSync(marker, "untouched");
    const entries: TarEntry[] = [{ name: "workspace", type: "directory" }];
    entries.push(
      ...Array.from({ length: 4096 }, (_unused, index) => ({
        name: `workspace/dir-${String(index).padStart(4, "0")}/child`,
        data: Buffer.alloc(0),
      })),
      { name: "workspace/dir-4095", data: Buffer.alloc(0) },
    );
    fs.writeFileSync(remotePath, framedPayload(["workspace"], [], tarArchive(entries)), {
      mode: 0o600,
    });

    const result = runProgram(
      remotePath,
      stateRoot,
      STATE_DIRECTORY_RESTORE_PYTHON,
      undefined,
      5000,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");
  });

  it("rejects symlink races in both staged-file and state-root components", () => {
    const { base, remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "workspace"));
    const marker = path.join(stateRoot, "workspace", "keep");
    fs.writeFileSync(marker, "untouched");
    const payload = framedPayload(
      ["workspace"],
      [],
      tarArchive([{ name: "workspace", type: "directory" }]),
    );
    const realPayload = path.join(base, "real-payload");
    fs.writeFileSync(realPayload, payload, { mode: 0o600 });
    fs.symlinkSync(realPayload, remotePath);
    expect(runProgram(remotePath, stateRoot).status).not.toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");

    fs.rmSync(remotePath);
    fs.writeFileSync(remotePath, payload, { mode: 0o600 });
    const rootLink = path.join(base, "state-root-link");
    fs.symlinkSync(stateRoot, rootLink);
    expect(runProgram(remotePath, rootLink).status).not.toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");
  });

  it("rejects a group/world-writable staged payload before target mutation", () => {
    const { remotePath, stateRoot } = fixture();
    fs.mkdirSync(path.join(stateRoot, "workspace"));
    const marker = path.join(stateRoot, "workspace", "keep");
    fs.writeFileSync(marker, "untouched");
    fs.writeFileSync(
      remotePath,
      framedPayload(["workspace"], [], tarArchive([{ name: "workspace", type: "directory" }])),
      { mode: 0o666 },
    );
    fs.chmodSync(remotePath, 0o666);

    const result = runProgram(remotePath, stateRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe staged restore file");
    expect(fs.readFileSync(marker, "utf8")).toBe("untouched");
  });

  it("bounds high-cardinality directory and managed-extension metadata", () => {
    const directories = Array.from(
      { length: MAX_STATE_DIRECTORY_RESTORE_DIRS },
      (_unused, index) => `dir-${String(index).padStart(5, "0")}`,
    );
    const atLimit = encodeStateDirectoryRestoreMetadata(directories, []);
    expect(atLimit.ok).toBe(true);
    expect(encodeStateDirectoryRestoreMetadata([...directories, "one-too-many"], [])).toMatchObject(
      { ok: false, error: expect.stringContaining("1-16384") },
    );

    const managed = Array.from(
      { length: MAX_STATE_DIRECTORY_RESTORE_MANAGED_EXTENSIONS },
      (_unused, index) => ({ name: `extension-${String(index)}`, required: index % 2 === 0 }),
    );
    expect(encodeStateDirectoryRestoreMetadata(["extensions"], managed).ok).toBe(true);
    expect(
      encodeStateDirectoryRestoreMetadata(
        ["extensions"],
        [...managed, { name: "one-too-many", required: false }],
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("exceeds 256") });
  });
});
