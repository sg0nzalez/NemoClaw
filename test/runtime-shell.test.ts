// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const RUNTIME_SH = path.join(import.meta.dirname, "..", "scripts", "lib", "runtime.sh");

function runShell(
  script: string,
  env: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const providedEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const cleanEnv: Record<string, string> = {
    HOME: process.env.HOME ?? os.tmpdir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: os.tmpdir(),
    ...providedEnv,
  };

  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: path.join(import.meta.dirname, ".."),
    encoding: "utf-8",
    env: cleanEnv,
  });
}

describe("shell runtime helpers", () => {
  it("respects an existing DOCKER_HOST", () => {
    const result = runShell(`source "${RUNTIME_SH}"; detect_docker_host`, {
      DOCKER_HOST: "unix:///custom/docker.sock",
      HOME: "/tmp/unused-home",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("unix:///custom/docker.sock");
  });

  it("prefers Colima over Docker Desktop", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const colimaSocket = path.join(home, ".colima/default/docker.sock");
    const dockerDesktopSocket = path.join(home, ".docker/run/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; detect_docker_host`, {
      HOME: home,
      DOCKER_HOST: "",
      NEMOCLAW_TEST_SOCKET_PATHS: `${colimaSocket}:${dockerDesktopSocket}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`unix://${colimaSocket}`);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("detects Docker Desktop when Colima is absent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const dockerDesktopSocket = path.join(home, ".docker/run/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; detect_docker_host`, {
      HOME: home,
      DOCKER_HOST: "",
      NEMOCLAW_TEST_SOCKET_PATHS: dockerDesktopSocket,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`unix://${dockerDesktopSocket}`);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("classifies a Docker Desktop DOCKER_HOST correctly", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; docker_host_runtime "unix:///Users/test/.docker/run/docker.sock"`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("docker-desktop");
  });

  it("selects the matching gateway cluster when a gateway name is present", () => {
    const result = runShell(
      `source "${RUNTIME_SH}";
       select_openshell_cluster_container "nemoclaw" $'openshell-cluster-alpha\\nopenshell-cluster-nemoclaw'`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("openshell-cluster-nemoclaw");
  });

  it("fails on ambiguous cluster selection", () => {
    const result = runShell(
      `source "${RUNTIME_SH}";
       select_openshell_cluster_container "" $'openshell-cluster-a\\nopenshell-cluster-b'`,
    );

    expect(result.status).not.toBe(0);
  });

  it("finds the XDG Colima socket", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const xdgColimaSocket = path.join(home, ".config/colima/default/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; find_colima_docker_socket`, {
      HOME: home,
      NEMOCLAW_TEST_SOCKET_PATHS: xdgColimaSocket,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(xdgColimaSocket);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("detects podman from docker info output", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; infer_container_runtime_from_info "podman version 5.4.1"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("podman");
  });

  it("detects Podman socket on macOS", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const podmanSocket = path.join(home, ".local/share/containers/podman/machine/podman.sock");

    const result = runShell(
      `uname() { printf 'Darwin\\n'; }; source "${RUNTIME_SH}"; find_podman_socket`,
      {
        HOME: home,
        NEMOCLAW_TEST_SOCKET_PATHS: podmanSocket,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(podmanSocket);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("classifies a Podman DOCKER_HOST correctly", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; docker_host_runtime "unix:///run/user/1000/podman/podman.sock"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("podman");
  });

  it("classifies a Podman machine socket correctly", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; docker_host_runtime "unix:///Users/test/.local/share/containers/podman/machine/podman.sock"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("podman");
  });

  it("returns the vllm-local base URL", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url vllm-local`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:8000/v1");
  });

  it("returns the ollama-local proxy base URL for native Docker-style hosts (#3136)", () => {
    const result = runShell(
      `uname() { printf 'Darwin\\n'; }
       docker() { printf 'unexpected docker call\\n' >&2; return 1; }
       source "${RUNTIME_SH}"
       get_local_provider_base_url ollama-local`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:11435/v1");
    expect(result.stderr).toBe("");
  });

  it("returns the raw Ollama port only for WSL Docker Desktop loopback routing (#3136)", () => {
    const result = runShell(
      `uname() { printf '5.15.90.1-microsoft-standard-WSL2\\n'; }
       docker() {
         [ "$1" = "info" ] || return 1
         printf 'Docker Desktop\\n'
       }
       source "${RUNTIME_SH}"
       get_local_provider_base_url ollama-local`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:11434/v1");
  });

  it("honors the configured Ollama proxy port for sandbox-facing URLs (#3136)", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url ollama-local`, {
      NEMOCLAW_OLLAMA_PROXY_PORT: "12435",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:12435/v1");
  });

  it("rejects an invalid Ollama proxy port without emitting a URL (#3136)", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url ollama-local`, {
      NEMOCLAW_OLLAMA_PROXY_PORT: "bad",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid NEMOCLAW_OLLAMA_PROXY_PORT=bad");
  });

  it("rejects an invalid Ollama raw port on the WSL Docker Desktop path (#3136)", () => {
    const result = runShell(
      `uname() { printf '5.15.90.1-microsoft-standard-WSL2\\n'; }
       docker() {
         [ "$1" = "info" ] || return 1
         printf 'Docker Desktop\\n'
       }
       source "${RUNTIME_SH}"
       get_local_provider_base_url ollama-local`,
      { NEMOCLAW_OLLAMA_PORT: "bad" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid NEMOCLAW_OLLAMA_PORT=bad");
  });

  it("rejects equal Ollama raw and proxy ports on non-WSL hosts (#3136)", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url ollama-local`, {
      NEMOCLAW_OLLAMA_PORT: "11434",
      NEMOCLAW_OLLAMA_PROXY_PORT: "11434",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("must differ from NEMOCLAW_OLLAMA_PORT");
  });

  it("checks ollama-local health on the sandbox-facing proxy port (#3136)", () => {
    const result = runShell(
      `curl() { [ "$1" = "-sf" ] && [ "$2" = "http://localhost:12435/api/tags" ]; }
       source "${RUNTIME_SH}"
       check_local_provider_health ollama-local`,
      { NEMOCLAW_OLLAMA_PROXY_PORT: "12435" },
    );
    expect(result.status).toBe(0);
  });

  it("limits host loopback routing to WSL Docker Desktop (#3136)", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"
       is_wsl_runtime "5.15.90.1-microsoft-standard-WSL2"
       printf 'wsl-detect=%s\\n' "$?"
       uname() { printf '5.15.90.1-microsoft-standard-WSL2\\n'; }
       container_can_reach_host_loopback docker-desktop
       printf 'wsl-docker=%s\\n' "$?"
       container_can_reach_host_loopback docker
       printf 'wsl-docker-engine=%s\\n' "$?"
       is_wsl_runtime "23.0.0-darwin"
       printf 'darwin-wsl=%s\\n' "$?"
       uname() { printf '23.0.0-darwin\\n'; }
       container_can_reach_host_loopback docker-desktop
       printf 'darwin-docker-desktop=%s\\n' "$?"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("wsl-detect=0");
    expect(result.stdout).toContain("wsl-docker=0");
    expect(result.stdout).toContain("wsl-docker-engine=1");
    expect(result.stdout).toContain("darwin-wsl=1");
    expect(result.stdout).toContain("darwin-docker-desktop=1");
  });

  it("rejects unknown local providers", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url bogus-provider`);
    expect(result.status).not.toBe(0);
  });

  it("returns the first non-loopback nameserver", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; first_non_loopback_nameserver $'nameserver 127.0.0.11\\nnameserver 10.0.0.2'`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("10.0.0.2");
  });

  it("prefers the container nameserver when it is not loopback", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; resolve_coredns_upstream $'nameserver 10.0.0.2' $'nameserver 1.1.1.1' colima`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("10.0.0.2");
  });

  it("falls back to the Colima VM nameserver when the container resolver is loopback", () => {
    const result = runShell(
      `source "${RUNTIME_SH}";
       get_colima_vm_nameserver() { printf '192.168.5.1\\n'; }
       resolve_coredns_upstream $'nameserver 127.0.0.11' $'nameserver 1.1.1.1' colima`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("192.168.5.1");
  });

  it("falls back to the host nameserver when no Colima VM nameserver is available", () => {
    const result = runShell(
      `source "${RUNTIME_SH}";
       get_colima_vm_nameserver() { return 1; }
       resolve_coredns_upstream $'nameserver 127.0.0.11' $'nameserver 9.9.9.9' colima`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("9.9.9.9");
  });

  it("does not consume installer stdin when reading the Colima VM nameserver", () => {
    const result = runShell(
      `function colima() { cat > /dev/null || true; printf 'nameserver 100.100.100.100\\n'; }
       source "${RUNTIME_SH}"
       printf 'sandbox-answer\\n' | {
         get_colima_vm_nameserver > /tmp/nemoclaw-colima-ns.out
         cat
       }`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("sandbox-answer");
  });
});
