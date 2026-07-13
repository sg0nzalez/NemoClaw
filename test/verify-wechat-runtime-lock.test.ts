// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  expectedWechatGraph,
  verifyWechatRuntimeLock,
} from "../scripts/verify-wechat-runtime-lock.mts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const packages = {
  "node_modules/@tencent-weixin/openclaw-weixin": {
    version: "2.4.3",
    integrity: "sha512-plugin",
    dependencies: { "qrcode-terminal": "0.12.0", zod: "^4.3.6" },
  },
  "node_modules/qrcode-terminal": { version: "0.12.0", integrity: "sha512-qr" },
  "node_modules/zod": { version: "4.4.3", integrity: "sha512-zod" },
};

function writePackage(root: string, location: string, version: string): void {
  const target = path.join(root, location);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ version }));
}

function fixture(): { lockFile: string; projectsRoot: string; installedLock: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-lock-"));
  tempDirs.push(root);
  const projectsRoot = path.join(root, "projects");
  const installedRoot = path.join(projectsRoot, "wechat-project");
  fs.mkdirSync(installedRoot, { recursive: true });
  for (const [location, record] of Object.entries(packages)) {
    writePackage(installedRoot, location, record.version);
  }
  const lockFile = path.join(root, "reviewed-lock.json");
  const installedLock = path.join(installedRoot, "package-lock.json");
  fs.writeFileSync(lockFile, JSON.stringify({ packages }));
  fs.writeFileSync(installedLock, JSON.stringify({ packages }));
  return { lockFile, projectsRoot, installedLock };
}

describe("WeChat runtime dependency lock", () => {
  it("derives the reviewed graph from lock metadata", () => {
    expect([...expectedWechatGraph({ packages }).keys()]).toEqual(Object.keys(packages));
  });

  it("accepts one managed npm graph that exactly matches the lock", () => {
    const { lockFile, projectsRoot } = fixture();
    expect(() => verifyWechatRuntimeLock(lockFile, projectsRoot)).not.toThrow();
  });

  it("rejects lock metadata drift and an unreviewed package", () => {
    const metadataDrift = fixture();
    const driftedPackages = structuredClone(packages);
    driftedPackages["node_modules/zod"].integrity = "sha512-drift";
    fs.writeFileSync(metadataDrift.installedLock, JSON.stringify({ packages: driftedPackages }));
    expect(() =>
      verifyWechatRuntimeLock(metadataDrift.lockFile, metadataDrift.projectsRoot),
    ).toThrow(/metadata does not match/);

    const extraPackage = fixture();
    fs.writeFileSync(
      extraPackage.installedLock,
      JSON.stringify({
        packages: { ...packages, "node_modules/unreviewed": { version: "1.0.0" } },
      }),
    );
    expect(() => verifyWechatRuntimeLock(extraPackage.lockFile, extraPackage.projectsRoot)).toThrow(
      /dependency set does not match/,
    );
  });
});
