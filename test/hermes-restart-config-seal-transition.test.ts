// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRestartFixture,
  mode,
  overwriteThroughOldFd,
  type RestartFixture,
  RUNTIME_CONFIG_GUARD,
  readFileSnapshot,
  readTextFileSnapshot,
  runGuard,
  runShieldsTransactionAction,
  runShieldsTransition,
  runWriteConfig,
  shieldsTransactionToken,
  strictHashIsValid,
} from "./helpers/hermes-restart-config-seal-fixture";

const LIFECYCLE_GUARD_ACTION = String.raw`
import errno
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("runtime_config_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)

marker = sys.argv[2]
guard.HERMES_ROOT_LIFECYCLE_MARKER = marker
if marker == "lookup-error":
    guard.HERMES_ROOT_LIFECYCLE_MARKER = "/synthetic/hermes-root-lifecycle"
    original_lstat = guard.os.lstat
    def fail_marker_lookup(path):
        if path == guard.HERMES_ROOT_LIFECYCLE_MARKER:
            raise OSError(errno.EIO, "synthetic lifecycle lookup failure")
        return original_lstat(path)
    guard.os.lstat = fail_marker_lookup

action = sys.argv[3]
hermes_dir, hash_file, state_file = sys.argv[4:7]
if action == "begin":
    token, original_locked = guard.begin_shields_transition(
        hermes_dir, hash_file, state_file, "mutable"
    )
    print(f"lock_token={token} original_locked={int(original_locked)}")
elif action == "finish":
    mode, chattr_applied = guard.finish_shields_transition(
        hermes_dir, hash_file, state_file, sys.argv[7]
    )
    print(f"shields_mode={mode} chattr_applied={int(chattr_applied)}")
else:
    raise ValueError(f"unsupported lifecycle guard action: {action}")
`;

function runLifecycleGuardAction(
  fixture: RestartFixture,
  marker: string,
  action: "begin" | "finish",
  token = "",
) {
  return spawnSync(
    "python3",
    [
      "-I",
      "-c",
      LIFECYCLE_GUARD_ACTION,
      RUNTIME_CONFIG_GUARD,
      marker,
      action,
      fixture.hermesDir,
      fixture.hashPath,
      fixture.statePath,
      token,
    ],
    { encoding: "utf-8", timeout: 5000 },
  );
}

function applyPrivateMutableTransition(fixture: RestartFixture, marker: string): string {
  const begun = runLifecycleGuardAction(fixture, marker, "begin");
  expect(begun.status, begun.stderr).toBe(0);
  const token = shieldsTransactionToken(begun.stdout);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", { token });
  expect(applied.status, applied.stderr).toBe(0);
  fs.chmodSync(fixture.hermesDir, 0o700);
  return token!;
}

function abortPrivateMutableTransition(fixture: RestartFixture, token: string): void {
  const prepared = runShieldsTransactionAction(fixture, "prepare-shields-abort", { token });
  expect(prepared.status, prepared.stderr).toBe(0);
  const aborted = runShieldsTransactionAction(fixture, "abort-shields-transition", { token });
  expect(aborted.status, aborted.stderr).toBe(0);
  expect(mode(fixture.hermesDir)).toBe(0o3770);
  expect(fs.existsSync(fixture.statePath)).toBe(false);
}

