// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_BOOTSTRAP = path.join(REPO_ROOT, "install.sh");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const STATION_DOCS = [
  path.join(REPO_ROOT, "docs", "get-started", "prerequisites.mdx"),
  path.join(REPO_ROOT, "docs", "get-started", "quickstart.mdx"),
];

function runSourced(script: string, body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-host-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$SCRIPT_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        SCRIPT_UNDER_TEST: script,
        ...extraEnv,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { home, result, output: `${result.stdout}${result.stderr}` };
}

describe("DGX Station host preparation", () => {
  it("keeps documented Station pins and Deferred status aligned", () => {
    const helper = fs.readFileSync(STATION_PREPARE, "utf-8");
    const docs = STATION_DOCS.map((doc) => fs.readFileSync(doc, "utf-8"));
    const pinnedValues = ["DRIVER_VERSION", "DOCKER_VERSION", "TOOLKIT_VERSION"].map((name) => {
      const value = helper.match(new RegExp(`readonly ${name}="([^"]+)"`))?.[1];
      expect(value, `${name} must remain declared in the Station helper`).toBeTruthy();
      return value as string;
    });

    for (const doc of docs) {
      for (const version of pinnedValues) expect(doc).toContain(version);
      expect(doc).toMatch(/(?:DGX )?Station(?: remains|'s) Deferred/);
      expect(doc).toMatch(/physical (?:DGX Station )?hardware|physical end-to-end validation/);
    }
  });

  it.each([
    ["", "missing"],
    ["5:29.6.1-1~ubuntu.24.04~noble", "exact"],
    ["5:30.0.0-1~ubuntu.24.04~noble", "mismatch"],
  ])("classifies an installed package version as %s -> %s", (actual, expected) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
installed_version() {
  if [[ "$1" == "docker-ce" ]]; then printf '%s' "$PACKAGE_ACTUAL"; fi
}
package_state 'docker-ce=5:29.6.1-1~ubuntu.24.04~noble'
`,
      { PACKAGE_ACTUAL: actual },
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it("refuses to change an existing mismatched prerequisite", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
installed_version() {
  if [[ "$1" == "docker-ce" ]]; then printf '5:30.0.0-1~ubuntu.24.04~noble'; fi
}
assert_no_package_mismatches
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/docker-ce status=mismatch/);
    expect(output).toMatch(/refusing to upgrade or downgrade them automatically/);
  });

  it("reuses exact packages and proceeds directly to runtime probes", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
common_preflight() { :; }
require_command() { :; }
acquire_sudo() { :; }
all_packages_exact() { return 0; }
install_boot_marker_matches_current_boot() { return 1; }
driver_loaded_exact() { return 0; }
install_packages() { printf 'INSTALL_PACKAGES\n'; }
finish_runtime() { printf 'FINISH_RUNTIME\n'; }
verify_apply_state() { printf 'VERIFY_APPLY_STATE\n'; }
run_apply
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("FINISH_RUNTIME");
    expect(output).toContain("VERIFY_APPLY_STATE");
    expect(output).not.toContain("INSTALL_PACKAGES");
    expect(output).toContain("APPLY_RESULT=COMPLETE");
  });

  it("installs only missing packages and returns the reboot-required contract", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
common_preflight() { :; }
require_command() { :; }
acquire_sudo() { :; }
all_packages_exact() { return 1; }
assert_no_package_mismatches() { printf 'NO_MISMATCHES\n'; }
install_packages() { printf 'INSTALL_PACKAGES\n'; }
ensure_docker_group() { printf 'ENSURE_DOCKER_GROUP\n'; }
write_install_boot_marker() { printf 'WRITE_BOOT_MARKER\n'; }
sudo() { printf 'SUDO %s\n' "$*"; }
run_apply
`,
    );

    expect(result.status, output).toBe(10);
    expect(output).toContain("NO_MISMATCHES");
    expect(output).toContain("INSTALL_PACKAGES");
    expect(output).toContain("ENSURE_DOCKER_GROUP");
    expect(output).toContain("WRITE_BOOT_MARKER");
    expect(output).toContain("APPLY_RESULT=REBOOT_REQUIRED");
  });

  it("does not refresh CDI when the GPU launch probe already passes", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
run_cdi_test_sudo() { printf 'CDI_TEST\n'; return 0; }
refresh_cdi() { printf 'REFRESH_CDI\n'; }
ensure_cdi_runtime
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("cdi_contract=pass_without_configuration_change");
    expect(output).not.toContain("REFRESH_CDI");
  });

  it("refreshes CDI once when the initial GPU launch probe fails", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
calls=0
run_cdi_test_sudo() {
  calls=$((calls + 1))
  printf 'CDI_TEST_%s\n' "$calls"
  [[ "$calls" -gt 1 ]]
}
refresh_cdi() { printf 'REFRESH_CDI\n'; }
ensure_cdi_runtime
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("CDI_TEST_1");
    expect(output).toContain("REFRESH_CDI");
    expect(output).toContain("CDI_TEST_2");
    expect(output).toContain("cdi_contract=pass_after_refresh");
  });

  it("ignores the installer process while still blocking a real vLLM workload", () => {
    const selfOnly = runSourced(
      STATION_PREPARE,
      `
ps() {
  printf '%s %s bash bash /tmp/NemoClaw/scripts/prepare-dgx-station-host.sh --apply\n' "$$" "$PPID"
  printf '%s 1 bash bash /tmp/NemoClaw/scripts/install.sh\n' "$PPID"
}
ss() { :; }
check_no_workloads
`,
    );
    expect(selfOnly.result.status, selfOnly.output).toBe(0);

    const active = runSourced(
      STATION_PREPARE,
      `
ps() { printf '999 1 python python -m vllm serve model\n'; }
ss() { :; }
check_no_workloads
`,
    );
    expect(active.result.status, active.output).not.toBe(0);
    expect(active.output).toMatch(/Agent or inference workload is active/);
  });

  it("uses sudo to inspect containers during apply until Docker group access is active", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
MODE='--apply'
ps() { printf '%s %s bash bash prepare-dgx-station-host.sh --apply\n' "$$" "$PPID"; }
ss() { :; }
docker() { return 1; }
sudo() {
  if [[ "$1" == "-n" ]]; then shift; fi
  [[ "$*" == "docker ps -aq" ]] || return 1
}
systemctl() { return 0; }
check_no_workloads
`,
      { PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("docker_access=sudo_until_group_membership_is_active");
    expect(output).toContain("workloads=none");
  });

  it("fails closed when Docker is installed but its container state cannot be queried", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
MODE='--apply'
ps() { printf '%s %s bash bash prepare-dgx-station-host.sh --apply\n' "$$" "$PPID"; }
ss() { :; }
docker() { return 1; }
sudo() { return 1; }
systemctl() { return 1; }
check_no_workloads
`,
      { PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/container state cannot be verified safely/);
  });

  it("refuses an installed CUDA keyring version that differs from the pin", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
installed_version() { printf '2.0-1'; }
ensure_cuda_keyring "$HOME/cuda-keyring.deb"
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/refusing to upgrade or downgrade it automatically/);
  });

  it("reuses an exact verified CUDA keyring without downloading it again", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
installed_version() { printf '1.1-1'; }
dpkg() { :; }
curl() { printf 'DOWNLOAD\n'; }
sudo() { "$@"; }
verify_key_fingerprint() { printf 'VERIFIED_FINGERPRINT\n'; }
ensure_cuda_keyring "$HOME/cuda-keyring.deb"
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("cuda_keyring=exact version=1.1-1");
    expect(output).toContain("VERIFIED_FINGERPRINT");
    expect(output).not.toContain("DOWNLOAD");
  });

  it("reuses exact repository files and refuses to overwrite mismatched content", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
printf 'validated\n' >"$HOME/source"
cp "$HOME/source" "$HOME/target"
sudo() { "$@"; }
install_exact_file_or_reuse "$HOME/source" "$HOME/target" 0644 test_repository_file
printf 'modified\n' >"$HOME/target"
install_exact_file_or_reuse "$HOME/source" "$HOME/target" 0644 test_repository_file
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/test_repository_file=exact/);
    expect(output).toMatch(/refusing to overwrite/);
  });

  it("requires a new login after adding Docker group membership", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
common_preflight() { :; }
require_command() { :; }
acquire_sudo() { :; }
all_packages_exact() { return 0; }
install_boot_marker_matches_current_boot() { return 1; }
driver_loaded_exact() { return 0; }
finish_runtime() { DOCKER_GROUP_ADDED=1; printf 'FINISH_RUNTIME\n'; }
verify_apply_state() { printf 'VERIFY_APPLY_STATE\n'; }
run_apply
`,
    );

    expect(result.status, output).toBe(10);
    expect(output).toContain("VERIFY_APPLY_STATE");
    expect(output).toContain("APPLY_RESULT=REBOOT_REQUIRED");
    expect(output).toMatch(/new login before onboarding/);
  });

  it("diagnoses packaged CDI refresh failure without writing a manual specification", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
sudo() {
  printf 'SUDO %s\n' "$*"
  [[ "$*" != "systemctl restart nvidia-cdi-refresh.service" ]]
}
refresh_cdi
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("systemctl status nvidia-cdi-refresh.service --no-pager");
    expect(output).toContain("journalctl -u nvidia-cdi-refresh.service --no-pager -n 50");
    expect(output).toMatch(/refusing to create a persistent manual CDI specification/);
    expect(output).not.toContain("cdi generate");
  });

  it("rechecks every workload gate immediately before Docker runtime mutation", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
run_gpus_test_sudo() { return 1; }
sudo() {
  [[ "$*" == "docker ps -aq" ]] && return 0
  [[ "$*" == "test -e /etc/docker/daemon.json" ]] && return 1
  printf 'SUDO %s\n' "$*"
}
check_no_workloads() { printf 'RECHECK_ALL_WORKLOADS\n'; return 1; }
configure_docker_runtime_if_needed
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("RECHECK_ALL_WORKLOADS");
    expect(output).not.toContain("nvidia-ctk runtime configure");
    expect(output).not.toContain("systemctl restart docker.service");
  });

  it("accepts a successful packaged CDI refresh", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
sudo() { printf 'SUDO %s\n' "$*"; }
nvidia-ctk() {
  [[ "$*" == "cdi list" ]] && printf 'nvidia.com/gpu=all\n'
}
refresh_cdi
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("systemctl restart nvidia-cdi-refresh.service");
    expect(output).toContain("cdi=nvidia.com/gpu=all");
    expect(output).not.toContain("systemctl status");
  });

  it.each(["--check", "--verify"])("keeps %s read-only under HOME", (mode) => {
    const { home, result, output } = runSourced(
      STATION_PREPARE,
      `
run_check() { :; }
run_verify() { :; }
main "$READ_MODE"
`,
      { READ_MODE: mode },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("log=disabled_read_only");
    expect(fs.existsSync(path.join(home, "station-bootstrap-logs"))).toBe(false);
  });

  it("fails verification when exact packages are present but the driver is not loaded", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
common_preflight() { :; }
require_command() { :; }
all_packages_exact() { return 0; }
driver_loaded_exact() { return 1; }
run_verify
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Pinned driver is not loaded/);
  });

  it("rejects a symlinked Station bootstrap state directory", () => {
    const { home, result, output } = runSourced(
      STATION_PREPARE,
      `
mkdir -p "$HOME/.local/state" "$HOME/redirect-target"
ln -s "$HOME/redirect-target" "$HOME/.local/state/station-bootstrap"
write_install_boot_marker
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Refusing symbolic link in Station bootstrap state path/);
    expect(fs.existsSync(path.join(home, "redirect-target", "install-boot-id"))).toBe(false);
  });
});

