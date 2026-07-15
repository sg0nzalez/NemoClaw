// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import { testTimeoutOptions } from "./helpers/timeouts";

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function stopFixtureGateway(pidFile: string): void {
  spawnSync(
    "bash",
    [
      "-c",
      'test ! -s "$1" || { kill "$(cat "$1")" 2>/dev/null || true; sleep 0.1; }',
      "fixture-cleanup",
      pidFile,
    ],
    { stdio: "ignore" },
  );
}

describe("gateway readiness recovery", () => {
  it(
    "cleans the failed generation before retrying and converges on selected HTTP-ready state",
    testTimeoutOptions(40_000),
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-recovery-"));
      const fakeBin = path.join(tmpDir, "bin");
      const tracePath = path.join(tmpDir, "lifecycle.trace");
      const attemptPath = path.join(tmpDir, "attempt");
      const registrationPath = path.join(tmpDir, "registration");
      const selectedPath = path.join(tmpDir, "selected");
      const ownedVolumePath = path.join(tmpDir, "owned-volume");
      const gatewayPidPath = path.join(tmpDir, "gateway.pid");
      const gatewayReadyPath = path.join(tmpDir, "gateway.ready");
      const childPath = path.join(tmpDir, "run-recovery.cjs");
      const port = await reserveFreePort();
      const gatewayName = `nemoclaw-${String(port)}`;
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(tracePath, "");
      fs.writeFileSync(attemptPath, "0");
      fs.writeFileSync(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
set -euo pipefail
command="$*"
printf 'openshell:%s\\n' "$command" >> "$OPENSHELL_TEST_TRACE"

case "$command" in
  "--version")
    printf 'openshell 0.0.83\\n'
    ;;
  "gateway --help")
    printf 'Commands: start\\nLegacy command: gateway destroy\\n'
    ;;
  gateway\\ start\\ *)
    generation="$(( $(cat "$OPENSHELL_TEST_ATTEMPT") + 1 ))"
    printf '%s' "$generation" > "$OPENSHELL_TEST_ATTEMPT"
    case "$generation" in
      2)
        test ! -e "$OPENSHELL_TEST_REGISTRATION"
        test ! -e "$OPENSHELL_TEST_SELECTED"
        test ! -e "$OPENSHELL_TEST_OWNED_VOLUME"
        test ! -e "$OPENSHELL_TEST_GATEWAY_READY"
        ;;
    esac
    printf '%s' "$generation" > "$OPENSHELL_TEST_REGISTRATION"
    printf '%s' "$generation" > "$OPENSHELL_TEST_OWNED_VOLUME"
    case "$generation" in
      1) http_status=503 ;;
      *) http_status=200 ;;
    esac
    server_script='const fs=require("node:fs");const http=require("node:http");const ready=process.argv[1];const code=Number(process.argv[2]);const port=Number(process.argv[3]);const server=http.createServer((_req,res)=>{res.writeHead(code);res.end("gateway");});server.listen(port,"127.0.0.1",()=>fs.writeFileSync(ready,String(process.pid)));process.on("SIGTERM",()=>server.close(()=>{fs.rmSync(ready,{force:true});process.exit(0);}));'
    nohup "$OPENSHELL_TEST_NODE" -e "$server_script" "$OPENSHELL_TEST_GATEWAY_READY" "$http_status" "$OPENSHELL_TEST_PORT" >/dev/null 2>&1 &
    printf '%s' "$!" > "$OPENSHELL_TEST_GATEWAY_PID"
    for _ in $(seq 1 500); do
      test ! -s "$OPENSHELL_TEST_GATEWAY_READY" || break
      sleep 0.01
    done
    test -s "$OPENSHELL_TEST_GATEWAY_READY"
    ;;
  "gateway remove $OPENSHELL_TEST_GATEWAY_NAME")
    kill "$(cat "$OPENSHELL_TEST_GATEWAY_PID")" 2>/dev/null || true
    for _ in $(seq 1 500); do
      test -e "$OPENSHELL_TEST_GATEWAY_READY" || break
      sleep 0.01
    done
    test ! -e "$OPENSHELL_TEST_GATEWAY_READY"
    rm -f "$OPENSHELL_TEST_GATEWAY_PID" "$OPENSHELL_TEST_REGISTRATION" "$OPENSHELL_TEST_SELECTED"
    ;;
  "gateway select $OPENSHELL_TEST_GATEWAY_NAME")
    printf '%s' "$OPENSHELL_TEST_GATEWAY_NAME" > "$OPENSHELL_TEST_SELECTED"
    ;;
  "gateway info -g $OPENSHELL_TEST_GATEWAY_NAME"|"gateway info")
    generation="$(cat "$OPENSHELL_TEST_REGISTRATION" 2>/dev/null || true)"
    printf 'Gateway: %s\\nGateway endpoint: http://127.0.0.1:%s\\nGeneration: %s\\n' "$OPENSHELL_TEST_GATEWAY_NAME" "$OPENSHELL_TEST_PORT" "$generation"
    ;;
  "status")
    generation="$(cat "$OPENSHELL_TEST_REGISTRATION" 2>/dev/null || true)"
    selected="$(cat "$OPENSHELL_TEST_SELECTED" 2>/dev/null || true)"
    case "$generation:$selected" in
      "2:$OPENSHELL_TEST_GATEWAY_NAME") printf 'Gateway: %s\\nConnected\\n' "$OPENSHELL_TEST_GATEWAY_NAME" ;;
      *) printf 'Gateway: %s\\nDisconnected\\n' "$OPENSHELL_TEST_GATEWAY_NAME" ;;
    esac
    ;;
  "doctor logs --name $OPENSHELL_TEST_GATEWAY_NAME")
    printf 'fixture diagnostics\\n'
    ;;
  *)
    ;;
