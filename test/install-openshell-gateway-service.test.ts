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
});
