// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOpenshell } from "../../../src/lib/adapters/openshell/resolve.ts";
import {
  hasRequiredOpenshellMessagingFeatures,
  REQUIRED_OPENSHELL_MCP_FEATURES,
} from "../../../src/lib/onboard/openshell-feature-gate.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import { parseJsonFromText } from "./json-envelope.ts";

// Keep this contract as a focused live test: build a deterministic custom plugin
// on top of the complete managed runtime, prove it survives restart/rebuild, then
// run the in-sandbox Node replacement probe that guards #3513/#3127's EXDEV
// cross-device runtime-deps failure mode. No registry or ledger is required.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CUSTOM_DOCKERFILE = path.join(REPO_ROOT, "Dockerfile.e2e-weather-plugin");
const CUSTOM_PLUGIN_VERSION_SOURCE = path.join(
  REPO_ROOT,
  "Dockerfile.e2e-weather-plugin.version.ts",
);
const WEATHER_FIXTURE_PACKAGE_PATH = path.join(
  REPO_ROOT,
  "test/e2e/fixtures/plugins/weather/package.json",
);
const WEATHER_FIXTURE_PACKAGE = JSON.parse(
  fs.readFileSync(WEATHER_FIXTURE_PACKAGE_PATH, "utf8"),
) as {
  openclaw?: { build?: { openclawVersion?: unknown } };
  devDependencies?: { openclaw?: unknown };
};
const weatherOpenClawVersion = WEATHER_FIXTURE_PACKAGE.openclaw?.build?.openclawVersion;
assert.equal(
  typeof weatherOpenClawVersion,
  "string",
  "weather fixture must declare an OpenClaw build version",
);
const WEATHER_OPENCLAW_VERSION = String(weatherOpenClawVersion);
assert.match(
  WEATHER_OPENCLAW_VERSION,
  /^\d+(?:\.\d+)+$/,
  "weather fixture must declare a canonical OpenClaw build version",
);
// Keep the dependency layer reproducible while the current managed Dockerfile
// upgrades its OpenClaw runtime to WEATHER_OPENCLAW_VERSION. The assertions in
// createCustomPluginDockerfile and the in-sandbox probe make that boundary explicit.
const SANDBOX_BASE_IMAGE_REF = "ghcr.io/nvidia/nemoclaw/sandbox-base:v0.0.71";
const TOOL_DISCLOSURE_ENV_REFERENCE = "${NEMOCLAW_TOOL_DISCLOSURE}";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-openclaw-plugin-exdev";
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const REBUILD_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
const EXDEV_TMPFS_MOUNT = "/tmp/nemoclaw-exdev-tmpfs";
const EXDEV_TMPFS_SOURCE = `${EXDEV_TMPFS_MOUNT}/source`;
const EXDEV_TMPFS_MOUNT_CONFIG = {
  type: "tmpfs",
  target: EXDEV_TMPFS_MOUNT,
  options: ["rw", "nosuid", "nodev", "noexec"],
  size_bytes: 16_777_216,
  mode: 0o1777,
} as const;
const EXDEV_TMPFS_DRIVER_CONFIG = JSON.stringify({
  docker: {
    mounts: [EXDEV_TMPFS_MOUNT_CONFIG],
  },
  podman: {
    mounts: [EXDEV_TMPFS_MOUNT_CONFIG],
  },
});
const DELEGATED_CAPABILITY_COMMENT_PREFIX =
  "# TEST-ONLY delegated-capability marker from validated canonical OpenShell: ";
const STOCK_OPENCLAW_POLICY_PATHS = [
  path.join(REPO_ROOT, "agents", "openclaw", "policy-permissive.yaml"),
  path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
  path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"),
] as const;
validateSandboxName(SANDBOX_NAME);

const EXDEV_PATTERNS = [
  /EXDEV: cross-device link not permitted/i,
  /cross-device link not permitted/i,
];
const liveTest = shouldRunLiveE2E() ? test : test.skip;
type WeatherFixtureVersion = "v1" | "v2";

const GATEWAY_CATALOG_CALL_SOURCE = String.raw`
import { Buffer } from "node:buffer";
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function findOnPath(command) {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Could not find " + command + " on PATH");
}

const port = process.env.OPENCLAW_GATEWAY_PORT || "18789";
if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
  throw new Error("OPENCLAW_GATEWAY_PORT must be a canonical TCP port in 1..65535");
}
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is required");

const openclawBin = realpathSync(findOnPath("openclaw"));
const requireFromOpenclaw = createRequire(openclawBin);
const runtimePath = requireFromOpenclaw.resolve("openclaw/plugin-sdk/gateway-runtime");
const { callGatewayFromCli } = await import(pathToFileURL(runtimePath).href);
const params = JSON.parse(
  Buffer.from(process.env.NEMOCLAW_E2E_GATEWAY_PARAMS_B64 || "e30=", "base64").toString("utf8"),
);
const result = await callGatewayFromCli(
  "tools.catalog",
  { url: "ws://127.0.0.1:" + port, token, timeout: "30000", json: true },
  params,
  { clientName: "gateway-client", mode: "backend", scopes: ["operator.read"], progress: false },
);
process.stdout.write(JSON.stringify(result) + "\n");
`.trim();

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function normalizeSandboxStdoutFrames(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\[stdout\]|stdout:)\s*/i, ""))
    .join("\n");
}

function liveEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort: local machines may not have a completed install or an
    // OpenShell gateway yet, and cleanup should not mask the real assertion.
  }
}

type OpenShellTmpfsWrapper = {
  directory: string;
  executable: string;
  remove(): void;
};

type PinnedOpenShellComponents = {
  cli: string;
  gateway: string;
  sandbox: string;
};

function createOpenShellTmpfsWrapper(realOpenshellPath: string): OpenShellTmpfsWrapper {
  if (!path.isAbsolute(realOpenshellPath)) {
    throw new Error("real OpenShell path must be absolute");
  }
  fs.accessSync(realOpenshellPath, fs.constants.X_OK);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-openshell-wrapper-"));
  const executable = path.join(directory, "openshell");
  const delegatedCapabilityComments = REQUIRED_OPENSHELL_MCP_FEATURES.map((marker) => {
    assert.match(marker, /^[A-Za-z0-9_-]+$/, "delegated OpenShell capability marker must be safe");
    return `${DELEGATED_CAPABILITY_COMMENT_PREFIX}${marker}`;
  }).join("\n");
  const script = `#!/bin/sh
${delegatedCapabilityComments}
set -eu
if [ "$#" -ge 2 ] && [ "$1" = sandbox ] && [ "$2" = create ]; then
  shift 2
  for argument in "$@"; do
    case "$argument" in
      --driver-config-json|--driver-config-json=*)
        printf '%s\n' 'refusing duplicate --driver-config-json in EXDEV test wrapper' >&2
        exit 64
        ;;
    esac
  done
  exec ${shellQuote(realOpenshellPath)} sandbox create --driver-config-json ${shellQuote(EXDEV_TMPFS_DRIVER_CONFIG)} "$@"
fi
exec ${shellQuote(realOpenshellPath)} "$@"
`;
  fs.writeFileSync(executable, script, { encoding: "utf8", mode: 0o700 });

  return {
    directory,
    executable,
    remove: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function withOpenShellWrapperEnv(
  env: NodeJS.ProcessEnv,
  wrapper: OpenShellTmpfsWrapper,
  components: PinnedOpenShellComponents,
): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: `${wrapper.directory}${path.delimiter}${env.PATH ?? ""}`,
    NEMOCLAW_OPENSHELL_BIN: wrapper.executable,
    NEMOCLAW_OPENSHELL_GATEWAY_BIN: components.gateway,
    NEMOCLAW_OPENSHELL_SANDBOX_BIN: components.sandbox,
  };
}

function resolvePinnedOpenShellComponents(openshellPath: string): PinnedOpenShellComponents {
  const cli = fs.realpathSync(openshellPath);
  fs.accessSync(cli, fs.constants.X_OK);
  const installDirectory = path.dirname(cli);
  const canonicalSibling = (name: string): string => {
    const sibling = fs.realpathSync(path.join(installDirectory, name));
    fs.accessSync(sibling, fs.constants.X_OK);
    return sibling;
  };
  return {
    cli,
    gateway: canonicalSibling("openshell-gateway"),
    sandbox: canonicalSibling("openshell-sandbox"),
  };
}

async function installAndResolvePinnedOpenShell(
  host: HostCliClient,
): Promise<PinnedOpenShellComponents> {
  const install = await host.command(
    "bash",
    [path.join(REPO_ROOT, "scripts", "install-openshell.sh")],
    {
      artifactName: "install-pinned-openshell-for-exdev-wrapper",
      env: liveEnv(),
      timeoutMs: 5 * 60_000,
    },
  );
  expect(install.exitCode, resultText(install)).toBe(0);
  const resolved = resolveOpenshell();
  expect(resolved, "pinned OpenShell installer did not leave an executable CLI").not.toBeNull();
  return resolvePinnedOpenShellComponents(resolved as string);
}

type PolicySourceSnapshot = ReadonlyArray<{ policyPath: string; bytes: Buffer }>;

function snapshotPolicySources(): PolicySourceSnapshot {
  return STOCK_OPENCLAW_POLICY_PATHS.map((policyPath) => ({
    policyPath,
    bytes: fs.readFileSync(policyPath),
  }));
}

