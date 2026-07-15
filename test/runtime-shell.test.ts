// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_SH = path.join(import.meta.dirname, "..", "scripts", "lib", "runtime.sh");

function runShell(
  script: string,
  env: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: path.join(import.meta.dirname, ".."),
    encoding: "utf-8",
    env: { ...process.env, ...env },
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

  it("returns the vllm-local base URL", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url vllm-local`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:8000/v1");
  });

  it("returns the ollama-local base URL", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url ollama-local`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:11434/v1");
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
});
