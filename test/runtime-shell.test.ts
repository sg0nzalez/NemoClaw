// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OLLAMA_PORT, OLLAMA_PROXY_PORT } from "../src/lib/core/ports";
import { type ContainerRuntime, containerCanReachHostLoopback, isWsl } from "../src/lib/platform";

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

function createFakeDockerInfo(info: string): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-bin-"));
  const escapedInfo = info.replace(/'/g, "'\\''");
  const dockerPath = path.join(binDir, "docker");
  fs.writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
case "$1" in
  info) printf '%s\\n' '${escapedInfo}' ;;
  *) exit 1 ;;
esac
`,
  );
  fs.chmodSync(dockerPath, 0o755);
  return binDir;
}

const ROUTING_RUNTIME_FIXTURES: ReadonlyArray<{
  info: string;
  runtime: ContainerRuntime;
}> = [
  { info: "Docker Desktop 4.42.1", runtime: "docker-desktop" },
  { info: "Docker Engine - Community 24.0.9", runtime: "docker" },
  { info: "Docker Engine - Community 25.0.5", runtime: "docker" },
  { info: "Docker Engine - Community 26.1.4", runtime: "docker" },
  { info: "Docker Engine - Community 27.5.1", runtime: "docker" },
  { info: "podman version 5.4.1", runtime: "podman" },
  { info: "colima 0.8.4 docker", runtime: "colima" },
  { info: "unrecognized runtime", runtime: "unknown" },
];

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
    const binDir = createFakeDockerInfo("Docker Desktop");
    try {
      const result = runShell(
        `uname() {
           case "$1" in
             -s) printf 'Linux\\n' ;;
             -r) printf '5.15.90.1-microsoft-standard-WSL2\\n' ;;
             *) printf 'Linux\\n' ;;
           esac
         }
         source "${RUNTIME_SH}"
         get_local_provider_base_url ollama-local`,
        { PATH: `${binDir}:/usr/bin:/bin` },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("http://host.openshell.internal:11434/v1");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("detects WSL from WSL_DISTRO_NAME on Linux (#3136)", () => {
    const result = runShell(
      `uname() {
         case "$1" in
           -s) printf 'Linux\\n' ;;
           -r) printf '6.1.0\\n' ;;
           *) printf 'Linux\\n' ;;
         esac
       }
       source "${RUNTIME_SH}"
       is_wsl_runtime`,
      { WSL_DISTRO_NAME: "Ubuntu" },
    );
    expect(result.status).toBe(0);
  });

  it("detects WSL from WSL_INTEROP on Linux (#3136)", () => {
    const result = runShell(
      `uname() {
         case "$1" in
           -s) printf 'Linux\\n' ;;
           -r) printf '6.1.0\\n' ;;
           *) printf 'Linux\\n' ;;
         esac
       }
       source "${RUNTIME_SH}"
       is_wsl_runtime`,
      { WSL_INTEROP: "/run/WSL/123_interop" },
    );
    expect(result.status).toBe(0);
  });

  it.each([
    {
      env: { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "" },
      platform: "linux" as const,
      procVersion: "",
      release: "6.1.0",
      systemName: "Linux",
    },
    {
      env: { WSL_DISTRO_NAME: "", WSL_INTEROP: "/run/WSL/123_interop" },
      platform: "linux" as const,
      procVersion: "",
      release: "6.1.0",
      systemName: "Linux",
    },
    {
      env: { WSL_DISTRO_NAME: "", WSL_INTEROP: "" },
      platform: "linux" as const,
      procVersion: "",
      release: "5.15.90.1-microsoft-standard-WSL2",
      systemName: "Linux",
    },
    {
      env: { WSL_DISTRO_NAME: "", WSL_INTEROP: "" },
      platform: "linux" as const,
      procVersion: "Linux version 5.15.90.1-microsoft-standard-WSL2",
      release: "6.1.0-generic",
      systemName: "Linux",
    },
    {
      env: { WSL_DISTRO_NAME: "", WSL_INTEROP: "" },
      platform: "linux" as const,
      procVersion: "",
      release: "6.1.0",
      systemName: "Linux",
    },
    {
      env: { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/123_interop" },
      platform: "darwin" as const,
      procVersion: "Linux version microsoft-standard-WSL2",
      release: "24.6.0",
      systemName: "Darwin",
    },
  ])("matches TypeScript WSL classification for $systemName $release (#3136)", ({
    env,
    platform,
    procVersion,
    release,
    systemName,
  }) => {
    const result = runShell(
      `uname() {
           case "$1" in
             -s) printf '%s\\n' '${systemName}' ;;
             -r) printf '%s\\n' '${release}' ;;
             *) printf '%s\\n' '${systemName}' ;;
           esac
         }
         cat() {
           case "$1" in
             /proc/version) printf '%s\\n' '${procVersion}' ;;
             *) command cat "$@" ;;
           esac
         }
         source "${RUNTIME_SH}"
         is_wsl_runtime`,
      env,
    );

    const shellDetectedWsl = result.status === 0;
    const typescriptDetectedWsl = isWsl({ env, platform, procVersion, release });
    expect(shellDetectedWsl).toBe(typescriptDetectedWsl);
  });

  it.each(
    [false, true].flatMap((isWslHost) =>
      ROUTING_RUNTIME_FIXTURES.map(({ info, runtime }) => ({ info, isWslHost, runtime })),
    ),
  )("matches TypeScript Ollama routing for $runtime with isWsl=$isWslHost (#3136)", ({
    info,
    isWslHost,
    runtime,
  }) => {
    const binDir = createFakeDockerInfo(info);
    try {
      const result = runShell(
        `uname() {
             case "$1" in
               -s) printf 'Linux\\n' ;;
               -r) printf '6.1.0-generic\\n' ;;
               *) printf 'Linux\\n' ;;
             esac
           }
           source "${RUNTIME_SH}"
           get_local_provider_base_url ollama-local`,
        {
          NEMOCLAW_OLLAMA_PORT: "",
          NEMOCLAW_OLLAMA_PROXY_PORT: "",
          PATH: `${binDir}:/usr/bin:/bin`,
          WSL_DISTRO_NAME: isWslHost ? "Ubuntu" : "",
          WSL_INTEROP: "",
        },
      );
      const expectedPort = containerCanReachHostLoopback(runtime, { isWsl: isWslHost })
        ? OLLAMA_PORT
        : OLLAMA_PROXY_PORT;

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        `http://host.openshell.internal:${String(expectedPort)}/v1`,
      );
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("ignores WSL env on non-Linux hosts and keeps ollama-local on the proxy route (#3136)", () => {
    const binDir = createFakeDockerInfo("Docker Desktop");
    try {
      const result = runShell(
        `uname() {
           case "$1" in
             -s) printf 'Darwin\\n' ;;
             -r) printf '23.0.0-darwin\\n' ;;
             *) printf 'Darwin\\n' ;;
           esac
         }
         source "${RUNTIME_SH}"
         get_local_provider_base_url ollama-local`,
        {
          PATH: `${binDir}:/usr/bin:/bin`,
          WSL_DISTRO_NAME: "Ubuntu",
          WSL_INTEROP: "/run/WSL/123_interop",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("http://host.openshell.internal:11435/v1");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("honors the configured Ollama proxy port for sandbox-facing URLs (#3136)", () => {
    const result = runShell(
      `uname() { printf '23.0.0-darwin\\n'; }
       source "${RUNTIME_SH}"
       get_local_provider_base_url ollama-local`,
      {
        NEMOCLAW_OLLAMA_PROXY_PORT: "12435",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:12435/v1");
  });

  it("rejects an invalid Ollama proxy port without emitting a URL (#3136)", () => {
    const result = runShell(
      `uname() { printf '23.0.0-darwin\\n'; }
       source "${RUNTIME_SH}"
       get_local_provider_base_url ollama-local`,
      {
        NEMOCLAW_OLLAMA_PROXY_PORT: "bad",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid NEMOCLAW_OLLAMA_PROXY_PORT=bad");
  });

  it("rejects an invalid Ollama raw port on the WSL Docker Desktop path (#3136)", () => {
    const binDir = createFakeDockerInfo("Docker Desktop");
    try {
      const result = runShell(
        `uname() {
           case "$1" in
             -s) printf 'Linux\\n' ;;
             -r) printf '5.15.90.1-microsoft-standard-WSL2\\n' ;;
             *) printf 'Linux\\n' ;;
           esac
         }
         source "${RUNTIME_SH}"
         get_local_provider_base_url ollama-local`,
        { NEMOCLAW_OLLAMA_PORT: "bad", PATH: `${binDir}:/usr/bin:/bin` },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid NEMOCLAW_OLLAMA_PORT=bad");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("falls back to the Ollama proxy when Docker runtime detection is unavailable (#3136)", () => {
    const result = runShell(
      `uname() { printf '23.0.0-darwin\\n'; }
       source "${RUNTIME_SH}"
       detect_container_runtime_from_docker
       get_local_provider_base_url ollama-local`,
      { PATH: "/usr/bin:/bin" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("unknown\nhttp://host.openshell.internal:11435/v1");
  });

  it("rejects equal Ollama raw and proxy ports on non-WSL hosts (#3136)", () => {
    const result = runShell(
      `uname() { printf '23.0.0-darwin\\n'; }
       source "${RUNTIME_SH}"
       get_local_provider_base_url ollama-local`,
      {
        NEMOCLAW_OLLAMA_PORT: "11434",
        NEMOCLAW_OLLAMA_PROXY_PORT: "11434",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("must differ from NEMOCLAW_OLLAMA_PORT");
  });

  it("allows equal ports when WSL Docker Desktop bypasses the proxy listener (#3136)", () => {
    const binDir = createFakeDockerInfo("Docker Desktop 4.42.1");
    try {
      const result = runShell(
        `uname() {
           case "$1" in
             -s) printf 'Linux\\n' ;;
             -r) printf '6.1.0-generic\\n' ;;
             *) printf 'Linux\\n' ;;
           esac
         }
         source "${RUNTIME_SH}"
         get_local_provider_base_url ollama-local`,
        {
          NEMOCLAW_OLLAMA_PORT: "11434",
          NEMOCLAW_OLLAMA_PROXY_PORT: "11434",
          PATH: `${binDir}:/usr/bin:/bin`,
          WSL_DISTRO_NAME: "Ubuntu",
          WSL_INTEROP: "",
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("http://host.openshell.internal:11434/v1");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("checks ollama-local health on the raw daemon while sandbox URLs use the proxy (#3136)", () => {
    const result = runShell(
      `uname() { printf '23.0.0-darwin\\n'; }
       curl() { [ "$1" = "-sf" ] && [ "$2" = "http://127.0.0.1:11434/api/tags" ]; }
       source "${RUNTIME_SH}"
       get_local_provider_base_url ollama-local
       check_local_provider_health ollama-local`,
      { NEMOCLAW_OLLAMA_PROXY_PORT: "12435" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:12435/v1");
  });

  it("keeps non-WSL Docker Desktop on the managed proxy route (#3136)", () => {
    const binDir = createFakeDockerInfo("Docker Desktop");
    try {
      const result = runShell(
        `uname() {
           case "$1" in
             -s) printf 'Darwin\\n' ;;
             -r) printf '23.0.0-darwin\\n' ;;
             *) printf 'Darwin\\n' ;;
           esac
         }
         source "${RUNTIME_SH}"
         get_local_provider_base_url ollama-local`,
        { PATH: `${binDir}:/usr/bin:/bin` },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("http://host.openshell.internal:11435/v1");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown local providers", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url bogus-provider`);
    expect(result.status).not.toBe(0);
  });

  // An out-of-range or non-numeric NEMOCLAW_VLLM_PORT / NEMOCLAW_OLLAMA_PORT
  // must be rejected by _validate_port so get_local_provider_base_url and
  // check_local_provider_health fail closed instead of building a bogus URL.
  it.each([
    { name: "NEMOCLAW_VLLM_PORT", value: "99999" },
    { name: "NEMOCLAW_VLLM_PORT", value: "0" },
    { name: "NEMOCLAW_VLLM_PORT", value: "abc" },
    { name: "NEMOCLAW_OLLAMA_PORT", value: "99999" },
    { name: "NEMOCLAW_OLLAMA_PORT", value: "0" },
    { name: "NEMOCLAW_OLLAMA_PORT", value: "abc" },
  ])("get_local_provider_base_url fails closed on invalid $name=$value", ({ name, value }) => {
    const provider = name === "NEMOCLAW_VLLM_PORT" ? "vllm-local" : "ollama-local";
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url ${provider}`, {
      [name]: value,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain(`Invalid ${name}=${value} (expected 1024-65535)`);
  });

  it.each([
    { name: "NEMOCLAW_VLLM_PORT", value: "99999" },
    { name: "NEMOCLAW_VLLM_PORT", value: "0" },
    { name: "NEMOCLAW_VLLM_PORT", value: "abc" },
    { name: "NEMOCLAW_OLLAMA_PORT", value: "99999" },
    { name: "NEMOCLAW_OLLAMA_PORT", value: "0" },
    { name: "NEMOCLAW_OLLAMA_PORT", value: "abc" },
  ])("check_local_provider_health fails closed on invalid $name=$value", ({ name, value }) => {
    const provider = name === "NEMOCLAW_VLLM_PORT" ? "vllm-local" : "ollama-local";
    const result = runShell(`source "${RUNTIME_SH}"; check_local_provider_health ${provider}`, {
      [name]: value,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Invalid ${name}=${value} (expected 1024-65535)`);
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