function assertPolicySourcesUnchanged(snapshot: PolicySourceSnapshot, phase: string): void {
  for (const { policyPath, bytes } of snapshot) {
    expect(fs.readFileSync(policyPath), `${policyPath} changed during ${phase}`).toEqual(bytes);
  }
}

function runWrapper(wrapper: string, args: readonly string[]): string[] {
  const result = spawnSync(wrapper, args, { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trimEnd().split("\n");
}

test("OpenShell wrapper injects only the reviewed tmpfs config into sandbox create", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-wrapper-contract-"));
  const delegate = path.join(fixture, "real-openshell");
  const gateway = path.join(fixture, "openshell-gateway");
  const sandbox = path.join(fixture, "openshell-sandbox");
  const executableSource = "#!/bin/sh\nprintf '%s\\n' \"$@\"\n";
  for (const executable of [delegate, gateway, sandbox]) {
    fs.writeFileSync(executable, executableSource, {
      encoding: "utf8",
      mode: 0o700,
    });
  }
  const components = resolvePinnedOpenShellComponents(delegate);
  const wrapper = createOpenShellTmpfsWrapper(components.cli);
  try {
    const wrapperSource = fs.readFileSync(wrapper.executable, "utf8");
    expect(
      wrapperSource
        .split("\n")
        .filter((line) => line.startsWith(DELEGATED_CAPABILITY_COMMENT_PREFIX)),
    ).toEqual(
      REQUIRED_OPENSHELL_MCP_FEATURES.map(
        (marker) => `${DELEGATED_CAPABILITY_COMMENT_PREFIX}${marker}`,
      ),
    );
    for (const marker of REQUIRED_OPENSHELL_MCP_FEATURES) {
      expect(wrapperSource.split(marker)).toHaveLength(2);
    }
    expect(components).toEqual({
      cli: fs.realpathSync(delegate),
      gateway: fs.realpathSync(gateway),
      sandbox: fs.realpathSync(sandbox),
    });
    expect(withOpenShellWrapperEnv({ PATH: "/usr/bin" }, wrapper, components)).toMatchObject({
      PATH: `${wrapper.directory}${path.delimiter}/usr/bin`,
      NEMOCLAW_OPENSHELL_BIN: wrapper.executable,
      NEMOCLAW_OPENSHELL_GATEWAY_BIN: components.gateway,
      NEMOCLAW_OPENSHELL_SANDBOX_BIN: components.sandbox,
    });
    expect(JSON.parse(EXDEV_TMPFS_DRIVER_CONFIG)).toEqual({
      docker: {
        mounts: [EXDEV_TMPFS_MOUNT_CONFIG],
      },
      podman: {
        mounts: [EXDEV_TMPFS_MOUNT_CONFIG],
      },
    });
    expect(
      runWrapper(wrapper.executable, [
        "sandbox",
        "create",
        "--name",
        "demo",
        "--",
        "sh",
        "-lc",
        "printf value",
      ]),
    ).toEqual([
      "sandbox",
      "create",
      "--driver-config-json",
      EXDEV_TMPFS_DRIVER_CONFIG,
      "--name",
      "demo",
      "--",
      "sh",
      "-lc",
      "printf value",
    ]);
    expect(runWrapper(wrapper.executable, ["sandbox", "delete", "demo"])).toEqual([
      "sandbox",
      "delete",
      "demo",
    ]);
    expect(runWrapper(wrapper.executable, ["--version"])).toEqual(["--version"]);
    const duplicateConfig = spawnSync(
      wrapper.executable,
      ["sandbox", "create", "--driver-config-json", "{}"],
      { encoding: "utf8" },
    );
    expect(duplicateConfig.status).toBe(64);
    expect(duplicateConfig.stderr).toContain("refusing duplicate --driver-config-json");
  } finally {
    wrapper.remove();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  expect(fs.existsSync(wrapper.directory)).toBe(false);
});

function writeCustomPluginVersion(version: WeatherFixtureVersion): void {
  fs.writeFileSync(
    CUSTOM_PLUGIN_VERSION_SOURCE,
    `// Generated by the OpenClaw plugin lifecycle E2E.\nexport const WEATHER_FIXTURE_VERSION = ${JSON.stringify(version)};\n`,
    "utf8",
  );
}

function createCustomPluginDockerfile(): () => void {
  const sourceDockerfile = path.join(REPO_ROOT, "Dockerfile");
  const source = fs.readFileSync(sourceDockerfile, "utf8");
  const baseImageAnchor = "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n";
  const runtimeAnchor = "FROM ${BASE_IMAGE}\n";
  expect(
    source.match(/^ARG BASE_IMAGE=ghcr\.io\/nvidia\/nemoclaw\/sandbox-base:latest$/gm)?.length,
  ).toBe(1);
  expect(source.match(/^FROM \$\{BASE_IMAGE\}$/gm)?.length, "expected one runtime stage").toBe(1);
  expect(
    source.match(/^ARG OPENCLAW_VERSION=([0-9.]+)$/m)?.[1],
    "weather fixture SDK must match the current managed runtime target",
  ).toBe(WEATHER_OPENCLAW_VERSION);
  expect(
    WEATHER_FIXTURE_PACKAGE.devDependencies?.openclaw,
    "weather fixture devDependency must match its declared OpenClaw build target",
  ).toBe(WEATHER_OPENCLAW_VERSION);

  const runtime = source
    .replace(baseImageAnchor, `ARG BASE_IMAGE=${SANDBOX_BASE_IMAGE_REF}\n`)
    .replace(runtimeAnchor, "FROM ${BASE_IMAGE} AS nemoclaw-runtime\n");
  const extension = String.raw`

# Build the deterministic custom-plugin fixture used by this live contract.
FROM builder AS weather-plugin-builder
WORKDIR /opt/weather
COPY test/e2e/fixtures/plugins/weather/package.json test/e2e/fixtures/plugins/weather/package-lock.json test/e2e/fixtures/plugins/weather/tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY test/e2e/fixtures/plugins/weather/openclaw.plugin.json ./
COPY test/e2e/fixtures/plugins/weather/src/ ./src/
COPY Dockerfile.e2e-weather-plugin.version.ts ./src/version.ts
RUN npm run build \
    && npm prune --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund \
    && test ! -e node_modules/openclaw \
    && sha256sum dist/index.js dist/version.js | sha256sum | cut -d ' ' -f 1 > e2e-weather-plugin.sha256

# Extend the completed managed runtime so its entrypoint, health check, config
# generation, and permissions remain the source of truth.
FROM nemoclaw-runtime AS weather-runtime
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive
ENV NEMOCLAW_TOOL_DISCLOSURE=${TOOL_DISCLOSURE_ENV_REFERENCE}
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/package.json \
    /opt/weather/package-lock.json \
    /opt/weather/openclaw.plugin.json \
    /opt/weather-plugin/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/dist/ /opt/weather-plugin/dist/
COPY --from=weather-plugin-builder --chown=sandbox:sandbox \
    /opt/weather/node_modules/ /opt/weather-plugin/node_modules/
COPY --from=weather-plugin-builder \
    /opt/weather/e2e-weather-plugin.sha256 \
    /usr/local/share/nemoclaw/e2e-weather-plugin.sha256

USER sandbox
RUN test ! -e /opt/weather-plugin/node_modules/openclaw \
    && HOME=/sandbox openclaw plugins install /opt/weather-plugin \
    && test -L /sandbox/.openclaw/extensions/weather/node_modules/openclaw \
    && test "$(realpath /sandbox/.openclaw/extensions/weather/node_modules/openclaw)" = /usr/local/lib/node_modules/openclaw \
    && HOME=/sandbox openclaw plugins enable weather \
    && HOME=/sandbox openclaw plugins inspect weather --json > /dev/null

# Enabling the plugin changes openclaw.json after the managed runtime hashes it.
# hadolint ignore=DL3002
USER root
RUN chown sandbox:sandbox /sandbox/.openclaw/openclaw.json \
    && chmod 660 /sandbox/.openclaw/openclaw.json \
    && sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chown sandbox:sandbox /sandbox/.openclaw/.config-hash \
    && chmod 660 /sandbox/.openclaw/.config-hash
`;
  writeCustomPluginVersion("v1");
  fs.writeFileSync(CUSTOM_DOCKERFILE, runtime.trimEnd() + extension, "utf8");
  return () => {
    fs.rmSync(CUSTOM_DOCKERFILE, { force: true });
    fs.rmSync(CUSTOM_PLUGIN_VERSION_SOURCE, { force: true });
  };
}

type WeatherPluginInspect = {
  plugin?: { id?: unknown; status?: unknown; toolNames?: unknown };
  tools?: Array<{ names?: unknown }>;
};

type GatewayToolCatalog = {
  groups?: Array<{ tools?: Array<{ id?: unknown }> }>;
};

type GatewayToolInvocation = {
  ok?: unknown;
  result?: { details?: unknown };
};

type WeatherRuntimeProof = {
  imageMarker: string;
  fixtureVersion: WeatherFixtureVersion;
  inspectLoaded: boolean;
  catalogToolIds: string[];
  toolInvoked: boolean;
};

function gatewayCatalogCallScript(params: Record<string, unknown>) {
  const source = Buffer.from(GATEWAY_CATALOG_CALL_SOURCE, "utf8").toString("base64");
  const encodedParams = Buffer.from(JSON.stringify(params), "utf8").toString("base64");
  return trustedSandboxShellScript(`set -eu
. /tmp/nemoclaw-proxy-env.sh
export HOME=/sandbox
export NO_PROXY=127.0.0.1,localhost
export no_proxy="$NO_PROXY"
export NEMOCLAW_E2E_GATEWAY_PARAMS_B64='${encodedParams}'
exec node --input-type=module --eval 'await import("data:text/javascript;base64," + process.argv[1])' '${source}'`);
}

async function assertWeatherPluginRuntime(
  sandbox: SandboxClient,
  phase: string,
  expectedFixtureVersion: WeatherFixtureVersion,
): Promise<WeatherRuntimeProof> {
  const imageProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(`set -eu
test -s /tmp/gateway.log
test -s /usr/local/share/nemoclaw/e2e-weather-plugin.sha256
test "$(openclaw --version 2>/dev/null | awk '{print $2}')" = "${WEATHER_OPENCLAW_VERSION}"
test -L /sandbox/.openclaw/extensions/weather/node_modules/openclaw
test "$(realpath /sandbox/.openclaw/extensions/weather/node_modules/openclaw)" = /usr/local/lib/node_modules/openclaw
expected=$(cat /usr/local/share/nemoclaw/e2e-weather-plugin.sha256)
actual=$(cd /sandbox/.openclaw/extensions/weather && sha256sum dist/index.js dist/version.js | sha256sum | cut -d ' ' -f 1)
[ "$expected" = "$actual" ]
printf '%s\\n' "$actual"`),
    {
      artifactName: `openclaw-weather-plugin-image-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(imageProbe.exitCode, resultText(imageProbe)).toBe(0);
  const imageMarker = normalizeSandboxStdoutFrames(imageProbe.stdout).match(
    /(?:^|\n)([a-f0-9]{64})(?:\r?\n|$)/,
  )?.[1];
  expect(imageMarker).toMatch(/^[a-f0-9]{64}$/);

  const inspectProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript("HOME=/sandbox openclaw plugins inspect weather --runtime --json"),
    {
      artifactName: `openclaw-weather-plugin-inspect-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(inspectProbe.exitCode, resultText(inspectProbe)).toBe(0);
  const inspect = parseJsonFromText(
    normalizeSandboxStdoutFrames(inspectProbe.stdout),
  ) as WeatherPluginInspect;
  expect(inspect.plugin?.id).toBe("weather");
  expect(inspect.plugin?.status).toBe("loaded");
  expect(inspect.plugin?.toolNames).toContain("get_weather");
  expect(inspect.tools?.flatMap((tool) => (Array.isArray(tool.names) ? tool.names : []))).toContain(
    "get_weather",
  );

  // Exercise OpenClaw's documented HTTP tool surface with the managed bearer
  // token supplied on stdin so the credential never enters process arguments.
  const invokeProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `. /tmp/nemoclaw-proxy-env.sh && printf 'header = "Authorization: Bearer %s"\\n' "$OPENCLAW_GATEWAY_TOKEN" | curl --noproxy '*' --max-time 30 --silent --show-error --fail-with-body --config - -H 'Content-Type: application/json' --data '{"agentId":"main","tool":"get_weather","args":{"location":"Santa Clara"}}' "http://127.0.0.1:\${OPENCLAW_GATEWAY_PORT:-18789}/tools/invoke"`,
    ),
    {
      artifactName: `openclaw-weather-plugin-invoke-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(invokeProbe.exitCode, resultText(invokeProbe)).toBe(0);
  const invocation = parseJsonFromText(
    normalizeSandboxStdoutFrames(invokeProbe.stdout),
  ) as GatewayToolInvocation;
  expect(invocation).toMatchObject({
    ok: true,
    result: {
      details: {
        location: "Santa Clara",
        condition: "clear",
        temperatureC: 21,
        fixtureVersion: expectedFixtureVersion,
      },
    },
  });

  // Mirror NemoClaw's trusted internal read-only gateway client for the RPC
  // catalog proof without creating a user-facing CLI device or weakening auth.
  const catalogProbe = await sandbox.execShell(
    SANDBOX_NAME,
    gatewayCatalogCallScript({ agentId: "main", includePlugins: true }),
    {
      artifactName: `openclaw-weather-plugin-catalog-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(catalogProbe.exitCode, resultText(catalogProbe)).toBe(0);
  const catalog = parseJsonFromText(
    normalizeSandboxStdoutFrames(catalogProbe.stdout),
  ) as GatewayToolCatalog;
  const catalogToolIds = (catalog.groups ?? []).flatMap((group) =>
    (group.tools ?? []).map((tool) => tool.id).filter((id): id is string => typeof id === "string"),
  );
  expect(catalogToolIds).toContain("get_weather");
  return {
    imageMarker: imageMarker ?? "",
    fixtureVersion: expectedFixtureVersion,
    inspectLoaded: true,
    catalogToolIds,
    toolInvoked: true,
  };
}

async function assertExdevTmpfsMounted(sandbox: SandboxClient, phase: string): Promise<boolean> {
  const result = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(`set -eu
awk -v target='${EXDEV_TMPFS_MOUNT}' '$5 == target { found = 1 } END { exit found ? 0 : 1 }' /proc/self/mountinfo
mkdir -p ${EXDEV_TMPFS_SOURCE}
test -d ${EXDEV_TMPFS_SOURCE}
mount_device=$(stat -c '%d' ${EXDEV_TMPFS_MOUNT})
tmp_device=$(stat -c '%d' /tmp)
test "$mount_device" != "$tmp_device"
printf 'tmpfs_mount=%s source=%s mount_device=%s tmp_device=%s\n' '${EXDEV_TMPFS_MOUNT}' '${EXDEV_TMPFS_SOURCE}' "$mount_device" "$tmp_device"`),
    {
      artifactName: `openclaw-plugin-exdev-tmpfs-${phase}`,
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(resultText(result)).toContain(`tmpfs_mount=${EXDEV_TMPFS_MOUNT}`);
  expect(resultText(result)).toContain(`source=${EXDEV_TMPFS_SOURCE}`);
  return true;
}

const runtimeDepsReplacementProbeSource = `set -eu
rm -rf /sandbox/.openclaw/plugin-runtime-deps/exdev-guard 2>/dev/null || true
rm -rf ${EXDEV_TMPFS_SOURCE}
mkdir -p ${EXDEV_TMPFS_SOURCE} /sandbox/.openclaw/plugin-runtime-deps/exdev-guard
printf 'ok\n' >${EXDEV_TMPFS_SOURCE}/package.txt
source_device=$(stat -c '%d' ${EXDEV_TMPFS_SOURCE})
target_device=$(stat -c '%d' /sandbox/.openclaw/plugin-runtime-deps/exdev-guard)
printf 'source_device=%s target_device=%s\n' "$source_device" "$target_device"
if [ "$source_device" = "$target_device" ]; then
  printf 'EXDEV guard did not get distinct filesystems for ${EXDEV_TMPFS_SOURCE} and /sandbox plugin-runtime-deps\n' >&2
  exit 2
fi
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
function assertLegacySourceSideStagingFailsWithExdev(targetDir, sourceDir) {
  const sourceParentDir = path.dirname(sourceDir);
  const tempDir = fs.mkdtempSync(path.join(sourceParentDir, '.openclaw-runtime-deps-source-side-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    const sourceDevice = fs.statSync(sourceDir).dev;
    const stagedDevice = fs.statSync(stagedDir).dev;
    const targetParentDevice = fs.statSync(path.dirname(targetDir)).dev;
    if (stagedDevice !== sourceDevice || stagedDevice === targetParentDevice) {
      throw new Error(
        'legacy self-check lost cross-device layout: source=' +
          sourceDevice +
          ' staged=' +
          stagedDevice +
          ' target_parent=' +
          targetParentDevice,
      );
    }
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(stagedDir, targetDir);
      throw new Error('legacy source-side staging unexpectedly renamed across devices');
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        console.log('source-side staging failure self-check completed');
        return;
      }
      throw error;
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.dirname(targetDir), { recursive: true, force: true }); } catch {}
  }
}
function replaceNodeModulesDir(targetDir, sourceDir) {
  const targetParentDir = path.dirname(targetDir);
  fs.mkdirSync(targetParentDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(targetParentDir, '.openclaw-runtime-deps-copy-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}
assertLegacySourceSideStagingFailsWithExdev(
  '/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/source-side-regression/node_modules',
  '${EXDEV_TMPFS_SOURCE}',
);
replaceNodeModulesDir('/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/node_modules', '${EXDEV_TMPFS_SOURCE}');
console.log('runtime deps replacement completed');
NODE`;

const runtimeDepsReplacementProbe = trustedSandboxShellScript(
  `printf '%s' '${Buffer.from(runtimeDepsReplacementProbeSource).toString("base64")}' | base64 -d > /tmp/nemoclaw-exdev-guard.sh && sh /tmp/nemoclaw-exdev-guard.sh`,
);

liveTest(
  "a custom OpenClaw plugin survives restart and rebuild without EXDEV failures (#6108)",
  { timeout: ONBOARD_TIMEOUT_MS + REBUILD_TIMEOUT_MS + 15 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    await artifacts.writeJson("target.json", {
      id: "openclaw-plugin-runtime-exdev",
      runner: "vitest",
      boundary: "fresh-openclaw-sandbox-exec",
      regressionTargets: ["#6108", "#3513", "#3127"],
      contract: [
        "fresh OpenClaw sandbox onboards from a full managed custom-plugin Dockerfile",
        "release-matched peer/dev dependencies prune private OpenClaw and link the host runtime",
        "gateway log, runtime inspection, tools.catalog, and tools.invoke prove weather/get_weather",
        "custom-plugin v1 survives restart and a rebuilt v2 replaces it without backup rollback",
        `test-only driver config mounts tmpfs at ${EXDEV_TMPFS_MOUNT} without changing production policies`,
        "stock OpenClaw policy source bytes remain unchanged through onboard and rebuild",
        `sandbox proves ${EXDEV_TMPFS_SOURCE} and plugin-runtime-deps are distinct devices`,
        `legacy source-side staging fails with EXDEV across the same ${EXDEV_TMPFS_SOURCE} to plugin-runtime-deps boundary`,
        "OpenClaw-style target-side plugin runtime-deps replacement completes without EXDEV",
      ],
      sandboxBaseImageRef: SANDBOX_BASE_IMAGE_REF,
      openclawVersion: WEATHER_OPENCLAW_VERSION,
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-openclaw-plugin-exdev",
      env: liveEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for the OpenClaw plugin EXDEV live guard: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for the OpenClaw plugin EXDEV live guard");
    }

    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "bin/nemoclaw.js missing — run npm run build:cli before this live target",
    ).toBe(true);

    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      const cleanupEnv = liveEnv();
      await ignoreCleanupError(() =>
        host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-openclaw-plugin-exdev",
          env: cleanupEnv,
          timeoutMs: 120_000,
        }),
      );
      await ignoreCleanupError(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-delete-openclaw-plugin-exdev",
          env: cleanupEnv,
          timeoutMs: 60_000,
        }),
      );
    });

    await ignoreCleanupError(() =>
      host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 120_000,
      }),
    );
    await ignoreCleanupError(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-delete-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 60_000,
      }),
    );

    const policySourceSnapshot = snapshotPolicySources();
    const pinnedOpenshell = await installAndResolvePinnedOpenShell(host);
    expect(
      hasRequiredOpenshellMessagingFeatures({
        openshellBin: pinnedOpenshell.cli,
        gatewayBin: pinnedOpenshell.gateway,
        sandboxBin: pinnedOpenshell.sandbox,
      }),
      "canonical pinned OpenShell components must pass coherence preflight before delegation",
    ).toBe(true);
    const openshellWrapper = createOpenShellTmpfsWrapper(pinnedOpenshell.cli);
    cleanup.add("remove EXDEV OpenShell PATH wrapper", openshellWrapper.remove);
    expect(
      hasRequiredOpenshellMessagingFeatures({
        openshellBin: openshellWrapper.executable,
        gatewayBin: pinnedOpenshell.gateway,
        sandboxBin: pinnedOpenshell.sandbox,
        allowExternalGatewayBin: true,
        allowExternalSandboxBin: true,
      }),
      "OpenShell wrapper and explicit pinned components must pass onboard coherence preflight",
    ).toBe(true);
    const removeCustomDockerfile = createCustomPluginDockerfile();
    cleanup.add("remove custom weather-plugin Dockerfile", removeCustomDockerfile);

    const sandboxEnv = withOpenShellWrapperEnv(
      liveEnv({
        COMPATIBLE_API_KEY: "nemoclaw-exdev-dummy-key",
        NEMOCLAW_ENDPOINT_URL: "http://host.openshell.internal:65535/v1",
        NEMOCLAW_MODEL: "nemoclaw-exdev-probe",
        NEMOCLAW_PROVIDER_KEY: "nemoclaw-exdev-dummy-key",
        NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        NEMOCLAW_SANDBOX_BASE_IMAGE_REF: SANDBOX_BASE_IMAGE_REF,
        NEMOCLAW_POLICY_MODE: "skip",
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
      }),
      openshellWrapper,
      pinnedOpenshell,
    );

    const onboard = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
        "--agent",
        "openclaw",
        "--from",
        CUSTOM_DOCKERFILE,
      ],
      {
        artifactName: "openclaw-plugin-exdev-onboard",
        env: sandboxEnv,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const onboardText = resultText(onboard);
    expect(onboard.exitCode, onboardText).toBe(0);
    expect(onboardText).toMatch(/Creating sandbox|Sandbox '.+' created/);
    expect(onboardText).toContain("Deployment verified");
    const tmpfsMountedAfterOnboard = await assertExdevTmpfsMounted(sandbox, "after-onboard");
    assertPolicySourcesUnchanged(policySourceSnapshot, "onboard");

    const weatherAfterOnboard = await assertWeatherPluginRuntime(sandbox, "after-onboard", "v1");

    const restart = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "gateway", "restart"],
      {
        artifactName: "openclaw-weather-plugin-gateway-restart",
        env: sandboxEnv,
        timeoutMs: 180_000,
      },
    );
    expect(restart.exitCode, resultText(restart)).toBe(0);
    const weatherAfterRestart = await assertWeatherPluginRuntime(sandbox, "after-restart", "v1");
    expect(weatherAfterRestart.imageMarker).toBe(weatherAfterOnboard.imageMarker);

    // Change an actual build-context input so rebuild must produce a distinct
    // plugin artifact. Restore must preserve that fresh image-managed v2
    // extension instead of replacing it with the backed-up v1 directory.
    writeCustomPluginVersion("v2");
    const rebuild = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "rebuild", "--yes"], {
      artifactName: "openclaw-weather-plugin-rebuild",
      env: sandboxEnv,
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    expect(rebuild.exitCode, resultText(rebuild)).toBe(0);
    const tmpfsMountedAfterRebuild = await assertExdevTmpfsMounted(sandbox, "after-rebuild");
    assertPolicySourcesUnchanged(policySourceSnapshot, "rebuild");
    const weatherAfterRebuild = await assertWeatherPluginRuntime(sandbox, "after-rebuild", "v2");
    expect(weatherAfterRebuild.imageMarker).not.toBe(weatherAfterOnboard.imageMarker);

    const df = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `mkdir -p ${EXDEV_TMPFS_SOURCE} /sandbox/.openclaw/plugin-runtime-deps && df -PT / /tmp ${EXDEV_TMPFS_MOUNT} ${EXDEV_TMPFS_SOURCE} /sandbox /sandbox/.openclaw/plugin-runtime-deps`,
      ),
      {
        artifactName: "openclaw-plugin-exdev-filesystem-layout",
        env: liveEnv(),
        timeoutMs: 30_000,
      },
    );
    await artifacts.writeText("filesystem-layout.txt", resultText(df));
    expect(df.exitCode, resultText(df)).toBe(0);
    expect(resultText(df)).toContain(EXDEV_TMPFS_MOUNT);

    const probe = await sandbox.execShell(SANDBOX_NAME, runtimeDepsReplacementProbe, {
      artifactName: "openclaw-plugin-exdev-runtime-deps-replacement",
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const probeText = resultText(probe);
    expect(
      EXDEV_PATTERNS.some((pattern) => pattern.test(probeText)),
      probeText,
    ).toBe(false);
    expect(probe.exitCode, probeText).toBe(0);
    expect(probeText).toMatch(/source_device=\d+ target_device=\d+/);
    expect(probeText).toContain("source-side staging failure self-check completed");
    expect(probeText).toContain("runtime deps replacement completed");

    await artifacts.writeJson("target-result.json", {
      id: "openclaw-plugin-runtime-exdev",
      onboardExitCode: onboard.exitCode,
      restartExitCode: restart.exitCode,
      rebuildExitCode: rebuild.exitCode,
      filesystemProbeExitCode: df.exitCode,
      runtimeDepsProbeExitCode: probe.exitCode,
      testOnlyTmpfsSource: EXDEV_TMPFS_SOURCE,
      assertions: {
        weatherAfterOnboard:
          weatherAfterOnboard.inspectLoaded &&
          weatherAfterOnboard.catalogToolIds.includes("get_weather") &&
          weatherAfterOnboard.toolInvoked,
        weatherAfterRestart:
          weatherAfterRestart.inspectLoaded &&
          weatherAfterRestart.catalogToolIds.includes("get_weather") &&
          weatherAfterRestart.toolInvoked,
        weatherAfterRebuild:
          weatherAfterRebuild.inspectLoaded &&
          weatherAfterRebuild.catalogToolIds.includes("get_weather") &&
          weatherAfterRebuild.toolInvoked,
        v1MarkerStableThroughRestart:
          weatherAfterOnboard.imageMarker === weatherAfterRestart.imageMarker &&
          weatherAfterOnboard.fixtureVersion === "v1" &&
          weatherAfterRestart.fixtureVersion === "v1",
        rebuiltV2ReplacedV1:
          weatherAfterRebuild.imageMarker !== weatherAfterOnboard.imageMarker &&
          weatherAfterRebuild.fixtureVersion === "v2",
        distinctDevices: /source_device=\d+ target_device=\d+/.test(probeText),
        sourceSideExdevSelfCheck: probeText.includes(
          "source-side staging failure self-check completed",
        ),
        noExdevSignature: !EXDEV_PATTERNS.some((pattern) => pattern.test(probeText)),
        successMarker: probeText.includes("runtime deps replacement completed"),
        testOnlyTmpfsMounted: tmpfsMountedAfterOnboard && tmpfsMountedAfterRebuild,
        stockPolicySourcesUnchanged: true,
      },
    });
  },
);
