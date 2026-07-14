// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { shellQuote } from "../runner";
import { buildEncodedPythonInvocation } from "./encoded-python";

describe("OpenShell-compatible encoded Python", () => {
  it("preserves script argv and binary stdin without literal newlines", () => {
    const program = [
      "import sys",
      "payload = sys.stdin.buffer.read()",
      'sys.stdout.write("|".join(sys.argv[1:]) + ":" + payload.hex())',
    ].join("\n");
    const command = `${buildEncodedPythonInvocation("python3", program, true)} ${shellQuote("first arg")} second`;

    expect(command).not.toMatch(/[\u0000\r\n]/);
    const result = spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      input: Buffer.from([0x00, 0xff, 0x41]),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("first arg|second:00ff41");
  });
});
