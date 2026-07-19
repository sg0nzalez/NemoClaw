// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readHermesBuildSettings } from "../agents/hermes/config/build-env.ts";
import { patchStagedDockerfile } from "../src/lib/onboard/dockerfile-patch";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function stageDockerfile(providerArgLine: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-id-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(
    file,
    [
      "ARG NEMOCLAW_MODEL=old",
      providerArgLine,
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
      "ARG CHAT_UI_URL=old",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
      "ARG NEMOCLAW_INFERENCE_API=old",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
      "ARG NEMOCLAW_BUILD_ID=old",
      "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
    ].join("\n"),
    "utf-8",
  );
  return file;
}

const MANAGED_DOCKERFILES = [
  "agents/hermes/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile",
];

describe("inference provider route identifier rename (#7177)", () => {
  it("patches the managed NEMOCLAW_INFERENCE_PROVIDER_ID route identifier", () => {
    const file = stageDockerfile("ARG NEMOCLAW_INFERENCE_PROVIDER_ID=old");
    patchStagedDockerfile(
      file,
      "nvidia/nemotron-3-super-120b-a12b",
      "http://127.0.0.1:18789",
      "build-provider-id",
      "nvidia-prod",
    );
    const patched = fs.readFileSync(file, "utf-8");
    expect(patched).toContain("ARG NEMOCLAW_INFERENCE_PROVIDER_ID=inference");
  });

  it("still patches the legacy NEMOCLAW_PROVIDER_KEY name during the migration window", () => {
    const file = stageDockerfile("ARG NEMOCLAW_PROVIDER_KEY=old");
    patchStagedDockerfile(
      file,
      "nvidia/nemotron-3-super-120b-a12b",
      "http://127.0.0.1:18789",
      "build-legacy",
      "nvidia-prod",
    );
    const patched = fs.readFileSync(file, "utf-8");
    expect(patched).toContain("ARG NEMOCLAW_PROVIDER_KEY=inference");
  });

  it.each(
    MANAGED_DOCKERFILES,
  )("declares the non-secret route identifier and no secret-shaped name in %s", (relative) => {
    const source = fs.readFileSync(path.join(process.cwd(), relative), "utf-8");
    expect(source).toMatch(/^ARG NEMOCLAW_INFERENCE_PROVIDER_ID=/m);
    expect(source).toMatch(
      /^\s*NEMOCLAW_INFERENCE_PROVIDER_ID=\$\{NEMOCLAW_INFERENCE_PROVIDER_ID\}/m,
    );
    expect(source).not.toContain("NEMOCLAW_PROVIDER_KEY");
  });

  it("reads the route identifier from NEMOCLAW_INFERENCE_PROVIDER_ID", () => {
    const settings = readHermesBuildSettings({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
    } as NodeJS.ProcessEnv);
    expect(settings.providerKey).toBe("openai");
  });

  it("falls back to the legacy NEMOCLAW_PROVIDER_KEY name", () => {
    const settings = readHermesBuildSettings({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_PROVIDER_KEY: "openai",
    } as NodeJS.ProcessEnv);
    expect(settings.providerKey).toBe("openai");
  });

  it("prefers NEMOCLAW_INFERENCE_PROVIDER_ID over the legacy name", () => {
    const settings = readHermesBuildSettings({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
      NEMOCLAW_PROVIDER_KEY: "anthropic",
    } as NodeJS.ProcessEnv);
    expect(settings.providerKey).toBe("openai");
  });
});

describe("write_auth_profile route identifier migration (#7177)", () => {
  const wrapper = [
    "set -euo pipefail",
    `eval "$(sed -n '/^write_auth_profile() {$/,/^}$/p' "$1")"`,
    "write_auth_profile",
  ].join("\n");

  function runWriteAuthProfile(env: Record<string, string>): {
    home: string;
    authPath: string;
    status: number;
    stderr: string;
  } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-id-auth-"));
    tmpDirs.push(home);
    const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
      input: wrapper,
      env: { PATH: process.env.PATH, HOME: home, ...env },
      encoding: "utf-8",
    });
    return {
      home,
      authPath: path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      status: result.status ?? -1,
      stderr: result.stderr ?? "",
    };
  }

  it("reads the legacy NEMOCLAW_PROVIDER_KEY when NEMOCLAW_INFERENCE_PROVIDER_ID is unset", () => {
    const { authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_PROVIDER_KEY: "openai",
    });
    expect(status, stderr).toBe(0);
    const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(profile).toHaveProperty("openai:manual");
    expect(profile["openai:manual"].provider).toBe("openai");
  });

  it("prefers NEMOCLAW_INFERENCE_PROVIDER_ID over the legacy NEMOCLAW_PROVIDER_KEY", () => {
    const { authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
      NEMOCLAW_PROVIDER_KEY: "anthropic",
    });
    expect(status, stderr).toBe(0);
    const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(profile).toHaveProperty("openai:manual");
    expect(profile).not.toHaveProperty("anthropic:manual");
  });
});
