// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_PRELOAD_GUARDS,
  buildGatewayGuardRecoveryLines,
} from "../../../dist/lib/agent/runtime-recovery-preload";
import { buildOpenClawRecoveryScript, buildRecoveryScript } from "../../../dist/lib/agent/runtime";
import { minimalAgent } from "./hermes-recovery-boundary-fixtures";

const [SAFETY_NET_GUARD, CIAO_GUARD] = GATEWAY_PRELOAD_GUARDS;

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recovery-preload-"));
  const sourceDir = path.join(root, "usr-local-lib-nemoclaw-preloads");
  const workDir = path.join(root, "tmp");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const paths = {
    root,
    sourceSafetyNet: path.join(sourceDir, "sandbox-safety-net.js"),
    sourceCiao: path.join(sourceDir, "ciao-network-guard.js"),
    tmpSafetyNet: path.join(workDir, "nemoclaw-sandbox-safety-net.js"),
    tmpCiao: path.join(workDir, "nemoclaw-ciao-network-guard.js"),
    proxyEnv: path.join(workDir, "nemoclaw-proxy-env.sh"),
    gatewayLog: path.join(workDir, "gateway.log"),
  };

  fs.writeFileSync(paths.sourceSafetyNet, "module.exports = 'trusted safety net';\n");
  fs.writeFileSync(paths.sourceCiao, "module.exports = 'trusted ciao guard';\n");

  return paths;
}

function rewriteRuntimePaths(script: string, paths: ReturnType<typeof makeHarness>): string {
  return script
    .replaceAll(SAFETY_NET_GUARD.tmpPath, paths.tmpSafetyNet)
    .replaceAll(SAFETY_NET_GUARD.sourcePath, paths.sourceSafetyNet)
    .replaceAll(CIAO_GUARD.tmpPath, paths.tmpCiao)
    .replaceAll(CIAO_GUARD.sourcePath, paths.sourceCiao)
    .replaceAll("/tmp/nemoclaw-proxy-env.sh", paths.proxyEnv);
}

function runGuardRecovery(opts: {
  proxyEnvContent?: string;
  beforeScript?: (paths: ReturnType<typeof makeHarness>) => void;
}) {
  const paths = makeHarness();
  opts.beforeScript?.(paths);

  const sourceProxyEnv = opts.proxyEnvContent
    ? [
        `cat > ${JSON.stringify(paths.proxyEnv)} <<'PROXYENV'`,
        opts.proxyEnvContent,
        "PROXYENV",
        `chmod 444 ${JSON.stringify(paths.proxyEnv)}`,
        `. ${JSON.stringify(paths.proxyEnv)}`,
        "_PE_MISSING=0",
      ]
    : ["_PE_MISSING=1"];

  const script = rewriteRuntimePaths(
    [
      "#!/usr/bin/env bash",
      "set -u",
      `export _GATEWAY_LOG=${JSON.stringify(paths.gatewayLog)}`,
      ': > "$_GATEWAY_LOG"',
      ...sourceProxyEnv,
      ...buildGatewayGuardRecoveryLines(),
      'if [ "$_GUARDS_MISSING" = "1" ]; then echo GUARDS_MISSING; exit 17; fi',
      'printf "PE_MISSING=%s\\n" "$_PE_MISSING"',
      'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
    ].join("\n"),
    paths,
  );
  const scriptPath = path.join(paths.root, "recovery.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 10000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: paths.root },
    });
    const readIfExists = (pathname: string) =>
      fs.existsSync(pathname) ? fs.readFileSync(pathname, "utf-8") : null;
    const modeIfExists = (pathname: string) => (fs.existsSync(pathname) ? mode(pathname) : null);
    return {
      ...result,
      paths,
      files: {
        gatewayLog: readIfExists(paths.gatewayLog) ?? "",
        proxyEnv: readIfExists(paths.proxyEnv),
        tmpSafetyNet: readIfExists(paths.tmpSafetyNet),
        tmpCiao: readIfExists(paths.tmpCiao),
        tmpSafetyNetMode: modeIfExists(paths.tmpSafetyNet),
        tmpCiaoMode: modeIfExists(paths.tmpCiao),
        proxyEnvMode: modeIfExists(paths.proxyEnv),
        tmpSafetyNetIsSymlink: fs.existsSync(paths.tmpSafetyNet)
          ? fs.lstatSync(paths.tmpSafetyNet).isSymbolicLink()
          : null,
      },
    };
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
}

