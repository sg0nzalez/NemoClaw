// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #3998 — `nemoclaw <sandbox> channels remove <channel>`
// must (1) strip the channel from session.policyPresets so onboard --resume
// does not re-apply the preset on rebuild, (2) wipe the channel's durable
// state inside the sandbox so the rebuild's state_dirs backup does not
// restore stale auth files, and (3) refuse to proceed to rebuild when the
// in-sandbox cleanup for a QR-paired channel fails — otherwise the backup
// would re-capture the auth blob and the channel would reconnect after
// the rebuild.

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

// Strip messaging-channel env vars from the parent process before spawning
// the test subprocess so local/CI ambient values (e.g. TELEGRAM_BOT_TOKEN
// in a developer shell) cannot perturb the channel cleanup paths the test
// is asserting against.
const MESSAGING_ENV_PREFIXES = [
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "WECHAT_",
  "WEIXIN_",
  "WHATSAPP_",
];

function buildCleanEnv(extraEnv: Record<string, string>, home: string): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "OPENSHELL_GATEWAY_ENDPOINT" ||
      MESSAGING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      continue;
    }
    filtered[key] = value;
  }
  return {
    ...filtered,
    HOME: home,
    NEMOCLAW_NON_INTERACTIVE: "1",
    ...extraEnv,
  };
}