describe("DGX Station express host integration", () => {
  it("ships and invokes Station preparation through the public curl bootstrap", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-public-bootstrap-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "init" ]; then
  target="\${@: -1}"
  mkdir -p "$target/scripts"
  cat > "$target/scripts/install.sh" <<'PAYLOAD'
#!/usr/bin/env bash
# NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
set -euo pipefail
source "\${INSTALLER_UNDER_TEST:?}" >/dev/null
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
maybe_offer_express_install() { _SELECTED_EXPRESS_PLATFORM='DGX Station'; }
ensure_docker() { printf 'ENSURE_DOCKER\\n'; }
ensure_openshell_build_deps() { printf 'ENSURE_BUILD_DEPS\\n'; }
prepare_installer_host
PAYLOAD
  cat > "$target/scripts/prepare-dgx-station-host.sh" <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "--apply" ]
printf 'PREPARE_STATION\\n'
HELPER
  chmod +x "$target/scripts/install.sh" "$target/scripts/prepare-dgx-station-host.sh"
  exit 0
fi
if [ "\${1:-}" = "-C" ]; then shift 2; fi
case "\${1:-}" in
  remote|fetch|checkout) exit 0 ;;
esac
exit 0
`,
      { mode: 0o755 },
    );

    const result = spawnSync("bash", [], {
      cwd: tmp,
      input: fs.readFileSync(PUBLIC_BOOTSTRAP, "utf-8"),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        NEMOCLAW_INSTALL_REF: "refs/tags/station-fixture",
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("DGX Station host prerequisites are ready");
    expect(output.indexOf("PREPARE_STATION")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("PREPARE_STATION")).toBeLessThan(output.indexOf("ENSURE_DOCKER"));
    expect(output.indexOf("ENSURE_DOCKER")).toBeLessThan(output.indexOf("ENSURE_BUILD_DEPS"));
  });

  it("runs Station preparation before the generic Docker bootstrap", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
maybe_offer_express_install() { printf 'SELECT_EXPRESS\n'; _SELECTED_EXPRESS_PLATFORM='DGX Station'; }
ensure_station_express_host() { printf 'PREPARE_STATION\n'; }
ensure_docker() { printf 'ENSURE_DOCKER\n'; }
ensure_openshell_build_deps() { printf 'ENSURE_BUILD_DEPS\n'; }
prepare_installer_host
`,
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "SELECT_EXPRESS",
      "PREPARE_STATION",
      "ENSURE_DOCKER",
      "ENSURE_BUILD_DEPS",
    ]);
  });

  it("skips Station preparation before Docker bootstrap on non-Station platforms", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
maybe_offer_express_install() { _SELECTED_EXPRESS_PLATFORM='DGX Spark'; }
ensure_station_express_host() {
  [[ "$_SELECTED_EXPRESS_PLATFORM" == 'DGX Station' ]] && printf 'PREPARE_STATION\n'
  return 0
}
ensure_docker() { printf 'ENSURE_DOCKER\n'; }
ensure_openshell_build_deps() { printf 'ENSURE_BUILD_DEPS\n'; }
prepare_installer_host
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).not.toContain("PREPARE_STATION");
    expect(result.stdout.trim().split("\n")).toEqual(["ENSURE_DOCKER", "ENSURE_BUILD_DEPS"]);
  });

  it("persists the selected model when host preparation requires a reboot", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
run_station_host_preparation() { return 10; }
ensure_station_express_host
`,
    );
    const stateFile = path.join(home, ".nemoclaw", "station-express-resume");

    expect(result.status, output).toBe(10);
    expect(fs.readFileSync(stateFile, "utf-8")).toBe("nemotron-3-ultra-550b-a55b\n");
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(output).toMatch(/rerun the same NemoClaw installer command/);
  });

  it("rejects a resume-state symlink without loading its target", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'deepseek-v4-flash\n' >"$HOME/resume-target"
ln -s "$HOME/resume-target" "$HOME/.nemoclaw/station-express-resume"
load_station_express_resume
`,
    );
    const target = path.join(home, "resume-target");
    const stateFile = path.join(home, ".nemoclaw", "station-express-resume");

    expect(result.status, output).toBe(1);
    expect(output).toMatch(/Refusing symbolic link in NemoClaw state path/);
    expect(fs.readFileSync(target, "utf-8")).toBe("deepseek-v4-flash\n");
    expect(fs.lstatSync(stateFile).isSymbolicLink()).toBe(true);
  });

  it("rejects a resume-state symlink without modifying its target", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'preserve-this-target\n' >"$HOME/resume-target"
ln -s "$HOME/resume-target" "$HOME/.nemoclaw/station-express-resume"
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
run_station_host_preparation() { return 10; }
ensure_station_express_host
`,
    );
    const target = path.join(home, "resume-target");
    const stateFile = path.join(home, ".nemoclaw", "station-express-resume");

    expect(result.status, output).toBe(1);
    expect(output).toMatch(/Refusing symbolic link in NemoClaw state path/);
    expect(fs.readFileSync(target, "utf-8")).toBe("preserve-this-target\n");
    expect(fs.lstatSync(stateFile).isSymbolicLink()).toBe(true);
  });

  it("resumes the accepted Station recipe without another prompt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-resume-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, "station-express-resume"),
      "nemotron-3-ultra-550b-a55b\n",
      { mode: 0o600 },
    );
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf 'DGX Station'; }
NON_INTERACTIVE=''
NEMOCLAW_PROVIDER=''
NEMOCLAW_NO_EXPRESS=''
maybe_offer_express_install
printf 'RESULT PLATFORM=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s\n' \
  "$_SELECTED_EXPRESS_PLATFORM" "$NEMOCLAW_PROVIDER" "\${NEMOCLAW_MODEL:-}" "$NEMOCLAW_VLLM_MODEL"
`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Resuming the accepted express install/);
    expect(output).not.toMatch(/Run express install with these settings/);
    expect(output).toMatch(
      /RESULT PLATFORM=DGX Station PROVIDER=install-vllm MODEL=nvidia\/nemotron-3-ultra-550b-a55b VLLM_MODEL=nemotron-3-ultra-550b-a55b/,
    );
  });

  it("preserves an explicit provider even when Station resume state exists", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'nemotron-3-ultra-550b-a55b\n' >"$HOME/.nemoclaw/station-express-resume"
chmod 0600 "$HOME/.nemoclaw/station-express-resume"
detect_express_platform() { printf 'DGX Station'; }
NON_INTERACTIVE=''
NEMOCLAW_PROVIDER='openai'
NEMOCLAW_NO_EXPRESS=''
maybe_offer_express_install
printf 'RESULT PROVIDER=%s\n' "$NEMOCLAW_PROVIDER"
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("NEMOCLAW_PROVIDER=openai already set");
    expect(output).toContain("RESULT PROVIDER=openai");
    expect(output).not.toContain("Resuming the accepted express install");
  });

  it("does not load Station resume state on DGX Spark", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'nemotron-3-ultra-550b-a55b\n' >"$HOME/.nemoclaw/station-express-resume"
chmod 0600 "$HOME/.nemoclaw/station-express-resume"
detect_express_platform() { printf 'DGX Spark'; }
NON_INTERACTIVE='1'
NEMOCLAW_PROVIDER=''
NEMOCLAW_NO_EXPRESS=''
NEMOCLAW_VLLM_MODEL=''
maybe_offer_express_install
printf 'RESULT MODEL=%s\n' "$NEMOCLAW_VLLM_MODEL"
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("Detected DGX Spark. Skipping express prompt (--non-interactive set)");
    expect(output).toContain("RESULT MODEL=");
    expect(output).not.toContain("Resuming the accepted express install");
    expect(output).not.toContain("nemotron-3-ultra-550b-a55b");
  });

  it("rejects a multi-line Station resume state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-resume-invalid-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, "station-express-resume"),
      "nemotron-3-ultra-550b-a55b\nunexpected\n",
      { mode: 0o600 },
    );
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source "$INSTALLER_UNDER_TEST" >/dev/null; load_station_express_resume`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/resume state is invalid/);
  });
});