esac
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fakeBin, "docker"),
        `#!/usr/bin/env bash
set -euo pipefail
command="$*"
printf 'docker:%s\\n' "$command" >> "$OPENSHELL_TEST_TRACE"
case "$command" in
  "volume ls -q --filter name=openshell-cluster-$OPENSHELL_TEST_GATEWAY_NAME")
    test ! -e "$OPENSHELL_TEST_OWNED_VOLUME" || printf 'openshell-cluster-%s-owned\\n' "$OPENSHELL_TEST_GATEWAY_NAME"
    ;;
  "volume rm openshell-cluster-$OPENSHELL_TEST_GATEWAY_NAME-owned")
    rm -f "$OPENSHELL_TEST_OWNED_VOLUME"
    ;;
  *)
    ;;
esac
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        childPath,
        `const mod = require("module");
const originalLoad = mod._load;
const immediateRetry = async (operation, options) => {
  try {
    return await operation({ attemptNumber: 1, retriesLeft: 1 });
  } catch (firstError) {
    await options.onFailedAttempt(Object.assign(firstError, { attemptNumber: 1, retriesLeft: 1 }));
  }
  try {
    return await operation({ attemptNumber: 2, retriesLeft: 0 });
  } catch (secondError) {
    await options.onFailedAttempt(Object.assign(secondError, { attemptNumber: 2, retriesLeft: 0 }));
    throw secondError;
  }
};
immediateRetry.AbortError = class AbortError extends Error {};
// Keep the production HTTP probe itself; only bind its URL to this fixture's
// reserved plain-HTTP listener so endpoint selection is outside this lifecycle test.
const loadWithFixtureProbe = (request, parent, isMain) => {
  const loaded = originalLoad.call(mod, request, parent, isMain);
  return request === "./onboard/gateway-http-readiness"
    ? {
        ...loaded,
        isGatewayHttpReady: (timeoutMs, _url, method, signal) =>
          loaded.isGatewayHttpReady(
            timeoutMs,
            "http://127.0.0.1:" + process.env.OPENSHELL_TEST_PORT + "/",
            method,
            signal,
          ),
      }
    : loaded;
};
mod._load = function(request, parent, isMain) {
  return request === "p-retry" ? immediateRetry : loadWithFixtureProbe(request, parent, isMain);
};
Object.defineProperty(process, "platform", { value: "darwin" });
Object.defineProperty(process, "arch", { value: "x64" });
const onboard = require(${onboardPath});
(async () => {
  await onboard.startGateway(null);
  const status = onboard.runCaptureOpenshell(["status"], { ignoreError: true });
  const namedInfo = onboard.runCaptureOpenshell(["gateway", "info", "-g", process.env.OPENSHELL_TEST_GATEWAY_NAME], { ignoreError: true });
  const currentInfo = onboard.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  console.log("FINAL_SELECTED=" + String(onboard.isGatewayHealthy(status, namedInfo, currentInfo, process.env.OPENSHELL_TEST_GATEWAY_NAME)));
  console.log("FINAL_HTTP=" + String(await onboard.isGatewayHttpReady()));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`,
      );

      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(process.execPath, [childPath], {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: tmpDir,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            NEMOCLAW_GATEWAY_PORT: String(port),
            NEMOCLAW_GATEWAY_START_TIMEOUT: "10",
            NEMOCLAW_HEALTH_POLL_COUNT: "1",
            NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
            NEMOCLAW_NON_INTERACTIVE: "1",
            OPENSHELL_TEST_ATTEMPT: attemptPath,
            OPENSHELL_TEST_GATEWAY_NAME: gatewayName,
            OPENSHELL_TEST_GATEWAY_PID: gatewayPidPath,
            OPENSHELL_TEST_GATEWAY_READY: gatewayReadyPath,
            OPENSHELL_TEST_NODE: process.execPath,
            OPENSHELL_TEST_OWNED_VOLUME: ownedVolumePath,
            OPENSHELL_TEST_PORT: String(port),
            OPENSHELL_TEST_REGISTRATION: registrationPath,
            OPENSHELL_TEST_SELECTED: selectedPath,
            OPENSHELL_TEST_TRACE: tracePath,
          },
        });
        const stdout = String(result.stdout ?? "");

        assert.equal(
          result.status,
          0,
          `unexpected exit; stdout:\n${result.stdout}\nstderr:\n${result.stderr}\ntrace:\n${fs.readFileSync(tracePath, "utf8")}`,
        );
        assert.match(stdout, /FINAL_SELECTED=true/);
        assert.match(stdout, /FINAL_HTTP=true/);
        assert.equal(fs.readFileSync(attemptPath, "utf8"), "2");
        assert.equal(fs.readFileSync(registrationPath, "utf8"), "2");
        assert.equal(fs.readFileSync(selectedPath, "utf8"), gatewayName);
        assert.equal(fs.readFileSync(ownedVolumePath, "utf8"), "2");

        const trace = fs.readFileSync(tracePath, "utf8").trim().split("\n");
        const starts = trace
          .map((line, index) => ({ index, line }))
          .filter(({ line }) => line.startsWith("openshell:gateway start "));
        const removeIndex = trace.indexOf(`openshell:gateway remove ${gatewayName}`);
        const volumeCleanupIndex = trace.indexOf(
          `docker:volume rm openshell-cluster-${gatewayName}-owned`,
        );
        assert.equal(starts.length, 2, trace.join("\n"));
        assert.ok(removeIndex > starts[0].index, trace.join("\n"));
        assert.ok(volumeCleanupIndex > removeIndex, trace.join("\n"));
        assert.ok(starts[1].index > volumeCleanupIndex, trace.join("\n"));
      } finally {
        stopFixtureGateway(gatewayPidPath);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
