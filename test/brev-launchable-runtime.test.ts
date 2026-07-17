// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-runtime.sh");
const roots: string[] = [];
const candidateSha = "a".repeat(40);

type FixtureOptions = {
  lsMode?: "ok" | "fail" | "malformed";
  provisionSha?: string;
  repoSha?: string;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function fixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-runtime-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const workDir = path.join(root, "evidence");
  const home = path.join(root, "home");
  const state = path.join(root, "state.json");
  const log = path.join(root, "brev.log");
  const manifest = path.join(workDir, "validated-manifest.v1.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(workDir);
  fs.mkdirSync(path.join(home, "NemoClaw", ".git"), { recursive: true });
  writeExecutable(path.join(bin, "timeout"), '#!/usr/bin/env bash\nshift\nexec "$@"\n');
  writeExecutable(
    path.join(bin, "brev"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_BREV_LOG"
case "$1" in
  ls)
    [ "$FAKE_BREV_LS_MODE" != fail ] || exit 9
    if [ "$FAKE_BREV_LS_MODE" = malformed ]; then printf '{}\\n'; exit 0; fi
    if [ -f "$FAKE_BREV_STATE" ]; then cat "$FAKE_BREV_STATE"; else printf '{"workspaces":[]}\\n'; fi
    ;;
  create)
    printf '{"workspaces":[{"id":"ws-1","name":"%s","status":"RUNNING","shell_status":"READY","health_status":"HEALTHY","build_status":"COMPLETED"}]}\\n' "$INSTANCE_NAME" > "$FAKE_BREV_STATE"
    ;;
  exec)
    shift 3
    bash -c "$*"
    ;;
  delete) rm -f "$FAKE_BREV_STATE" ;;
  refresh) ;;
  *) exit 2 ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "sudo"),
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" != -n ] || shift
if [ "\${1:-}" = cat ] && [ "\${2:-}" = /etc/nemoclaw/provision.json ]; then
  jq -cn --arg sha "$FAKE_PROVISION_SHA" '{gitSha:$sha,version:"0.0.0"}'
  exit 0
fi
exec "$@"
`,
  );
  writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'rev-parse HEAD'* ]]; then printf '%s\\n' "$FAKE_REPO_SHA"; exit 0; fi
exit 2
`,
  );
  writeExecutable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
for value in "$@"; do
  case "$value" in
    */project/project-id) printf 'brevdevprod\\n'; exit 0 ;;
    */instance/zone) printf 'projects/1/zones/us-central1-a\\n'; exit 0 ;;
    */instance/disks/0/device-name) printf 'disk-1\\n'; exit 0 ;;
    */instance/service-accounts/default/token) printf '{"access_token":"token"}\\n'; exit 0 ;;
    https://compute.googleapis.com/*) printf '{"sourceImage":"https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/image-a","sourceImageId":"123456789"}\\n'; exit 0 ;;
    https://inference.local/*) printf '{"choices":[{"message":{"content":"PONG"}}]}\\n'; exit 0 ;;
  esac
done
exit 2
`,
  );
  writeExecutable(
    path.join(bin, "openshell"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --version ]; then printf 'openshell 1.0\\n'; exit 0; fi
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
[ "\${1:-}" = -- ] && shift
exec "$@"
`,
  );
  for (const [name, body] of [
    ["brev-quickstart", "printf 'Ready!\\n'"],
    ["docker", "exit 0"],
    ["nemoclaw", "exit 0"],
    ["node", "printf 'nvidia/test-model\\n'"],
    ["openclaw", 'printf \'{"payloads":[{"text":"42"}]}\\n\''],
  ] as const) {
    writeExecutable(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  }
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({
      imageName: "image-a",
      imageId: "123456789",
      imageSelfLink:
        "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/image-a",
    })}\n`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BREV_LAUNCHABLE_ID: "env-staging123",
    CANDIDATE_SHA: candidateSha,
    FAKE_BREV_LS_MODE: options.lsMode ?? "ok",
    FAKE_BREV_LOG: log,
    FAKE_BREV_STATE: state,
    FAKE_PROVISION_SHA: options.provisionSha ?? candidateSha.slice(0, 7),
    FAKE_REPO_SHA: options.repoSha ?? candidateSha,
    HOME: home,
    INSTANCE_NAME: "nclaw-e2e-test-1",
    NVIDIA_INFERENCE_API_KEY: "nvapi-test-value",
    VALIDATED_MANIFEST: manifest,
    WORK_DIR: workDir,
    BREV_POLL_SECONDS: "0",
  };
  return { env, log, workDir };
}

function run(mode: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [SCRIPT, mode], { cwd: REPO_ROOT, encoding: "utf8", env });
}

describe("exact staging Brev Launchable runtime", () => {
  it("deploys only the configured Launchable, proves identity, smokes the baked install, and deletes", () => {
    const { env, log, workDir } = fixture();
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(
      qualification.status,
      [qualification.stderr, qualification.stdout, fs.readFileSync(log, "utf8")].join("\n"),
    ).toBe(0);
    expect(run("cleanup", env).status).toBe(0);

    const commands = fs.readFileSync(log, "utf8");
    expect(commands).toContain(
      "create nclaw-e2e-test-1 --launchable env-staging123 --detached --timeout 900",
    );
    expect(commands).not.toMatch(/rsync|install\.sh|npm (?:ci|install)|git clone/u);
    expect(commands.indexOf("rev-parse HEAD")).toBeLessThan(commands.indexOf("brev-quickstart"));
    expect(fs.existsSync(path.join(workDir, "brev-identity-evidence.json"))).toBe(true);
    expect(fs.existsSync(path.join(workDir, "brev-smoke-evidence.json"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "brev-cleanup-evidence.json"), "utf8")),
    ).toMatchObject({ terminalState: "ABSENT", workspaceName: "nclaw-e2e-test-1" });
  });

  it("fails closed on a baked SHA mismatch before onboarding", () => {
    const { env, log } = fixture({ repoSha: "b".repeat(40) });
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(qualification.status).not.toBe(0);
    expect(
      [qualification.stderr, qualification.stdout, fs.readFileSync(log, "utf8")].join("\n"),
    ).toContain("does not match candidate");
    expect(fs.readFileSync(log, "utf8")).not.toContain("brev-quickstart");
    expect(run("cleanup", env).status).toBe(0);
  });

  it.each(["fail", "malformed"] as const)("fails closed when Brev inventory is %s", (lsMode) => {
    const { env, log } = fixture({ lsMode });
    const deploy = run("deploy", env);
    expect(deploy.status).not.toBe(0);
    expect(deploy.stderr).toContain("unable to inventory Brev workspaces before deploy");
    expect(fs.readFileSync(log, "utf8")).not.toContain("create ");
  });

  it("rejects an empty provision SHA before onboarding", () => {
    const { env, log } = fixture({ provisionSha: "" });
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(qualification.status).not.toBe(0);
    expect(qualification.stderr).toContain("provision metadata SHA must be a lowercase Git SHA");
    expect(fs.readFileSync(log, "utf8")).not.toContain("brev-quickstart");
    expect(run("cleanup", env).status).toBe(0);
  });
});
