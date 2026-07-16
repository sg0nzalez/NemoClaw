// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../fixtures/clients/command.ts";

const NON_INTERACTIVE_INSTALLER_ARGS = ["--non-interactive", "--yes-i-accept-third-party-software"];
const GATEWAY_VOLUME_PREFIX = "openshell-cluster-nemoclaw";
const BELOW_MINIMUM_OPENSHELL_FIXTURE = Buffer.from(`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openshell 0.0.0\\n'
  exit 0
fi
exit 99
`);

export interface LegacyGatewayUpgradeFixture {
  nemoclawRef: string;
  nemoclawCommit: string;
  installerSha256: string;
  openclawVersion: string;
  sandboxBaseImageRef: string;
}

export interface GatewayUpgradeIsolatedHome {
  home: string;
  openshellPath: string;
  pidFile: string;
  registryFile: string;
  remove(): void;
}

export function createGatewayUpgradeIsolatedHome(
  temporaryDirectory: string = os.tmpdir(),
): GatewayUpgradeIsolatedHome {
  const home = fs.mkdtempSync(path.join(temporaryDirectory, "nemoclaw-gateway-upgrade-home-"));
  fs.chmodSync(home, 0o700);
  const identity = fs.lstatSync(home);
  let removed = false;
  return {
    home,
    openshellPath: path.join(home, ".local", "bin", "openshell"),
    pidFile: path.join(
      home,
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway",
      "openshell-gateway.pid",
    ),
    registryFile: path.join(home, ".nemoclaw", "sandboxes.json"),
    remove(): void {
      if (removed) return;
      const current = fs.lstatSync(home, { throwIfNoEntry: false });
      if (current && (current.dev !== identity.dev || current.ino !== identity.ino)) {
        throw new Error(`Refusing to remove replaced OpenShell gateway upgrade HOME: ${home}`);
      }
      fs.rmSync(home, { recursive: true, force: true });
      removed = true;
    },
  };
}

export function buildGatewayUpgradeIsolatedEnv(
  base: NodeJS.ProcessEnv,
  isolatedHome: string,
  hostHome: string,
): NodeJS.ProcessEnv {
  const hostUserLocalBin = path.join(hostHome, ".local", "bin");
  const isolatedUserLocalBin = path.join(isolatedHome, ".local", "bin");
  const configuredPath = base.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const isolatedPath = configuredPath
    .split(path.delimiter)
    .filter(
      (entry) =>
        entry &&
        path.resolve(entry) !== path.resolve(hostUserLocalBin) &&
        path.resolve(entry) !== path.resolve(isolatedUserLocalBin),
    );
  return {
    ...base,
    DOCKER_CONFIG: base.DOCKER_CONFIG ?? path.join(hostHome, ".docker"),
    HOME: isolatedHome,
    PATH: [isolatedUserLocalBin, ...isolatedPath].join(path.delimiter),
  };
}

