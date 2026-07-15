// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FIX_COREDNS = path.join(import.meta.dirname, "..", "scripts", "fix-coredns.sh");

describe("fix-coredns.sh", () => {
  it("exists and is executable", () => {
    const stat = fs.statSync(FIX_COREDNS);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("patches CoreDNS on a Podman-style Docker host using a resolved upstream", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fix-coredns-"));
    const fakeBin = path.join(tmp, "bin");
    const dockerLog = path.join(tmp, "docker.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(dockerLog)}
if [ "\${1:-}" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi
if [ "\${1:-}" = "exec" ] && [ "\${3:-}" = "cat" ]; then echo "nameserver 9.9.9.9"; exit 0; fi
exit 0
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", [FIX_COREDNS, "nemoclaw"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock",
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("Patching CoreDNS to forward to 9.9.9.9");
      expect(output).toContain("Done. DNS should resolve");
      const calls = fs.readFileSync(dockerLog, "utf-8");
      expect(calls).toContain("kubectl patch configmap coredns");
      expect(calls).toContain("forward . 9.9.9.9");
      expect(calls).toContain("rollout restart deploy/coredns");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects invalid resolved upstream values before patching CoreDNS", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fix-coredns-bad-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi
if [ "\${1:-}" = "exec" ] && [ "\${3:-}" = "cat" ]; then echo "nameserver bad;rm"; exit 0; fi
exit 0
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", [FIX_COREDNS, "nemoclaw"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock",
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("contains invalid characters");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
