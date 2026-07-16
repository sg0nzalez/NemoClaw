// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readOpenShellGatewayUpgradeWorkflow,
  validateOpenShellGatewayUpgradeWorkflow,
} from "../../../tools/e2e/openshell-gateway-upgrade-workflow-boundary.mts";
import {
  validateE2eWorkflow,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import {
  buildGatewayUpgradeIsolatedEnv,
  createGatewayUpgradeIsolatedHome,
  currentGatewayUpgradeInstallerArgs,
  oldGatewayUpgradeInstallerArgs,
  prepareGatewayUpgradeOpenShellFixture,
  upgradeGatewayCleanupScript,
  validateLegacyGatewayUpgradeFixture,
} from "../live/openshell-gateway-upgrade-helpers.ts";

describe("OpenShell gateway upgrade workflow boundary", () => {
  it("pins the v0.0.55 x86_64 and arm64 fixtures to the canonical live test (#6114)", () => {
    const workflow = readOpenShellGatewayUpgradeWorkflow();
    expect(validateOpenShellGatewayUpgradeWorkflow(workflow)).toEqual([]);
    expect(validateE2eWorkflowBoundary()).toEqual([]);

    const job = (workflow.jobs as Record<string, Record<string, unknown>>)[
      "openshell-gateway-upgrade"
    ];
    job["runs-on"] = "ubuntu-latest";
    const strategy = job.strategy as Record<string, Record<string, unknown>>;
    const legacy = strategy.matrix.legacy as Array<Record<string, unknown>>;
    legacy.find((fixture) => fixture.id === "v0.0.55-x86_64")!.sandbox_base_image_ref =
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6";
    legacy.find((fixture) => fixture.id === "v0.0.55-aarch64")!.runner = "ubuntu-latest";
    const run = (job.steps as Array<Record<string, unknown>>).find(
      (step) => step.name === "Run OpenShell gateway upgrade live Vitest test",
    )!;
    run.run = "npx vitest run --project e2e-live unrelated.test.ts";

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "openshell-gateway-upgrade must run on ${{ matrix.legacy.runner }}",
        "openshell-gateway-upgrade v0.0.55 matrix must pin x86_64 and arm64 upgrade fixtures",
        "openshell-gateway-upgrade step 'Run OpenShell gateway upgrade live Vitest test' must run: npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/openshell-gateway-upgrade.test.ts",
      ]),
    );
  });

  it("freshens only the retryable old fixture install", () => {
    expect(oldGatewayUpgradeInstallerArgs("old-install.sh")).toEqual([
      "old-install.sh",
      "--non-interactive",
      "--yes-i-accept-third-party-software",
      "--fresh",
    ]);
    expect(currentGatewayUpgradeInstallerArgs("current-install.sh")).toEqual([
      "current-install.sh",
      "--non-interactive",
      "--yes-i-accept-third-party-software",
    ]);
    expect(currentGatewayUpgradeInstallerArgs("current-install.sh", { interactive: true })).toEqual(
      ["current-install.sh"],
    );
  });

  it("seeds and removes the v0.0.55 stale-PATH fixture only inside an isolated HOME (#6114)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-upgrade-openshell-"));
    const callerHome = path.join(tmp, "caller-home");
    const callerTarget = path.join(callerHome, ".local", "bin", "openshell");

    try {
      fs.mkdirSync(path.dirname(callerTarget), { recursive: true });
      fs.writeFileSync(callerTarget, "caller's openshell\n");
      fs.chmodSync(callerTarget, 0o440);

      const isolated = createGatewayUpgradeIsolatedHome(tmp);
      const fixturePath = prepareGatewayUpgradeOpenShellFixture("v0.0.55", isolated.home);
      expect(fixturePath).toBe(isolated.openshellPath);
      const result = spawnSync(fixturePath!, ["--version"], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("openshell 0.0.0\n");
      expect(fs.statSync(isolated.openshellPath).mode & 0o777).toBe(0o755);
      expect(isolated.pidFile).toBe(
        path.join(
          isolated.home,
          ".local",
          "state",
          "nemoclaw",
          "openshell-docker-gateway",
          "openshell-gateway.pid",
        ),
      );
      expect(isolated.registryFile).toBe(path.join(isolated.home, ".nemoclaw", "sandboxes.json"));
      const isolatedEnv = buildGatewayUpgradeIsolatedEnv(
        {
          HOME: callerHome,
          PATH: `${path.join(callerHome, ".local", "bin")}${path.delimiter}/usr/bin`,
        },
        isolated.home,
        callerHome,
      );
      expect(isolatedEnv.HOME).toBe(isolated.home);
      expect(isolatedEnv.PATH).toBe("/usr/bin");
      expect(isolatedEnv.DOCKER_CONFIG).toBe(path.join(callerHome, ".docker"));
      expect(fs.readFileSync(callerTarget, "utf8")).toBe("caller's openshell\n");
      expect(fs.statSync(callerTarget).mode & 0o777).toBe(0o440);
      expect(prepareGatewayUpgradeOpenShellFixture("v0.0.36", callerHome)).toBeUndefined();

      isolated.remove();
      expect(fs.existsSync(isolated.home)).toBe(false);
      expect(fs.readFileSync(callerTarget, "utf8")).toBe("caller's openshell\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses symlink and non-regular v0.0.55 fixture paths without touching their targets (#6114)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-upgrade-openshell-"));
    const target = path.join(tmp, ".local", "bin", "openshell");
    const symlinkDestination = path.join(tmp, "real-openshell");

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(symlinkDestination, "must remain unchanged\n");
      fs.symlinkSync(symlinkDestination, target);
      expect(() => prepareGatewayUpgradeOpenShellFixture("v0.0.55", tmp)).toThrow(
        /fixture path must start absent/,
      );
      expect(fs.readFileSync(symlinkDestination, "utf8")).toBe("must remain unchanged\n");

      fs.unlinkSync(target);
      fs.mkdirSync(target);
      expect(() => prepareGatewayUpgradeOpenShellFixture("v0.0.55", tmp)).toThrow(
        /fixture path must start absent/,
      );
      expect(fs.statSync(target).isDirectory()).toBe(true);

      const binDir = path.dirname(target);
      fs.rmSync(binDir, { recursive: true });
      const outsideBin = path.join(tmp, "outside-bin");
      fs.mkdirSync(outsideBin);
      fs.symlinkSync(outsideBin, binDir);
      expect(() => prepareGatewayUpgradeOpenShellFixture("v0.0.55", tmp)).toThrow(
        /non-directory OpenShell fixture path component/,
      );
      expect(fs.existsSync(path.join(outsideBin, "openshell"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to remove a replaced isolated HOME through a symlink (#6114)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-upgrade-openshell-"));
    const outsideHome = path.join(tmp, "outside-home");
    const sentinel = path.join(outsideHome, "must-remain");

    try {
      const isolated = createGatewayUpgradeIsolatedHome(tmp);
      fs.rmSync(isolated.home, { recursive: true });
      fs.mkdirSync(outsideHome);
      fs.writeFileSync(sentinel, "unchanged\n");
      fs.symlinkSync(outsideHome, isolated.home);

      expect(() => isolated.remove()).toThrow(/replaced OpenShell gateway upgrade HOME/);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged\n");
      expect(fs.lstatSync(isolated.home).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects mutable or injectable historical fixture inputs before use (#6114)", () => {
    const fixture = {
      nemoclawRef: "v0.0.55",
      nemoclawCommit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
      installerSha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
      openclawVersion: "2026.5.22",
      sandboxBaseImageRef:
        "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    };

    expect(validateLegacyGatewayUpgradeFixture(fixture)).toEqual({
      sandboxBaseDigest: "10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    });
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        nemoclawRef: "v0.0.55; echo injected",
      }),
    ).toThrow(/NEMOCLAW_OLD_NEMOCLAW_REF/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        nemoclawCommit: fixture.nemoclawCommit.toUpperCase(),
      }),
    ).toThrow(/NEMOCLAW_OLD_NEMOCLAW_COMMIT/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        installerSha256: fixture.installerSha256.toUpperCase(),
      }),
    ).toThrow(/NEMOCLAW_OLD_INSTALLER_SHA256/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        openclawVersion: '2026.5.22" && echo injected #',
      }),
    ).toThrow(/NEMOCLAW_OLD_OPENCLAW_VERSION/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        sandboxBaseImageRef: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
      }),
    ).toThrow(/NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF/);
  });

  it("reclaims only the owned gateway volume namespace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-cleanup-"));
    const log = path.join(tmp, "removed-volumes.log");
    const pidFile = path.join(tmp, "gateway.pid");
    fs.writeFileSync(pidFile, "123\n");
    const script = [
      "set -euo pipefail",
      "openshell() { return 0; }",
      "docker() {",
      '  case "${1:-} ${2:-}" in',
      '    "volume ls") printf "%s\\n" openshell-cluster-nemoclaw openshell-cluster-nemoclaw-cache openshell-cluster-nemoclaw2 unrelated ;;',
      '    "volume rm") printf "%s\\n" "${3:-}" >>"$CLEANUP_LOG" ;;',
      "    *) return 99 ;;",
      "  esac",
      "}",
      upgradeGatewayCleanupScript(pidFile),
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, CLEANUP_LOG: log },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "openshell-cluster-nemoclaw",
        "openshell-cluster-nemoclaw-cache",
      ]);
      expect(fs.existsSync(pidFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