export function validateLegacyGatewayUpgradeFixture(fixture: LegacyGatewayUpgradeFixture): {
  sandboxBaseDigest: string;
} {
  if (!/^v\d+\.\d+\.\d+$/.test(fixture.nemoclawRef)) {
    throw new Error(`NEMOCLAW_OLD_NEMOCLAW_REF must be a release tag; got ${fixture.nemoclawRef}`);
  }
  if (!/^[0-9a-f]{40}$/.test(fixture.nemoclawCommit)) {
    throw new Error(
      `NEMOCLAW_OLD_NEMOCLAW_COMMIT must be a full lowercase commit SHA; got ${fixture.nemoclawCommit}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(fixture.installerSha256)) {
    throw new Error(
      `NEMOCLAW_OLD_INSTALLER_SHA256 must be a lowercase SHA-256 digest; got ${fixture.installerSha256}`,
    );
  }
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(fixture.openclawVersion)) {
    throw new Error(
      `NEMOCLAW_OLD_OPENCLAW_VERSION must use the YYYY.M.D release format; got ${fixture.openclawVersion}`,
    );
  }
  const sandboxBaseDigest = fixture.sandboxBaseImageRef.match(
    /^[^@\s]+@sha256:([0-9a-f]{64})$/,
  )?.[1];
  if (!sandboxBaseDigest) {
    throw new Error(
      `NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF must be digest-pinned; got ${fixture.sandboxBaseImageRef}`,
    );
  }
  return { sandboxBaseDigest };
}

export function oldGatewayUpgradeInstallerArgs(installer: string): string[] {
  return [installer, ...NON_INTERACTIVE_INSTALLER_ARGS, "--fresh"];
}

export function currentGatewayUpgradeInstallerArgs(
  installer: string,
  options: { interactive?: boolean } = {},
): string[] {
  return options.interactive ? [installer] : [installer, ...NON_INTERACTIVE_INSTALLER_ARGS];
}

export function prepareGatewayUpgradeOpenShellFixture(
  nemoclawRef: string,
  home: string,
): string | undefined {
  if (nemoclawRef !== "v0.0.55") return undefined;

  // Hosted runners can let the frozen installer write to /usr/local/bin. A
  // below-minimum active binary makes that real installer select and replace
  // the user-local path inside this test's private HOME, preserving the stale-PATH
  // upgrade boundary without ever touching the caller's real ~/.local/bin.
  const target = path.join(home, ".local", "bin", "openshell");
  preparePrivateFixtureDirectories(home);
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    throw new Error(`Isolated v0.0.55 OpenShell fixture path must start absent: ${target}`);
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o755,
    );
  } catch (error) {
    throw new Error(`Refusing to create unsafe v0.0.55 OpenShell fixture path: ${target}`, {
      cause: error,
    });
  }
  try {
    writeOpenShellFixtureFile(descriptor, BELOW_MINIMUM_OPENSHELL_FIXTURE, 0o755);
    assertOpenDescriptorStillOwnsPath(target, descriptor);
  } catch (error) {
    if (openDescriptorOwnsPath(target, descriptor)) fs.unlinkSync(target);
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
  return target;
}

function preparePrivateFixtureDirectories(home: string): void {
  let current = home;
  for (const segment of ["", ".local", "bin"]) {
    current = segment ? path.join(current, segment) : current;
    let state = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!state && segment) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
      state = fs.lstatSync(current, { throwIfNoEntry: false });
    }
    if (!state?.isDirectory()) {
      throw new Error(`Refusing to use non-directory OpenShell fixture path component: ${current}`);
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function writeOpenShellFixtureFile(descriptor: number, contents: Uint8Array, mode: number): void {
  let offset = 0;
  while (offset < contents.length) {
    offset += fs.writeSync(descriptor, contents, offset, contents.length - offset, offset);
  }
  fs.ftruncateSync(descriptor, contents.length);
  fs.fchmodSync(descriptor, mode);
}

function assertOpenDescriptorStillOwnsPath(target: string, descriptor: number): void {
  if (!openDescriptorOwnsPath(target, descriptor)) {
    throw new Error(`OpenShell fixture path changed during a safe write: ${target}`);
  }
}

function openDescriptorOwnsPath(target: string, descriptor: number): boolean {
  const current = fs.lstatSync(target, { throwIfNoEntry: false });
  const opened = fs.fstatSync(descriptor);
  return Boolean(
    current && current.isFile() && current.dev === opened.dev && current.ino === opened.ino,
  );
}

export function upgradeGatewayStateCleanupScript(pidFile: string): string {
  return `set -e
volume_prefix=${GATEWAY_VOLUME_PREFIX}
gateway_volumes="$(docker volume ls -q --filter "name=\${volume_prefix}")"
while IFS= read -r volume; do
  [ -n "$volume" ] || continue
  case "$volume" in
    ${GATEWAY_VOLUME_PREFIX}|${GATEWAY_VOLUME_PREFIX}-*)
      printf 'Removing stale OpenShell gateway volume %s\\n' "$volume"
      docker volume rm "$volume" >/dev/null
      ;;
  esac
done <<<"$gateway_volumes"
rm -f ${shellQuote(pidFile)}`;
}

export function upgradeGatewayCleanupScript(pidFile: string): string {
  return `if command -v openshell >/dev/null 2>&1; then
  openshell gateway remove nemoclaw >/dev/null 2>&1 \\
    || openshell gateway destroy -g nemoclaw >/dev/null 2>&1 \\
    || openshell gateway destroy >/dev/null 2>&1 \\
    || true
fi
${upgradeGatewayStateCleanupScript(pidFile)}`;
}
