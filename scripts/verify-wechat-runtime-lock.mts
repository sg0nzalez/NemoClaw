// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const WECHAT_PACKAGE = "@tencent-weixin/openclaw-weixin";
const WECHAT_LOCATION = `node_modules/${WECHAT_PACKAGE}`;

type PackageRecord = {
  version?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<string, PackageRecord>;
};

function readJson(file: string): unknown {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`refusing unsafe package metadata path: ${file}`);
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function packageVersion(file: string): string {
  const parsed = readJson(file);
  const version =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).version : undefined;
  if (typeof version !== "string") {
    throw new Error(`package metadata has no version: ${file}`);
  }
  return version;
}

export function expectedWechatGraph(lock: PackageLock): ReadonlyMap<string, PackageRecord> {
  const graph = new Map(
    Object.entries(lock.packages ?? {}).filter(([location]) =>
      location.startsWith("node_modules/"),
    ),
  );
  if (!graph.has(WECHAT_LOCATION)) {
    throw new Error(`WeChat runtime lock does not contain ${WECHAT_PACKAGE}`);
  }
  return graph;
}

function findInstalledLock(projectsRoot: string): string {
  const matches = fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(projectsRoot, entry.name, "package-lock.json"))
    .filter((lockFile) => {
      if (!fs.existsSync(lockFile)) return false;
      const lock = readJson(lockFile) as PackageLock;
      return Boolean(lock.packages?.[WECHAT_LOCATION]);
    });
  if (matches.length !== 1) {
    throw new Error(`expected one managed WeChat npm project, found ${matches.length}`);
  }
  return matches[0] as string;
}

function normalizedRecord(record: PackageRecord): PackageRecord {
  return {
    version: record.version,
    integrity: record.integrity,
    dependencies: Object.fromEntries(
      Object.entries(record.dependencies ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

export function verifyWechatRuntimeLock(lockFile: string, projectsRoot: string): void {
  const expected = expectedWechatGraph(readJson(lockFile) as PackageLock);
  const installedLockFile = findInstalledLock(projectsRoot);
  const installedRoot = path.dirname(installedLockFile);
  const actual = expectedWechatGraph(readJson(installedLockFile) as PackageLock);

  if ([...actual.keys()].sort().join("\0") !== [...expected.keys()].sort().join("\0")) {
    throw new Error("installed WeChat dependency set does not match the reviewed lock");
  }
  for (const [location, expectedRecord] of expected) {
    const actualRecord = actual.get(location);
    if (
      JSON.stringify(normalizedRecord(actualRecord ?? {})) !==
      JSON.stringify(normalizedRecord(expectedRecord))
    ) {
      throw new Error(`${location} metadata does not match the reviewed lock`);
    }
    const packageName = location.slice("node_modules/".length);
    const installedVersion = packageVersion(path.join(installedRoot, location, "package.json"));
    if (installedVersion !== expectedRecord.version) {
      throw new Error(
        `installed ${packageName}@${installedVersion} does not match locked ${expectedRecord.version}`,
      );
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , lockFile, projectsRoot] = process.argv;
  if (!lockFile || !projectsRoot) {
    throw new Error(
      "usage: verify-wechat-runtime-lock.mts <package-lock.json> <npm-projects-root>",
    );
  }
  verifyWechatRuntimeLock(lockFile, projectsRoot);
}
