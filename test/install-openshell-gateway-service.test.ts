// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TEST_SYSTEM_PATH, writeExecutable } from "./helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");

describe("install.sh OpenShell gateway service", () => {
  it("stages a Linux OpenShell gateway user service from the installer wrapper", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, "bin", "openshell-gateway");
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          `source ${JSON.stringify(INSTALLER)}`,
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: TEST_SYSTEM_PATH,
          NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        },
      },
    );

    const unit = fs.readFileSync(servicePath, "utf-8");
    expect(result.status).toBe(0);
    expect(unit).toContain("NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1");
    expect(unit).toContain(`ExecStart=${gatewayBin}`);
  });

  it("stages the Linux OpenShell gateway user service under XDG_CONFIG_HOME", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, "bin", "openshell-gateway");
    const xdgConfigHome = path.join(tmp, "xdg-config");
    const servicePath = path.join(xdgConfigHome, "systemd", "user", "openshell-gateway.service");
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          `source ${JSON.stringify(INSTALLER)}`,
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: TEST_SYSTEM_PATH,
          XDG_CONFIG_HOME: xdgConfigHome,
          NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.readFileSync(servicePath, "utf-8")).toContain(`ExecStart=${gatewayBin}`);
  });

  it("skips service staging for relative gateway binary paths", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, "openshell-gateway");
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          `source ${JSON.stringify(INSTALLER)}`,
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          NEMOCLAW_OPENSHELL_GATEWAY_BIN: "./openshell-gateway",
          PATH: TEST_SYSTEM_PATH,
          NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("removes a marked user override before resolving a gateway binary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      [
        "# NemoClaw-managed OpenShell gateway user service",
        "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          `source ${JSON.stringify(INSTALLER)}`,
          "upstream_openshell_gateway_user_service_installed() { return 0; }",
          "resolve_openshell_gateway_bin_for_service() { return 1; }",
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: TEST_SYSTEM_PATH,
          NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("does not overwrite a foreign user service containing the marker text", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, "bin", "openshell-gateway");
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    const originalUnit = [
      "# foreign unit",
      "# not NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1",
      "[Service]",
      "ExecStart=/tmp/foreign-openshell-gateway",
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.writeFileSync(servicePath, originalUnit);

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          `source ${JSON.stringify(INSTALLER)}`,
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: TEST_SYSTEM_PATH,
          NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.readFileSync(servicePath, "utf-8")).toBe(originalUnit);
  });
});
