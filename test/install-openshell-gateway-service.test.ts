// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TEST_SYSTEM_PATH, writeExecutable } from "./helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");

function runInstallHelper(tmp: string, body: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    ["-c", ["set -euo pipefail", `source ${JSON.stringify(INSTALLER)}`, body].join("\n")],
    {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: TEST_SYSTEM_PATH,
        XDG_CONFIG_HOME: "",
        NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        ...env,
      },
    },
  );
}

describe("install.sh OpenShell gateway service", () => {
  it("stages a Linux OpenShell gateway user service from the installer wrapper", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      );

      const unit = fs.readFileSync(servicePath, "utf-8");
      expect(result.status).toBe(0);
      expect(unit).toContain("# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1");
      expect(unit).toContain("After=default.target");
      expect(unit).toContain("Environment=OPENSHELL_LOCAL_TLS_DIR=%h/.local/state/openshell/tls");
      expect(unit).toContain(
        `ExecStartPre=${gatewayBin} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal --server-san localhost --server-san 127.0.0.1`,
      );
      expect(unit).toContain(`ExecStart=${gatewayBin}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reconciles the service when OpenShell already exists in if-missing mode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    const eventsPath = path.join(tmp, "events.log");
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          'command_exists() { [[ "$1" == openshell ]]; }',
          `spin() { printf 'spin\\n' >>${JSON.stringify(eventsPath)}; return 1; }`,
          `prefer_user_local_openshell() { printf 'prefer\\n' >>${JSON.stringify(eventsPath)}; }`,
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "maybe_install_openshell_during_install if-missing",
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(servicePath, "utf-8")).toContain(`ExecStart=${gatewayBin}`);
      expect(fs.readFileSync(eventsPath, "utf-8")).toBe("prefer\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses absolute XDG_CONFIG_HOME for the Linux user service path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const configHome = path.join(tmp, "xdg-config");
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(configHome, "systemd", "user", "openshell-gateway.service");
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
        { XDG_CONFIG_HOME: configHome },
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(servicePath, "utf-8")).toContain(`ExecStart=${gatewayBin}`);
      expect(fs.existsSync(path.join(tmp, ".config", "systemd", "user"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips service staging for relative gateway binary paths", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    writeExecutable(path.join(tmp, "openshell-gateway"), "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
        { NEMOCLAW_OPENSHELL_GATEWAY_BIN: "./openshell-gateway" },
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes a marked user override before resolving a gateway binary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      "# NemoClaw-managed OpenShell gateway user service\n# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n",
    );

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 0; }",
          "resolve_openshell_gateway_bin_for_service() { return 1; }",
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not overwrite a foreign user service containing the marker text", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(tmp, ".config", "systemd", "user", "openshell-gateway.service");
    const originalUnit = "# foreign unit\n# not NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n";
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.writeFileSync(servicePath, originalUnit);

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(servicePath, "utf-8")).toBe(originalUnit);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
