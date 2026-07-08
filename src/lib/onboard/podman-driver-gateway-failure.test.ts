// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChildExitState } from "./child-exit-tracker";
import { reportPodmanDriverGatewayStartFailure } from "./podman-driver-gateway-failure";

function makeExitState(partial: Partial<ChildExitState> = {}): ChildExitState {
  return {
    exited: false,
    code: null,
    signal: null,
    describeExit: () => null,
    ...partial,
  } as ChildExitState;
}

describe("reportPodmanDriverGatewayStartFailure", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints Podman socket restart guidance when the log shows connection refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(
      log,
      [
        "Using compute driver driver=podman",
        'Compute driver watch stream failed to start error=code: Internal, message: "connection error: /run/user/1000/podman/podman.sock: Connection refused (os error 111)"',
      ].join("\n"),
    );

    try {
      reportPodmanDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
        socketPath: "/run/user/1000/podman/podman.sock",
      });

      const joined = errSpy.mock.calls.map((call: string[]) => call.join(" ")).join("\n");
      expect(joined).toContain("OpenShell Podman-driver gateway failed to start");
      expect(joined).toContain("Root cause: the rootless Podman API socket refused connections");
      expect(joined).toContain("systemctl --user restart podman.socket");
      expect(joined).toContain("podman --url unix:///run/user/1000/podman/podman.sock info");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls process.exit(1) when exitOnFailure is true", () => {
    expect(() =>
      reportPodmanDriverGatewayStartFailure("/tmp/nonexistent-gateway.log", makeExitState(), {
        exitOnFailure: true,
        socketPath: "/run/user/1000/podman/podman.sock",
      }),
    ).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