function mode(pathname: string): number {
  return fs.statSync(pathname).mode & 0o777;
}

describe("gateway recovery preload repair", () => {
  it("restores missing proxy-env.sh from trusted packaged preloads", () => {
    const result = runGuardRecovery({});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PE_MISSING=0");
    expect(result.stdout).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.stdout).toContain(`--require ${result.paths.tmpCiao}`);
    expect(result.files.tmpSafetyNet).toContain("trusted safety net");
    expect(result.files.tmpCiao).toContain("trusted ciao guard");
    expect(result.files.tmpSafetyNetMode).toBe(0o444);
    expect(result.files.tmpCiaoMode).toBe(0o444);
    expect(result.files.proxyEnvMode).toBe(0o444);
    const proxyEnv = result.files.proxyEnv ?? "";
    expect(proxyEnv).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(proxyEnv).toContain(`--require ${result.paths.tmpCiao}`);
    expect(result.files.gatewayLog).toContain("[gateway-recovery] WARNING");
    expect(result.files.gatewayLog).toContain("restoring library guards");
  });

  it("does not accept substring matches as installed preload guards", () => {
    const result = runGuardRecovery({
      proxyEnvContent: `export NODE_OPTIONS="--require /tmp/not-nemoclaw-sandbox-safety-net.js --require /tmp/not-nemoclaw-ciao-network-guard.js"\n`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.stdout).toContain(`--require ${result.paths.tmpCiao}`);
  });

  it("does not duplicate exact --require entries", () => {
    const result = runGuardRecovery({
      proxyEnvContent: `export NODE_OPTIONS="--require ${SAFETY_NET_GUARD.tmpPath} --require=${CIAO_GUARD.tmpPath}"\n`,
    });
    expect(result.status).toBe(0);
    const nodeOptions = result.stdout.match(/^NODE_OPTIONS=(.*)$/m)?.[1] ?? "";
    expect(nodeOptions.match(new RegExp(result.paths.tmpSafetyNet, "g"))?.length).toBe(1);
    expect(nodeOptions.match(new RegExp(result.paths.tmpCiao, "g"))?.length).toBe(1);
  });

  it("replaces a symlinked tmp preload with a trusted staged file", () => {
    const result = runGuardRecovery({
      beforeScript(paths) {
        const target = path.join(paths.root, "attacker-controlled.js");
        fs.writeFileSync(target, "module.exports = 'wrong';\n");
        fs.symlinkSync(target, paths.tmpSafetyNet);
      },
    });
    expect(result.status).toBe(0);
    expect(result.files.tmpSafetyNetIsSymlink).toBe(false);
    expect(result.files.tmpSafetyNet).toContain("trusted safety net");
  });

  it("refuses recovery when a trusted packaged preload source is unavailable", () => {
    const result = runGuardRecovery({
      beforeScript(paths) {
        fs.rmSync(paths.sourceCiao);
      },
    });
    expect(result.status).toBe(17);
    expect(result.stdout).toContain("GUARDS_MISSING");
    expect(result.files.gatewayLog).toContain("trusted preload source");
    expect(result.files.gatewayLog).toContain("refusing preload install");
  });

  it("wires the repair helper into both recovery script builders", () => {
    const genericScript = buildRecoveryScript(minimalAgent, 19000);
    const openClawScript = buildOpenClawRecoveryScript(18789);
    for (const script of [genericScript, openClawScript]) {
      expect(script).toContain("restoring library guards from packaged preloads");
      expect(script).toContain("/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js");
      expect(script).toContain("/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js");
      expect(script).not.toContain("gateway launching without library guards");
    }
  });
});
