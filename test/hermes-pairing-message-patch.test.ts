// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "patch-pairing-message.py",
);

let tmpDir: string;

function runPatch(root: string) {
  return spawnSync("python3", [SCRIPT_PATH, root], {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-pairing-patch-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agents/hermes/patch-pairing-message.py", () => {
  it("rewrites upstream pairing approval help from OpenClaw to Hermes", () => {
    const sourcePath = path.join(tmpDir, "src", "pairing.py");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      [
        "Ask the bot owner to approve with:",
        "openclaw pairing approve discord YPJTD9FD",
        "",
      ].join("\n"),
    );

    const result = runPatch(tmpDir);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(sourcePath, "utf-8")).toContain(
      "hermes pairing approve discord YPJTD9FD",
    );
    expect(fs.readFileSync(sourcePath, "utf-8")).not.toContain(
      "openclaw pairing approve discord YPJTD9FD",
    );
  });

  it("accepts Hermes versions that already have the corrected command", () => {
    const sourcePath = path.join(tmpDir, "src", "pairing.py");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "hermes pairing approve discord YPJTD9FD\n");

    const result = runPatch(tmpDir);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(
      "hermes pairing approve discord YPJTD9FD\n",
    );
  });

  it("fails closed if the upstream pairing approval text is not found", () => {
    fs.writeFileSync(path.join(tmpDir, "unrelated.py"), "print('no pairing help here')\n");

    const result = runPatch(tmpDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Hermes pairing approval command text not found");
  });
});
