// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditLegacySandboxTransports,
  discoverLegacySandboxTransportSites,
} from "../scripts/checks/legacy-sandbox-transports";

const fixtures: string[] = [];

function fixtureRepo(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-transports-"));
  fixtures.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  return root;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
});

describe("legacy sandbox transport inventory", () => {
  it("discovers the direct sandbox transport shapes that the migration must remove", () => {
    const root = fixtureRepo({
      "src/transport.ts": [
        'spawnSync("ssh", ["sandbox"]);',
        'run(["ssh", "sandbox"]);',
        'collect(root, "probe", "ssh", ["sandbox"]);',
        'deps.run("sshfs", ["sandbox:/", "/mnt"]);',
        'captureOpenshell(["sandbox", "ssh-config", "alpha"]);',
        'createTempSshConfig(config, "prefix-");',
        'privilegedSandboxExecArgv("alpha", ["true"]);',
        'dockerSpawnSync(["exec", "openshell-cluster-nemoclaw", "true"]);',
      ].join("\n"),
    });

    expect(discoverLegacySandboxTransportSites(root)).toEqual([
      { relativePath: "src/transport.ts", kind: "docker-exec-command", calls: 1 },
      { relativePath: "src/transport.ts", kind: "openshell-ssh-config", calls: 1 },
      { relativePath: "src/transport.ts", kind: "privileged-sandbox-exec", calls: 1 },
      { relativePath: "src/transport.ts", kind: "ssh-command", calls: 3 },
      { relativePath: "src/transport.ts", kind: "ssh-temp-config", calls: 1 },
      { relativePath: "src/transport.ts", kind: "sshfs-command", calls: 1 },
    ]);
  });

  it("ignores comments, inert strings, tests, and non-sandbox SSH workflows", () => {
    const root = fixtureRepo({
      "src/safe.ts": [
        '// spawnSync("ssh", ["sandbox"]);',
        'const example = "ssh";',
        'log("ssh");',
      ].join("\n"),
      "src/safe.test.ts": 'spawnSync("ssh", ["sandbox"]);',
      "src/lib/deploy/remote.ts": 'spawnSync("ssh", ["host"]);',
      "src/lib/deploy/colima.ts": 'run(["ssh", "vm"]);',
    });

    expect(discoverLegacySandboxTransportSites(root)).toEqual([]);
  });

  it("fails closed when a production site is not in the reviewed inventory", () => {
    const root = fixtureRepo({
      "src/new-path.ts": 'spawnSync("ssh", ["sandbox"]);',
    });

    expect(auditLegacySandboxTransports(root, [])).toEqual([
      "src/new-path.ts:ssh-command: found 1 unreviewed legacy transport call(s)",
    ]);
  });
});