describe.skipIf(process.platform === "win32")("Hermes mutable restart input seal", () => {
  it("revokes pre-open writable fds while preserving trusted path bytes and strict hashes", () => {
    const fixture = createRestartFixture();
    const configFd = fs.openSync(fixture.configPath, "r+");
    const envFd = fs.openSync(fixture.envPath, "r+");
    const configBefore = fs.fstatSync(configFd);
    const envBefore = fs.fstatSync(envFd);

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const configSealed = fs.statSync(fixture.configPath);
      const envSealed = fs.statSync(fixture.envPath);
      expect(configSealed.ino).not.toBe(configBefore.ino);
      expect(envSealed.ino).not.toBe(envBefore.ino);
      expect(configSealed.uid).toBe(process.getuid!());
      expect(envSealed.uid).toBe(process.getuid!());
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(configSealed.uid).toBe(fs.statSync(fixture.hermesDir).uid);
      expect(envSealed.uid).toBe(fs.statSync(fixture.hermesDir).uid);
      expect(mode(fixture.statePath)).toBe(0o600);
      expect(strictHashIsValid(fixture)).toBe(true);

      overwriteThroughOldFd(configFd, configBefore.size, "X");
      overwriteThroughOldFd(envFd, envBefore.size, "Y");

      expect(readTextFileSnapshot(fixture.configPath)).toBe(fixture.trustedConfig);
      expect(readTextFileSnapshot(fixture.envPath)).toBe(fixture.trustedEnv);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.statSync(fixture.configPath).ino).toBe(configSealed.ino);
      expect(fs.statSync(fixture.envPath).ino).toBe(envSealed.ino);

      const unsealed = runGuard("unseal-restart", fixture);
      expect(unsealed.status, unsealed.stderr).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(fs.statSync(fixture.configPath).uid).toBe(configBefore.uid);
      expect(fs.statSync(fixture.configPath).gid).toBe(configBefore.gid);
      expect(fs.statSync(fixture.envPath).uid).toBe(envBefore.uid);
      expect(fs.statSync(fixture.envPath).gid).toBe(envBefore.gid);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(readTextFileSnapshot(fixture.configPath)).toBe(fixture.trustedConfig);
      expect(readTextFileSnapshot(fixture.envPath)).toBe(fixture.trustedEnv);
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.closeSync(configFd);
      fs.closeSync(envFd);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("revokes pre-open descriptors across shields lock and restores the mutable contract", () => {
    const fixture = createRestartFixture();
    const configFd = fs.openSync(fixture.configPath, "r+");
    const envFd = fs.openSync(fixture.envPath, "r+");
    const compatFd = fs.openSync(fixture.compatHashPath, "r+");
    const configBefore = fs.fstatSync(configFd);
    const envBefore = fs.fstatSync(envFd);
    const compatBefore = fs.fstatSync(compatFd);

    try {
      const locked = runShieldsTransition(fixture, "locked");
      expect(locked.status, locked.stderr).toBe(0);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(configBefore.ino);
      expect(fs.statSync(fixture.envPath).ino).not.toBe(envBefore.ino);
      expect(fs.statSync(fixture.compatHashPath).ino).not.toBe(compatBefore.ino);
      expect(mode(fixture.sandboxDir)).toBe(0o1775);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(mode(fixture.compatHashPath)).toBe(0o444);

      overwriteThroughOldFd(configFd, configBefore.size, "X");
      overwriteThroughOldFd(envFd, envBefore.size, "Y");
      overwriteThroughOldFd(compatFd, compatBefore.size, "Z");
      expect(readTextFileSnapshot(fixture.configPath)).toBe(fixture.trustedConfig);
      expect(readTextFileSnapshot(fixture.envPath)).toBe(fixture.trustedEnv);
      expect(strictHashIsValid(fixture)).toBe(true);

      const mutable = runShieldsTransition(fixture, "mutable");
      expect(mutable.status, mutable.stderr).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o640);
      expect(mode(fixture.compatHashPath)).toBe(0o640);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        false,
      );
    } finally {
      fs.closeSync(configFd);
      fs.closeSync(envFd);
      fs.closeSync(compatFd);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("commits a descriptor-pinned private mutable root in the managed non-root topology", () => {
    const fixture = createRestartFixture();
    const missingMarker = path.join(fixture.root, "hermes-root-lifecycle");

    try {
      const token = applyPrivateMutableTransition(fixture, missingMarker);
      const finished = runLifecycleGuardAction(fixture, missingMarker, "finish", token);

      expect(finished.status, finished.stderr).toBe(0);
      expect(finished.stdout).toContain("shields_mode=mutable");
      expect(mode(fixture.hermesDir)).toBe(0o700);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        false,
      );
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("restores the original posture when the begin topology probe fails", () => {
    const fixture = createRestartFixture();

    try {
      const begun = runLifecycleGuardAction(fixture, "lookup-error", "begin");

      expect(begun.status).not.toBe(0);
      expect(begun.stderr).toContain("topology probe failure");
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "regular",
    "dangling-symlink",
  ] as const)("rejects a private mutable root pinned from a %s marker", (markerState) => {
    const fixture = createRestartFixture();
    const marker = path.join(fixture.root, "hermes-root-lifecycle");
    switch (markerState) {
      case "regular":
        fs.writeFileSync(marker, "root-separated\n", { mode: 0o444 });
        break;
      case "dangling-symlink":
        fs.symlinkSync(`${marker}.missing`, marker);
        break;
    }

    try {
      const token = applyPrivateMutableTransition(fixture, marker);
      switch (markerState) {
        case "regular":
          fs.unlinkSync(marker);
          break;
        case "dangling-symlink":
          break;
      }
      const finished = runLifecycleGuardAction(fixture, marker, "finish", token);

      expect(finished.status).not.toBe(0);
      expect(finished.stderr).toContain(".hermes metadata drifted");
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      abortPrivateMutableTransition(fixture, token);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a root-lifecycle marker that appears after begin", () => {
    const fixture = createRestartFixture();
    const marker = path.join(fixture.root, "hermes-root-lifecycle");

    try {
      const token = applyPrivateMutableTransition(fixture, marker);
      fs.writeFileSync(marker, "root-separated\n", { mode: 0o444 });
      const finished = runLifecycleGuardAction(fixture, marker, "finish", token);

      expect(finished.status).not.toBe(0);
      expect(finished.stderr).toContain(".hermes metadata drifted");
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      abortPrivateMutableTransition(fixture, token);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains the transaction when the root-lifecycle lookup fails", () => {
    const fixture = createRestartFixture();
    const missingMarker = path.join(fixture.root, "hermes-root-lifecycle");

    try {
      const token = applyPrivateMutableTransition(fixture, missingMarker);
      const finished = runLifecycleGuardAction(fixture, "lookup-error", "finish", token);

      expect(finished.status).not.toBe(0);
      expect(finished.stderr).toContain("topology probe failure");
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      abortPrivateMutableTransition(fixture, token);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("holds the mutation lock through begin, apply, verification, and finish", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");

    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        true,
      );
      expect(mode(fixture.sandboxDir)).toBe(0o700);
      expect(mode(fixture.hermesDir)).toBe(0o500);

      const owner = runShieldsTransactionAction(fixture, "inspect-mutation-owner");
      expect(owner.status, owner.stderr).toBe(0);
      expect(owner.stdout).toContain("owner_active=1");
      expect(owner.stdout).toContain("recovery_safe=0");

      const competingRestart = runGuard("seal-restart", fixture);
      expect(competingRestart.status).not.toBe(0);
      expect(competingRestart.stderr).toContain("restart seal is already active");
      const competingWrite = runWriteConfig(
        fixture,
        expectedDigest,
        "model:\n  default: must-not-interleave\n",
      );
      expect(competingWrite.status).not.toBe(0);
      expect(competingWrite.stderr).toContain("restart seal is already active");

      fs.chmodSync(fixture.hermesDir, 0o755);
      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toContain("shields_mode=locked");
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        true,
      );
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.sandboxDir)).toBe(0o755);

      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token,
      });
      expect(finished.status, finished.stderr).toBe(0);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        false,
      );
      expect(mode(fixture.sandboxDir)).toBe(0o1775);
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps weakening fan-out inaccessible and keeps monotonic lock fan-out readable", () => {
    for (const targetMode of ["mutable", "locked"] as const) {
      const fixture = createRestartFixture();
      try {
        const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
          mode: targetMode,
        });
        expect(begun.status, begun.stderr).toBe(0);
        const token = shieldsTransactionToken(begun.stdout);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(mode(fixture.hermesDir)).toBe(targetMode === "mutable" ? 0o700 : 0o500);
        expect(mode(fixture.sandboxDir)).toBe(0o700);

        const prepared = runShieldsTransactionAction(fixture, "prepare-shields-abort", {
          token,
        });
        expect(prepared.status, prepared.stderr).toBe(0);
        const abortState = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
        expect(abortState.shields_transition.mode).toBe("mutable");
        // State-dir rollback is another recursive transition. It remains
        // root-only until abort commits the original posture.
        expect(mode(fixture.hermesDir)).toBe(0o700);
        expect(mode(fixture.sandboxDir)).toBe(0o700);

        const aborted = runShieldsTransactionAction(fixture, "abort-shields-transition", {
          token,
        });
        expect(aborted.status, aborted.stderr).toBe(0);
        expect(mode(fixture.hermesDir)).toBe(0o3770);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("retains the 0500 recursive clamp and resumes the same lock transaction", () => {
    const fixture = createRestartFixture();
    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(mode(fixture.hermesDir)).toBe(0o500);

      const premature = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(premature.status).not.toBe(0);
      expect(premature.stderr).toContain("retaining root-only 0500 clamp for retry");
      expect(mode(fixture.hermesDir)).toBe(0o500);
      expect(fs.existsSync(fixture.statePath)).toBe(true);

      const resumed = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(shieldsTransactionToken(resumed.stdout)).toBe(token);
      expect(mode(fixture.hermesDir)).toBe(0o500);

      fs.chmodSync(fixture.hermesDir, 0o755);
      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);
      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token,
      });
      expect(finished.status, finished.stderr).toBe(0);
      expect(mode(fixture.hermesDir)).toBe(0o755);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("cold-resumes an applied lock transaction before its final commit", () => {
    const fixture = createRestartFixture();
    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      fs.chmodSync(fixture.hermesDir, 0o755);
      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);

      const resumed = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(shieldsTransactionToken(resumed.stdout)).toBe(token);
      expect(mode(fixture.hermesDir)).toBe(0o500);
      fs.chmodSync(fixture.hermesDir, 0o755);
      const reapplied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(reapplied.status, reapplied.stderr).toBe(0);
      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token,
      });
      expect(finished.status, finished.stderr).toBe(0);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(mode(fixture.hermesDir)).toBe(0o755);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("takes over an expired applied mutable transition only after its worker lease ends", () => {
    const fixture = createRestartFixture();
    fs.chmodSync(fixture.sandboxDir, 0o1775);
    fs.chmodSync(fixture.hermesDir, 0o755);
    fs.chmodSync(fixture.configPath, 0o444);
    fs.chmodSync(fixture.envPath, 0o444);
    fs.chmodSync(fixture.compatHashPath, 0o444);
    let staleFd: number | undefined;
    try {
      const mutableBegin = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "mutable",
        rollbackMode: "locked",
      });
      expect(mutableBegin.status, mutableBegin.stderr).toBe(0);
      const mutableToken = shieldsTransactionToken(mutableBegin.stdout);
      expect(mutableToken).toMatch(/^[0-9a-f]{64}$/);
      const mutableApply = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token: mutableToken,
      });
      expect(mutableApply.status, mutableApply.stderr).toBe(0);
      staleFd = fs.openSync(fixture.configPath, "r+");

      const premature = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(premature.status).not.toBe(0);
      expect(premature.stderr).toContain("mutable transition lease has not expired");

      const staleState = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      staleState.shields_transition.lease_expires_ns = 1;
      fs.writeFileSync(fixture.statePath, `${JSON.stringify(staleState)}\n`, { mode: 0o600 });
      const beforeTakeoverInode = fs.statSync(fixture.configPath).ino;
      const lockedBegin = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(lockedBegin.status, lockedBegin.stderr).toBe(0);
      const lockedToken = shieldsTransactionToken(lockedBegin.stdout);
      expect(lockedToken).toMatch(/^[0-9a-f]{64}$/);
      expect(lockedToken).not.toBe(mutableToken);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(beforeTakeoverInode);
      expect(mode(fixture.hermesDir)).toBe(0o500);
      const sealedBytes = readFileSnapshot(fixture.configPath);
      overwriteThroughOldFd(staleFd, sealedBytes.length, "X");
      expect(readFileSnapshot(fixture.configPath)).toEqual(sealedBytes);

      fs.chmodSync(fixture.hermesDir, 0o755);
      expect(
        runShieldsTransactionAction(fixture, "apply-shields-transition", {
          token: lockedToken,
        }).status,
      ).toBe(0);
      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token: lockedToken,
      });
      expect(finished.status, finished.stderr).toBe(0);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      for (const openFd of staleFd === undefined ? [] : [staleFd]) fs.closeSync(openFd);
      fs.chmodSync(fixture.sandboxDir, 0o700);
      for (const existingHermesDir of fs.existsSync(fixture.hermesDir) ? [fixture.hermesDir] : []) {
        fs.chmodSync(existingHermesDir, 0o700);
      }
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("hardens mutable modes and stale hashes from the frozen current bytes", () => {
    const fixture = createRestartFixture();
    const configBefore = fs.statSync(fixture.configPath).ino;
    fs.chmodSync(fixture.configPath, 0o666);
    fs.chmodSync(fixture.envPath, 0o666);
    fs.writeFileSync(fixture.hashPath, "stale strict hash\n");
    fs.writeFileSync(fixture.compatHashPath, "stale compatibility hash\n");
    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const transition = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      expect(transition.shields_transition.unavailable).toBe(false);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(configBefore);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf-8"),
      );

      fs.chmodSync(fixture.hermesDir, 0o755);
      expect(
        runShieldsTransactionAction(fixture, "apply-shields-transition", { token }).status,
      ).toBe(0);
      expect(
        runShieldsTransactionAction(fixture, "finish-shields-transition", { token }).status,
      ).toBe(0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