function runScript(
  scriptBody: string,
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-3998-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: buildCleanEnv(extraEnv, tmpDir),
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

function buildPreamble({
  presetNamesApplied = ["npm", "pypi", "huggingface", "brew", "whatsapp"],
  sandboxAgent = "openclaw",
  channelInRegistry = "whatsapp",
  sandboxExecResult = { status: 0, stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n", stderr: "" },
  rejectSandboxExecRequest = false,
}: {
  presetNamesApplied?: string[];
  sandboxAgent?: string;
  channelInRegistry?: string;
  sandboxExecResult?: {
    status: number | null;
    stdout: string;
    stderr: string;
    errorMessage?: string;
    signal?: NodeJS.Signals | null;
  };
  rejectSandboxExecRequest?: boolean;
} = {}): string {
  const j = (p: string) =>
    JSON.stringify(path.join(repoRoot, "src", "lib", p.replace(/\.js$/, ".ts")));
  return String.raw`
const resolver = require(${j("adapters/openshell/resolve.js")});
resolver.resolveOpenshell = () => "/fake/openshell";

const runner = require(${j("runner.js")});
runner.run = () => ({ status: 0, stdout: "", stderr: "" });
runner.runCapture = () => "";

const adapterRuntime = require(${j("adapters/openshell/runtime.js")});
adapterRuntime.runOpenshell = () => ({ status: 0, stdout: "", stderr: "" });

const sandboxControl = require(${j("adapters/openshell/sandbox-control.js")});
const canonicalValidateOpenShellExecRequest = sandboxControl.validateOpenShellExecRequest;
const sandboxControlValidationCalls = [];
const sandboxControlCallOrder = [];
sandboxControl.validateOpenShellExecRequest = (request) => {
  sandboxControlValidationCalls.push(request);
  sandboxControlCallOrder.push("validate");
  return ${JSON.stringify(rejectSandboxExecRequest)}
    ? new Error("test rejected channel cleanup request")
    : canonicalValidateOpenShellExecRequest(request);
};

const sandboxControlRouting = require(${j("adapters/openshell/sandbox-control-routing.js")});
const sandboxExecCalls = [];
const sandboxControlSelections = [];
let sandboxControlCloseCalls = 0;
const configuredExecResult = ${JSON.stringify(sandboxExecResult)};
sandboxControlRouting.selectOpenShellSandboxControlForMutation = (gatewayName) => {
  sandboxControlSelections.push(gatewayName);
  sandboxControlCallOrder.push("select");
  return {
    transport: "grpc",
    control: {
      exec: async (request) => {
        sandboxExecCalls.push(request);
        sandboxControlCallOrder.push("exec");
        return {
          status: configuredExecResult.status,
          stdout: configuredExecResult.stdout,
          stderr: configuredExecResult.stderr,
          ...(configuredExecResult.errorMessage
            ? { error: new Error(configuredExecResult.errorMessage) }
            : {}),
          ...(configuredExecResult.signal ? { signal: configuredExecResult.signal } : {}),
        };
      },
    },
    close: () => { sandboxControlCloseCalls += 1; },
  };
};

const gatewayRuntime = require(${j("gateway-runtime-action.js")});
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({ recovered: true });

const credentials = require(${j("credentials/store.js")});
credentials.getCredential = () => null;
credentials.saveCredential = () => true;
credentials.deleteCredential = () => true;
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };

const onboard = require(${j("onboard.js")});
onboard.isNonInteractive = () => true;

const initialChannel = ${JSON.stringify(channelInRegistry)};
function makeMessagingPlan(channelIds = initialChannel ? [initialChannel] : [], disabledChannels = []) {
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName: "test-sb",
    agent: ${JSON.stringify(sandboxAgent)},
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: channelId === "whatsapp" ? "in-sandbox-qr" : "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels,
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

const onboardSession = require(${j("state/onboard-session.js")});
const sessionStore = {
  sandboxName: "test-sb",
  policyPresets: ${JSON.stringify(presetNamesApplied)},
  resumable: false,
  status: "complete",
  agent: ${JSON.stringify(sandboxAgent)},
  provider: null,
  model: null,
  endpointUrl: null,
  credentialEnv: null,
  hermesAuthMethod: null,
  preferredInferenceApi: null,
  nimContainer: null,
  routerPid: null,
  routerCredentialHash: null,
  policyTier: null,
  messagingPlan: makeMessagingPlan(),
  hermesToolGateways: [],
  wechatConfig: null,
};
onboardSession.loadSession = () => sessionStore;
onboardSession.updateSession = (mutate) => { mutate(sessionStore); };

const registry = require(${j("state/registry.js")});
const registryUpdates = [];
registry.getSandbox = () => ({
  name: "test-sb",
  agent: ${JSON.stringify(sandboxAgent)},
  gatewayName: "nemoclaw-19080",
  gatewayPort: 19080,
  messaging: { schemaVersion: 1, plan: makeMessagingPlan() },
  policies: ${JSON.stringify(presetNamesApplied)},
});
registry.updateSandbox = (name, updates) => {
  registryUpdates.push({ name, updates });
  return true;
};

const policies = require(${j("policy/index.js")});
const removedPresets = [];
policies.listPresets = () => ${JSON.stringify(presetNamesApplied.map((name) => ({ name })))};
policies.getAppliedPresets = () => ${JSON.stringify(presetNamesApplied)};
policies.removePreset = (sandboxName, presetName) => {
  removedPresets.push({ sandboxName, presetName });
  return true;
};

const callOrder = [];
const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (line.includes("Change queued")) callOrder.push("promptAndRebuild");
  if (line.includes("Cleared in-sandbox")) callOrder.push("clearedSandboxState");
  origLog.call(console, ...args);
};
const origExit = process.exit;
let exitCode = null;
process.exit = (code) => {
  if (exitCode === null) exitCode = code;
  throw new Error("__PROCESS_EXIT__:" + code);
};

const channelModule = require(${j("actions/sandbox/policy-channel.js")});

module.exports = {
  channelModule,
  sandboxExecCalls,
  sandboxControlValidationCalls,
  sandboxControlCallOrder,
  sandboxControlSelections,
  removedPresets,
  registryUpdates,
  sessionStore,
  callOrder,
  getSandboxControlCloseCalls: () => sandboxControlCloseCalls,
  getExitCode: () => exitCode,
};
`;
}

describe("channels remove full teardown (#3998)", () => {
  for (const sandboxAgent of ["openclaw", "hermes"] as const) {
    it(`strips '${sandboxAgent}' session.policyPresets and clears the in-sandbox whatsapp state dir`, () => {
      const script = `${buildPreamble({ sandboxAgent })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sandboxExecCalls: ctx.sandboxExecCalls,
      sandboxControlValidationCalls: ctx.sandboxControlValidationCalls,
      sandboxControlCallOrder: ctx.sandboxControlCallOrder,
      sandboxControlSelections: ctx.sandboxControlSelections,
      sandboxControlCloseCalls: ctx.getSandboxControlCloseCalls(),
      sessionPolicyPresets: ctx.sessionStore.policyPresets,
      removedPresets: ctx.removedPresets,
      callOrder: ctx.callOrder,
      exitCode: ctx.getExitCode(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
      const result = runScript(script);
      assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
      const marker = result.stdout.lastIndexOf("__RESULT__");
      assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
      const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
      assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);
      assert.equal(
        payload.exitCode,
        null,
        `must not exit on success path; got exitCode=${payload.exitCode}`,
      );

      assert.deepEqual(
        payload.removedPresets,
        [{ sandboxName: "test-sb", presetName: "whatsapp" }],
        `expected one removePreset('whatsapp') call; got ${JSON.stringify(payload.removedPresets)}`,
      );

      assert.ok(
        !payload.sessionPolicyPresets.includes("whatsapp"),
        `session.policyPresets must not contain 'whatsapp' after remove (resume would reapply it). Got: ${JSON.stringify(payload.sessionPolicyPresets)}`,
      );
      assert.deepEqual(
        payload.sessionPolicyPresets,
        ["npm", "pypi", "huggingface", "brew"],
        "non-channel presets must stay in session.policyPresets",
      );

      assert.equal(payload.sandboxExecCalls.length, 1, "cleanup must dispatch exactly once");
      assert.deepEqual(payload.sandboxControlValidationCalls, payload.sandboxExecCalls);
      assert.deepEqual(payload.sandboxControlCallOrder, ["validate", "select", "exec"]);
      assert.deepEqual(payload.sandboxControlSelections, ["nemoclaw-19080"]);
      assert.equal(payload.sandboxControlCloseCalls, 1, "selected control must close once");
      const cleanup = payload.sandboxExecCalls[0];
      assert.deepEqual(cleanup.command, ["sh", "-s"]);
      assert.equal(cleanup.timeoutMs, 30_000);
      assert.equal(cleanup.maxOutputBytes, 64 * 1024);
      assert.equal(typeof cleanup.stdin, "string");
      assert.equal(cleanup.stdin.endsWith("\n"), true);
      const expectedPath =
        sandboxAgent === "openclaw"
          ? "/sandbox/.openclaw/whatsapp"
          : "/sandbox/.hermes/platforms/whatsapp";
      assert.ok(
        cleanup.stdin.includes(expectedPath),
        `expected cleanup stdin to target '${expectedPath}'; got ${cleanup.stdin}`,
      );
      assert.match(cleanup.stdin, /printf '%s\\n' 'NEMOCLAW_CHANNEL_CLEAR_OK'/u);

      const rebuildIdx = payload.callOrder.indexOf("promptAndRebuild");
      const clearIdx = payload.callOrder.indexOf("clearedSandboxState");
      assert.ok(
        rebuildIdx >= 0,
        `promptAndRebuild was never called: ${JSON.stringify(payload.callOrder)}`,
      );
      assert.ok(
        clearIdx >= 0,
        `clearedSandboxState marker was never logged: ${JSON.stringify(payload.callOrder)}`,
      );
      assert.ok(
        clearIdx < rebuildIdx,
        `sandbox state must be cleared before rebuild so the backup excludes the auth files: ${JSON.stringify(payload.callOrder)}`,
      );
    });
  }

  for (const [label, sandboxExecResult] of [
    ["returns nonzero", { status: 1, stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n", stderr: "" }],
    ["has no exit status", { status: null, stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n", stderr: "" }],
    [
      "is signaled",
      {
        status: 0,
        stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n",
        stderr: "",
        signal: "SIGTERM" as NodeJS.Signals,
      },
    ],
    [
      "returns an error",
      {
        status: 0,
        stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n",
        stderr: "",
        errorMessage: "transport failed",
      },
    ],
    [
      "omits the exact marker",
      { status: 0, stdout: "prefix-NEMOCLAW_CHANNEL_CLEAR_OK", stderr: "" },
    ],
  ] as const) {
    it(`never replays cleanup when the selected mutation exec ${label}`, () => {
      const script = `${buildPreamble({ sandboxExecResult })}
const ctx = module.exports;
(async () => {
  const dumpState = () => ({
    sandboxExecCalls: ctx.sandboxExecCalls,
    sandboxControlSelections: ctx.sandboxControlSelections,
    sandboxControlCloseCalls: ctx.getSandboxControlCloseCalls(),
    sessionPolicyPresets: ctx.sessionStore.policyPresets,
    removedPresets: ctx.removedPresets,
    registryUpdates: ctx.registryUpdates,
    callOrder: ctx.callOrder,
    exitCode: ctx.getExitCode(),
  });
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify(dumpState()) + "\\n");
  } catch (err) {
    if (typeof err.message === "string" && err.message.startsWith("__PROCESS_EXIT__")) {
      process.stdout.write("\\n__RESULT__" + JSON.stringify(dumpState()) + "\\n");
      return;
    }
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
      const result = runScript(script);
      assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
      const marker = result.stdout.lastIndexOf("__RESULT__");
      assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
      const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
      assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

      assert.equal(payload.exitCode, 1, "QR channel cleanup failure must exit non-zero");
      assert.deepEqual(payload.sandboxControlSelections, ["nemoclaw-19080"]);
      assert.equal(payload.sandboxExecCalls.length, 1, "cleanup must never be replayed");
      assert.equal(payload.sandboxControlCloseCalls, 1, "selected control must close once");
      assert.ok(
        !payload.callOrder.includes("promptAndRebuild"),
        `rebuild must NOT be queued on cleanup failure; callOrder=${JSON.stringify(payload.callOrder)}`,
      );
      assert.deepEqual(payload.removedPresets, []);
      assert.deepEqual(payload.registryUpdates, []);
      assert.deepEqual(payload.sessionPolicyPresets, [
        "npm",
        "pypi",
        "huggingface",
        "brew",
        "whatsapp",
      ]);
    });
  }

  it("rejects an invalid cleanup request before selecting a mutation control", () => {
    const script = `${buildPreamble({ rejectSandboxExecRequest: true })}
const ctx = module.exports;
(async () => {
  const dumpState = () => ({
    sandboxExecCalls: ctx.sandboxExecCalls,
    sandboxControlValidationCalls: ctx.sandboxControlValidationCalls,
    sandboxControlCallOrder: ctx.sandboxControlCallOrder,
    sandboxControlSelections: ctx.sandboxControlSelections,
    sandboxControlCloseCalls: ctx.getSandboxControlCloseCalls(),
    removedPresets: ctx.removedPresets,
    callOrder: ctx.callOrder,
    exitCode: ctx.getExitCode(),
  });
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify(dumpState()) + "\\n");
  } catch (err) {
    const payload = String(err.message).startsWith("__PROCESS_EXIT__")
      ? dumpState()
      : { error: err.message, stack: err.stack };
    process.stdout.write("\\n__RESULT__" + JSON.stringify(payload) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.sandboxControlValidationCalls.length, 1);
    assert.deepEqual(payload.sandboxControlCallOrder, ["validate"]);
    assert.deepEqual(payload.sandboxControlSelections, []);
    assert.deepEqual(payload.sandboxExecCalls, []);
    assert.equal(payload.sandboxControlCloseCalls, 0);
    assert.deepEqual(payload.removedPresets, []);
    assert.ok(!payload.callOrder.includes("promptAndRebuild"));
  });

  it("rejects a process-level gateway endpoint override before cleanup selection", () => {
    const script = `${buildPreamble()}
const ctx = module.exports;
(async () => {
  const dumpState = () => ({
    sandboxExecCalls: ctx.sandboxExecCalls,
    sandboxControlSelections: ctx.sandboxControlSelections,
    sandboxControlCloseCalls: ctx.getSandboxControlCloseCalls(),
    removedPresets: ctx.removedPresets,
    callOrder: ctx.callOrder,
    exitCode: ctx.getExitCode(),
  });
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify(dumpState()) + "\\n");
  } catch (err) {
    const payload = String(err.message).startsWith("__PROCESS_EXIT__")
      ? dumpState()
      : { error: err.message, stack: err.stack };
    process.stdout.write("\\n__RESULT__" + JSON.stringify(payload) + "\\n");
  }
})();
`;
    const result = runScript(script, {
      OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:6553",
    });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);
    assert.equal(payload.exitCode, 1);
    assert.deepEqual(payload.sandboxControlSelections, []);
    assert.deepEqual(payload.sandboxExecCalls, []);
    assert.equal(payload.sandboxControlCloseCalls, 0);
    assert.deepEqual(payload.removedPresets, []);
    assert.ok(!payload.callOrder.includes("promptAndRebuild"));
  });

  it("treats a leftover session.policyPresets entry as residue and runs cleanup", () => {
    const script = `${buildPreamble({
      presetNamesApplied: ["npm", "pypi", "whatsapp"],
      sandboxAgent: "openclaw",
      channelInRegistry: "telegram",
    })}
const ctx = module.exports;
const registryOverride = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "state/registry.ts"))});
registryOverride.getSandbox = () => ({
  name: "test-sb",
  agent: "openclaw",
  gatewayName: "nemoclaw-19080",
  gatewayPort: 19080,
  policies: [],
});
const policiesOverride = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "policy/index.ts"))});
policiesOverride.getAppliedPresets = () => [];
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sandboxExecCalls: ctx.sandboxExecCalls,
      sessionPolicyPresets: ctx.sessionStore.policyPresets,
      callOrder: ctx.callOrder,
      exitCode: ctx.getExitCode(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.equal(payload.sandboxExecCalls.length, 1);
    assert.ok(payload.sandboxExecCalls[0].stdin.includes("/sandbox/.openclaw/whatsapp"));
    assert.ok(
      !payload.sessionPolicyPresets.includes("whatsapp"),
      `session.policyPresets must be stripped after the residue-driven cleanup`,
    );
    assert.equal(payload.exitCode, null, "must not abort when sandbox-exec succeeds");
  });

  it("does not abort when removing a never-configured QR channel even if sandbox is unreachable", () => {
    const script = `${buildPreamble({
      presetNamesApplied: ["npm", "pypi"],
      sandboxAgent: "openclaw",
      channelInRegistry: "telegram",
      sandboxExecResult: { status: 1, stdout: "", stderr: "sandbox is not running" },
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sandboxExecCalls: ctx.sandboxExecCalls,
      callOrder: ctx.callOrder,
      exitCode: ctx.getExitCode(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.equal(
      payload.exitCode,
      null,
      "must remain a no-op when registry shows no channel residue",
    );
    assert.equal(
      payload.sandboxExecCalls.length,
      0,
      `sandbox-exec cleanup must NOT run when channel was never configured; got ${JSON.stringify(payload.sandboxExecCalls)}`,
    );
    assert.ok(
      payload.callOrder.includes("promptAndRebuild"),
      `rebuild prompt must still fire on the no-op remove path; callOrder=${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("leaves non-whatsapp presets in session.policyPresets untouched when removing a token-based channel", () => {
    const script = `${buildPreamble({
      presetNamesApplied: ["npm", "pypi", "telegram", "brew"],
      sandboxAgent: "openclaw",
      channelInRegistry: "telegram",
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "telegram" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sessionPolicyPresets: ctx.sessionStore.policyPresets,
      registryUpdates: ctx.registryUpdates,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script, { TELEGRAM_BOT_TOKEN: "stub" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.ok(
      !payload.sessionPolicyPresets.includes("telegram"),
      `session.policyPresets must drop 'telegram' after channel remove. Got: ${JSON.stringify(payload.sessionPolicyPresets)}`,
    );
    assert.deepEqual(
      payload.sessionPolicyPresets,
      ["npm", "pypi", "brew"],
      "other presets must remain after removing a token-based channel",
    );

    const messagingPlanUpdate = payload.registryUpdates.find(
      (u: { updates: { messaging?: { plan?: { channels?: Array<{ channelId: string }> } } } }) =>
        u.updates.messaging?.plan,
    );
    assert.ok(
      messagingPlanUpdate,
      `expected an updateSandbox call that writes messaging.plan; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.deepEqual(
      messagingPlanUpdate.updates.messaging.plan.channels.map(
        (channel: { channelId: string }) => channel.channelId,
      ),
      [],
      "messaging.plan.channels must be empty after removing telegram",
    );
  });
});
