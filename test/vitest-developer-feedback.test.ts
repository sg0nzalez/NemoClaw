// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect } from "vitest";

import rootVitestConfig from "../vitest.config";
import { test as it, type OwnedTestResources } from "./helpers/owned-test-resources";
import { resolveVitestFeedback } from "./helpers/vitest-feedback";

type RootTestOptions = {
  reporters?: unknown;
  silent?: boolean | "passed-only";
};

const focusedProjects = "--project cli --project plugin --project e2e-support";

function runNpmScript(
  resources: OwnedTestResources,
  script: string,
  extraArguments: string[] = [],
): string {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required to exercise npm script dispatch");
  const fixtureRoot = resources.temporaryDirectory("nemoclaw-vitest-feedback-");
  const fakeBin = path.join(fixtureRoot, "bin");
  const commandLog = path.join(fixtureRoot, "commands.log");
  const scriptShell = path.join(fixtureRoot, "script-shell");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "vitest"),
    '#!/bin/sh\nprintf \'vitest %s\\n\' "$*" > "$COMMAND_LOG"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    scriptShell,
    `#!/bin/sh\nPATH="$FAKE_BIN:${path.dirname(process.execPath)}:/usr/bin:/bin"\nexport PATH\nexec /bin/sh "$@"\n`,
    { mode: 0o755 },
  );

  const result = spawnSync(process.execPath, [npmCli, "run", script, ...extraArguments], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      COMMAND_LOG: commandLog,
      FAKE_BIN: fakeBin,
      npm_config_script_shell: scriptShell,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${script} exited ${result.status}`);
  }
  return fs.readFileSync(commandLog, "utf8").trim();
}

describe("Vitest developer feedback", () => {
  it("lets Vitest select reporters and preserves failed-test logs in CI (#6692)", () => {
    const testOptions = rootVitestConfig.test as RootTestOptions;

    expect(testOptions).not.toHaveProperty("reporters");
    expect(resolveVitestFeedback({})).toEqual({ isCi: false, silent: false });
    expect(resolveVitestFeedback({ CI: "0" })).toEqual({ isCi: false, silent: false });
    expect(resolveVitestFeedback({ CI: "1" })).toEqual({
      isCi: true,
      silent: "passed-only",
    });
    expect(resolveVitestFeedback({ CI: "true" })).toEqual({
      isCi: true,
      silent: "passed-only",
    });
    expect(resolveVitestFeedback({ GITHUB_ACTIONS: "true" })).toEqual({
      isCi: true,
      silent: "passed-only",
    });
    expect(testOptions.silent).toBe(resolveVitestFeedback().silent);
  });

  it("runs changed and watch feedback on the focused source projects (#6692)", ({ resources }) => {
    expect(runNpmScript(resources, "test:changed")).toBe(`vitest run --changed ${focusedProjects}`);
    expect(runNpmScript(resources, "test:watch")).toBe(`vitest watch ${focusedProjects}`);
  });

  it("passes a reproducible seed to test-only shuffle diagnostics outside coverage (#6692)", ({
    resources,
  }) => {
    expect(runNpmScript(resources, "test:shuffle", ["--", "--sequence.seed=6692"])).toBe(
      `vitest run ${focusedProjects} --sequence.shuffle.tests --coverage=false --sequence.seed=6692`,
    );
  });

  it("runs opt-in async-leak diagnostics outside coverage (#6692)", ({ resources }) => {
    expect(runNpmScript(resources, "test:diagnose:leaks")).toBe(
      `vitest run ${focusedProjects} --detectAsyncLeaks --coverage=false --reporter=default --reporter=hanging-process`,
    );
  });
});
