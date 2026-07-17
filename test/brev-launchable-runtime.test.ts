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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(repoSha = candidateSha) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-runtime-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const workDir = path.join(root, "evidence");
  const state = path.join(root, "state.json");
  const log = path.join(root, "brev.log");
  const manifest = path.join(workDir, "validated-manifest.v1.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(bin, "timeout"), '#!/usr/bin/env bash\nshift\nexec "$@"\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(bin, "brev"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_BREV_LOG"
case "$1" in
  ls)
    if [ -f "$FAKE_BREV_STATE" ]; then cat "$FAKE_BREV_STATE"; else printf '{"workspaces":[]}\\n'; fi
    ;;
  create)
    printf '{"workspaces":[{"id":"ws-1","name":"%s","status":"RUNNING","shell_status":"READY","health_status":"HEALTHY","build_status":"COMPLETED"}]}\\n' "$INSTANCE_NAME" > "$FAKE_BREV_STATE"
    ;;
  exec)
    shift 3
    command="$*"
    case "$command" in
      *'/etc/nemoclaw/provision.json'*) printf '{"gitSha":"aaaaaaa","version":"0.0.0"}\\n' ;;
      *'git -C'*'rev-parse HEAD'*) printf '%s\\n' "$FAKE_REPO_SHA" ;;
      *'metadata.google.internal'*) printf '{"sourceImage":"https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/image-a","sourceImageId":"123456789"}\\n' ;;
      *'brev-quickstart'*) printf 'Ready!\\n' ;;
      *'inference.local'*) printf '{"choices":[{"message":{"content":"PONG"}}]}\\n' ;;
      *'openclaw agent'*) printf '{"payloads":[{"text":"42"}]}\\n' ;;
      *) printf 'ok\\n' ;;
    esac
    ;;
  delete) rm -f "$FAKE_BREV_STATE" ;;
  refresh) ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
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
    FAKE_BREV_LOG: log,
    FAKE_BREV_STATE: state,
    FAKE_REPO_SHA: repoSha,
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
    expect(run("qualify", env).status).toBe(0);
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
    const { env, log } = fixture("b".repeat(40));
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(qualification.status).not.toBe(0);
    expect(qualification.stderr).toContain("does not match candidate");
    expect(fs.readFileSync(log, "utf8")).not.toContain("brev-quickstart");
    expect(run("cleanup", env).status).toBe(0);
  });
});
