// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const execSandboxMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/lib/actions/sandbox/exec", () => ({
  execSandbox: execSandboxMock,
}));

import SandboxExecCommand from "../../../src/commands/sandbox/exec.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS,
  DEEPAGENTS_FRESH_REONBOARD_CHECK,
} from "../live/cloud-experimental-check-list.ts";
import {
  assertRequiredCloudExperimentalResult,
  buildCloudExperimentalChecksEvidence,
  buildCloudExperimentalCommandEnv,
  cloudExperimentalApiKeyForCheck,
  cloudExperimentalCheckTimeoutMs,
} from "../live/cloud-experimental-checks.ts";

const dcodeTavilyCheck = path.join(
  process.cwd(),
  "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
);
const dcodeFreshReonboardCheck = path.join(process.cwd(), DEEPAGENTS_FRESH_REONBOARD_CHECK);
const freshReonboardTimeoutMs = 30_000;

function writeExecutable(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o755 });
}

function shellResult(exitCode: number, stdout: string, stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: {
      stdout: "stdout.txt",
      stderr: "stderr.txt",
      result: "result.json",
    },
  };
}

describe("P0-E cloud-experimental parity guardrails", () => {
  it("skips the destructive fresh re-onboard check outside a Deep Agents sandbox", () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openshell-"));
    try {
      fs.writeFileSync(path.join(binDir, "openshell"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const result = spawnSync("bash", [dcodeFreshReonboardCheck], {
        encoding: "utf8",
        env: {
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          SANDBOX_NAME: "openclaw-sandbox",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "04-deepagents-code-fresh-reonboard: SKIP: sandbox openclaw-sandbox is not a Deep Agents Code sandbox",
      );
    } finally {
      fs.rmSync(binDir, { force: true, recursive: true });
    }
  });

  it("keeps live DCode config inspection and mutation-boundary coverage in the fresh re-onboard check", () => {
    const script = fs.readFileSync(dcodeFreshReonboardCheck, "utf8");

    expect(script).toContain('"$CLI" "$SANDBOX_NAME" config get');
    expect(script).toContain("config get --key models.default");
    expect(script).toContain("config get --format yaml");
    expect(script).toContain("config set --key models.default");
    expect(script).toContain("sha256sum /sandbox/.deepagents/config.toml");
    expect(script).toContain("config is baked into the sandbox image at build time");
    expect(script).toContain("re-onboard with the new selection");
  });

  it(
    "runs fresh re-onboard against a fake endpoint without hosted inference secrets (#5747)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fresh-reonboard-"));
      try {
        const binDir = path.join(tmp, "bin");
        const homeDir = path.join(tmp, "home");
        fs.mkdirSync(binDir);
        fs.mkdirSync(homeDir);
        const marker = path.join(tmp, "reonboard-done");
        const openshell = path.join(binDir, "openshell");
        const cli = path.join(binDir, "nemoclaw");

        writeExecutable(openshell, [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
          "  shift 2",
          '  [ "$1" = "--name" ] || { echo "missing --name" >&2; exit 2; }',
          "  shift 2",
          '  [ "$1" = "--" ] || { echo "missing command boundary" >&2; exit 2; }',
          "  shift",
          '  if [ "$1" = "bash" ] && [ "$2" = "-c" ]; then',
          '    case "$3" in',
          '      *"test -d /sandbox/.deepagents"*) exit 0 ;;',
          '      *"sha256sum /sandbox/.deepagents/config.toml"*)',
          "        printf '%s\\n' 0000000000000000000000000000000000000000000000000000000000000000",
          "        exit 0",
          "        ;;",
          "      *)",
          '        if [ -f "$FAKE_REONBOARD_DONE" ]; then',
          '          printf "%s\\n" "NEMOCLAW_DCODE_FRESH_CONFIG_VERIFIED"',
          "        else",
          '          printf "%s\\n" "NEMOCLAW_DCODE_STALE_CONFIG_SEEDED"',
          "        fi",
          "        exit 0",
          "        ;;",
          "    esac",
          "  fi",
          '  if [ "$1" = "/usr/local/bin/dcode" ] && [ "$2" = "identity" ]; then',
          '    if [ -f "$FAKE_REONBOARD_DONE" ]; then',
          '      model="openai/openai/gpt-5.5"',
          "    else",
          '      model="nvidia/nvidia/nemotron-3-ultra"',
          "    fi",
          '    printf "Route: inference\\nProvider: compatible-endpoint\\nModel: openai:%s\\nEndpoint: https://inference.local/v1\\n" "$model"',
          "    exit 0",
          "  fi",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "%s\\n" "deepagents-sandbox Ready"',
          "  exit 0",
          "fi",
          'printf "unexpected openshell args: %s\\n" "$*" >&2',
          "exit 2",
        ]);

        writeExecutable(cli, [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "fail() { printf 'fake nemoclaw: %s\\n' \"$1\" >&2; exit 2; }",
          'if [ "$1" = "onboard" ]; then',
          '  if printenv NVIDIA_INFERENCE_API_KEY >/dev/null; then fail "NVIDIA_INFERENCE_API_KEY leaked"; fi',
          '  if [ "$(printenv NEMOCLAW_E2E_USE_HOSTED_INFERENCE 2>/dev/null || true)" = "1" ]; then fail "hosted inference flag leaked"; fi',
          '  [ "$(printenv COMPATIBLE_API_KEY)" = "e2e-compatible-key" ] || fail "missing fake compatible key"',
          '  [ "$(printenv NEMOCLAW_PROVIDER)" = "custom" ] || fail "missing custom provider"',
          '  [ "$(printenv NEMOCLAW_MODEL)" = "openai/openai/gpt-5.5" ] || fail "wrong target model"',
          '  case "$(printenv NEMOCLAW_ENDPOINT_URL)" in',
          "    http://127.0.0.1:*/v1) ;;",
          '    *) fail "unexpected compatible endpoint" ;;',
          "  esac",
          "  node --input-type=module <<'NODE'",
          'const response = await fetch(process.env.NEMOCLAW_ENDPOINT_URL + "/chat/completions", {',
          '  method: "POST",',
          "  headers: {",
          '    "content-type": "application/json",',
          '    authorization: "Bearer " + process.env.COMPATIBLE_API_KEY',
          "  },",
          "  body: JSON.stringify({",
          "    model: process.env.NEMOCLAW_MODEL,",
          '    messages: [{ role: "user", content: "ping" }]',
          "  })",
          "});",
          "if (!response.ok) {",
          "  console.error(await response.text());",
          "  process.exit(1);",
          "}",
          "NODE",
          '  mkdir -p "$HOME/.nemoclaw"',
          '  printf \'%s\\n\' \'{"sandboxes":{"deepagents-sandbox":{"agent":"langchain-deepagents-code","model":"openai/openai/gpt-5.5","provider":"compatible-endpoint","credentialEnv":"COMPATIBLE_API_KEY"}}}\' > "$HOME/.nemoclaw/sandboxes.json"',
          '  touch "$FAKE_REONBOARD_DONE"',
          '  printf "%s\\n" "Backing up workspace state before recreating sandbox..."',
          '  printf "%s\\n" "Restoring workspace state from pre-recreate backup..."',
          "  exit 0",
          "fi",
          'if [ "$1" = "deepagents-sandbox" ] && [ "$2" = "config" ] && [ "$3" = "get" ]; then',
          '  if [ -f "$FAKE_REONBOARD_DONE" ]; then',
          '    model="openai/openai/gpt-5.5"',
          "  else",
          '    model="nvidia/nvidia/nemotron-3-ultra"',
          "  fi",
          '  if [ "$#" -eq 3 ]; then',
          '    MODEL="$model" node -e \'console.log(JSON.stringify({models:{default:"openai:" + process.env.MODEL},headers:{authorization:"[STRIPPED_BY_MIGRATION]"}}))\'',
          '  elif [ "$4" = "--key" ] && [ "$5" = "models.default" ]; then',
          '    printf \'"openai:%s"\\n\' "$model"',
          '  elif [ "$4" = "--format" ] && [ "$5" = "yaml" ]; then',
          '    printf \'models:\\n  default: openai:%s\\nheaders:\\n  authorization: "[STRIPPED_BY_MIGRATION]"\\n\' "$model"',
          "  else",
          '    fail "unexpected config get args"',
          "  fi",
          "  exit 0",
          "fi",
          'if [ "$1" = "deepagents-sandbox" ] && [ "$2" = "config" ] && [ "$3" = "set" ]; then',
          '  printf "%s\\n" "config is baked into the sandbox image at build time" >&2',
          '  printf "%s\\n" "re-onboard with the new selection using --fresh" >&2',
          "  exit 1",
          "fi",
          'if [ "$1" = "deepagents-sandbox" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then',
          '  printf \'%s\\n\' \'{"name":"deepagents-sandbox","model":"openai/openai/gpt-5.5","provider":"compatible-endpoint"}\'',
          "  exit 0",
          "fi",
          'printf "unexpected nemoclaw args: %s\\n" "$*" >&2',
          "exit 2",
        ]);

        const result = spawnSync("bash", [dcodeFreshReonboardCheck], {
          encoding: "utf8",
          timeout: freshReonboardTimeoutMs,
          env: {
            COMPATIBLE_API_KEY: "hosted-compatible-secret-should-not-be-used",
            FAKE_OPENAI_PUBLIC_HOST: "127.0.0.1",
            FAKE_REONBOARD_DONE: marker,
            HOME: homeDir,
            NEMOCLAW_CLI_BIN: cli,
            NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
            NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
            NVIDIA_INFERENCE_API_KEY: "hosted-nvidia-secret-should-not-be-used",
            PATH: binDir + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
            REPO: process.cwd(),
            SANDBOX_NAME: "deepagents-sandbox",
          },
        });

        expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
        expect(result.stdout).toContain(
          "04-deepagents-code-fresh-reonboard: OK (started hermetic compatible inference for re-onboard)",
        );
        expect(result.stdout).toContain("04-deepagents-code-fresh-reonboard: 12 passed, 0 failed");
        expect(result.stdout + result.stderr).not.toContain(
          "hosted-nvidia-secret-should-not-be-used",
        );
        expect(result.stdout + result.stderr).not.toContain(
          "hosted-compatible-secret-should-not-be-used",
        );
      } finally {
        fs.rmSync(tmp, { force: true, recursive: true });
      }
    },
    freshReonboardTimeoutMs,
  );

  it("preserves the repeated env-unset pairs from the failed observability invocation", async () => {
    await SandboxExecCommand.run(
      [
        "deepagents-sandbox",
        "--",
        "env",
        "-u",
        "ALL_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "HTTP_PROXY",
        "-u",
        "all_proxy",
        "-u",
        "https_proxy",
        "-u",
        "http_proxy",
        "/opt/venv/bin/python3",
        "-I",
        "-c",
        "pass",
      ],
      process.cwd(),
    );

    expect(execSandboxMock).toHaveBeenCalledWith(
      "deepagents-sandbox",
      [
        "env",
        "-u",
        "ALL_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "HTTP_PROXY",
        "-u",
        "all_proxy",
        "-u",
        "https_proxy",
        "-u",
        "http_proxy",
        "/opt/venv/bin/python3",
        "-I",
        "-c",
        "pass",
      ],
      { workdir: undefined, tty: null, timeoutSeconds: undefined },
    );
  });

  it("routes the live OTLP probe through managed Python and the OpenShell proxy", () => {
    const script = fs.readFileSync(
      path.join(
        process.cwd(),
        "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      ),
      "utf8",
    );

    expect(script).toMatch(
      /grep -Fq 'CAPTURE_READY:'[\s\S]*COLLECTOR_PORT}\/health[\s\S]*DECOY_PORT}\/health/,
    );
    expect(script).toContain("urllib.request.urlopen(request, timeout=10)");
    expect(script).toContain("except urllib.error.HTTPError as error:");
    expect(script).toContain('body = error.read(512).decode("utf-8", "replace")');
    expect(script).not.toContain("urllib.request.ProxyHandler({})");
    expect(script).not.toContain("os.environ.pop");
    expect(script).toMatch(/\"\$CLI\" \"\$SANDBOX_NAME\" exec -- \\\n\s+\/opt\/venv\/bin\/python3/);
    expect(script).not.toContain("env -u ALL_PROXY");
    expect(script.match(/--noproxy '\*'/g)).toHaveLength(2);
    expect(script).toContain("/usr/bin/curl --fail-with-body -sS");
    expect(script).toMatch(
      /run_deterministic_tool_trace\(\)[\s\S]*"\$CLI" "\$SANDBOX_NAME" exec --[\s\S]*\/opt\/venv\/bin\/python3/,
    );
  });

  it("skips the DCode observability probe before host prerequisites on other agents", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-observability-skip-"));
    try {
      const invocationLog = path.join(tempDir, "openshell-args.txt");
      const openshell = path.join(tempDir, "openshell");
      fs.writeFileSync(
        openshell,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NEMOCLAW_FAKE_OPENSHELL_LOG"\nexit 1\n',
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        [
          path.join(
            process.cwd(),
            "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
          ),
        ],
        {
          encoding: "utf8",
          env: {
            NEMOCLAW_CLI_BIN: path.join(tempDir, "missing-nemoclaw"),
            NEMOCLAW_FAKE_OPENSHELL_LOG: invocationLog,
            PATH: `${tempDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            REPO: path.join(tempDir, "missing-repo"),
            SANDBOX_NAME: "openclaw-sandbox",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "11-deepagents-code-observability: SKIP: sandbox openclaw-sandbox is not a Deep Agents Code sandbox",
      );
      expect(fs.readFileSync(invocationLog, "utf8")).toBe(
        [
          "sandbox",
          "exec",
          "--name",
          "openclaw-sandbox",
          "--",
          "bash",
          "-c",
          "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("fails required Deep Agents cloud-experimental checks when scripts print SKIP", () => {
    expect(() =>
      assertRequiredCloudExperimentalResult(
        "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
        shellResult(0, "05-deepagents-code-landlock-readonly: SKIP: not a Deep Agents sandbox\n"),
      ),
    ).toThrow(/must not skip/);
  });

  it("fails Deep Agents Python egress blocked-host assertions without denial evidence", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST: "blocked-no-marker",
          NEMOCLAW_E2E_PYTHON_PROBE_FIXTURE: "OpenShell runtime error without denial marker",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "self-test Python probe for fixture host lacked denial evidence",
    );
  });

  it("keeps Deep Agents Python egress probe commands single-line for OpenShell exec", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST: "probe-command-shape",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(0);
    const commands = result.stdout.trim().split("\n");
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/^SINGLE_LINE_COMMAND:python3 -c /);
    expect(commands[1]).toMatch(
      /^SINGLE_LINE_COMMAND:\/usr\/local\/lib\/nemoclaw\/dcode-managed-exec \/opt\/venv\/bin\/python3 -c /,
    );
  });

  it("keeps Deep Agents fetch_url probe command single-line for OpenShell exec", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST: "fetch-probe-command-shape",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("NO_NEWLINE_IN_FETCH_COMMAND");
  });

  it.each([
    [
      "accepts an explicit non-empty success response",
      "fetch-success-classification",
      "FETCH_SUCCESS:200:1234",
      0,
      "1 passed",
    ],
    [
      "accepts explicit denial evidence",
      "fetch-blocked-classification",
      "FETCH_BLOCKED:network policy denied",
      0,
      "1 passed",
    ],
    [
      "rejects an unclassified fetch error",
      "fetch-blocked-classification",
      "FETCH_ERROR:opaque 403",
      1,
      "lacked denial evidence",
    ],
  ] as const)("%s from the fetch_url probe", (_label, selfTest, fixture, status, expected) => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST: selfTest,
          NEMOCLAW_E2E_FETCH_URL_PROBE_FIXTURE: fixture,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(status);
    expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
  });

  it("keeps Deep Agents secret-boundary probe command single-line for OpenShell exec", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_SECRET_BOUNDARY_SELF_TEST: "probe-command-shape",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NO_NEWLINE_IN_COMMAND");
  });

  it("keeps Deep Agents Tavily opt-in probe command single-line for OpenShell exec", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_TAVILY_SELF_TEST: "probe-command-shape",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NO_NEWLINE_IN_COMMAND");
  });

  it.each([
    [
      "BLOCKED:policy denied",
      "ok",
      "preserve",
      0,
      /returns to the default Tavily denial/,
      /remains enabled/,
    ],
    [
      "REACHED:403",
      "ok",
      "preserve",
      1,
      /did not restore the default Tavily denial/,
      /remains enabled/,
    ],
    [
      "BLOCKED:policy denied",
      "fail",
      "preserve",
      1,
      /policy-remove tavily failed/,
      /remains enabled/,
    ],
    ["BLOCKED:policy denied", "ok", "lose", 1, /marker was lost/, /restored for ordered cleanup/],
  ])("restores Tavily denial after opt-in (%s/%s/%s)", (fixture, removeFixture, markerFixture, status, expected, markerExpected) => {
    const result = spawnSync("bash", [dcodeTavilyCheck], {
      encoding: "utf8",
      env: {
        NEMOCLAW_E2E_TAVILY_MARKER_FIXTURE: markerFixture,
        NEMOCLAW_E2E_TAVILY_PROBE_FIXTURE: fixture,
        NEMOCLAW_E2E_TAVILY_REMOVE_FIXTURE: removeFixture,
        NEMOCLAW_E2E_TAVILY_SELF_TEST: "restore-denial",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SANDBOX_NAME: "deepagents-sandbox",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(expected);
    expect(result.stdout).toMatch(markerExpected);
  });

  it("keeps the managed DCode thread-auto-approval live check valid Bash (#6478)", () => {
    const scriptPath = path.join(
      process.cwd(),
      "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
    );
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("registers executable Deep Agents cloud-experimental checks in execution order", () => {
    expect(DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS).toEqual([
      "test/e2e/e2e-cloud-experimental/checks/03-deepagents-code-nemotron-ultra-profile.sh",
      "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh",
      "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh",
      "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
      "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
      "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
      "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
    ]);

    for (const scriptPath of DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS) {
      const mode = fs.statSync(path.join(process.cwd(), scriptPath)).mode;
      expect(mode & 0o111, `${scriptPath} must be executable`).not.toBe(0);
    }
  });

  it("gives the destructive fresh re-onboard check its onboarding budget", () => {
    expect(
      cloudExperimentalCheckTimeoutMs(
        "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh",
      ),
    ).toBe(15 * 60_000);
    expect(
      cloudExperimentalCheckTimeoutMs(
        "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      ),
    ).toBe(180_000);
    expect(
      cloudExperimentalCheckTimeoutMs(
        "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      ),
    ).toBe(8 * 60_000);
    expect(
      cloudExperimentalCheckTimeoutMs(
        "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
      ),
    ).toBe(35 * 60_000);
  });

  it("withholds the hosted inference key from the hermetic re-onboard check (#5747)", () => {
    expect(cloudExperimentalApiKeyForCheck(DEEPAGENTS_FRESH_REONBOARD_CHECK, "secret-key")).toBe(
      "",
    );
    expect(
      cloudExperimentalApiKeyForCheck(
        "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh",
        "secret-key",
      ),
    ).toBe("secret-key");
  });

  it("documents Deep Agents check scripts in generated launch/QA evidence", () => {
    const evidence = buildCloudExperimentalChecksEvidence(
      "cloud-langchain-deepagents-code",
      "deepagents-sandbox",
      DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS,
    );

    expect(evidence).toMatchObject({
      targetId: "cloud-langchain-deepagents-code",
      sandboxName: "deepagents-sandbox",
    });
    expect(evidence.checkScripts).toContain(
      "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
    );
    expect(evidence.terminalConnectHint).toEqual({
      agent: "langchain-deepagents-code",
      interactiveCommand: "dcode",
      statusLine: "Interactive: dcode",
      source: "agents/langchain-deepagents-code/manifest.yaml:runtime.interactive_command",
    });
  });

  it("builds a minimal cloud-experimental child environment", () => {
    const env = buildCloudExperimentalCommandEnv("deepagents-sandbox", "secret-key", {
      HOME: "/home/runner",
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "do-not-copy",
      GITHUB_TOKEN: "do-not-copy",
      NEMOCLAW_MODEL: "model-a",
      RANDOM_RUNNER_SECRET: "do-not-copy",
    });

    expect(env).toMatchObject({
      COMPATIBLE_API_KEY: "secret-key",
      CLOUD_EXPERIMENTAL_MODEL: "model-a",
      NEMOCLAW_SANDBOX_NAME: "deepagents-sandbox",
      SANDBOX_NAME: "deepagents-sandbox",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.RANDOM_RUNNER_SECRET).toBeUndefined();
  });
});
