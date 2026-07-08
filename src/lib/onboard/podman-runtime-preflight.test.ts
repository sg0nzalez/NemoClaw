// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessPodmanRuntime,
  assertPodmanRuntimeAvailable,
  ensurePodmanRuntimePrerequisitesForOnboard,
  planPodmanRuntimeRemediation,
  type PodmanRuntimeAssessment,
  resolvePodmanSocketPath,
} from "./podman-runtime-preflight";

describe("Podman runtime preflight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function subidReadFile(filePath: string): string {
    if (filePath === "/etc/subuid" || filePath === "/etc/subgid") return "tester:100000:65536\n";
    return "";
  }

  function readyAssessment(
    overrides: Partial<PodmanRuntimeAssessment> = {},
  ): PodmanRuntimeAssessment {
    return {
      installed: true,
      reachable: true,
      rootless: true,
      cgroupVersion: "v2",
      packageManager: "apt",
      platform: "linux",
      socketPath: "/run/user/1000/podman/podman.sock",
      socketExists: true,
      socketReachable: true,
      subuidConfigured: true,
      subgidConfigured: true,
      invalidSubuidRanges: [],
      invalidSubgidRanges: [],
      recommendedSubidRange: "100000-165535",
      systemctlAvailable: true,
      userName: "tester",
      infoSummary: "5.0.0 · linux · amd64",
      detail: null,
      ...overrides,
    };
  }

  it("resolves the OpenShell Podman socket override before platform defaults", () => {
    expect(
      resolvePodmanSocketPath({
        env: { OPENSHELL_PODMAN_SOCKET: "unix:///tmp/podman.sock" } as NodeJS.ProcessEnv,
        platform: "linux",
        uid: 1234,
      }),
    ).toBe("/tmp/podman.sock");
  });

  it("uses XDG_RUNTIME_DIR for the Linux rootless Podman socket", () => {
    expect(
      resolvePodmanSocketPath({
        env: { XDG_RUNTIME_DIR: "/run/user/4242" } as NodeJS.ProcessEnv,
        platform: "linux",
        uid: 1234,
      }),
    ).toBe("/run/user/4242/podman/podman.sock");
  });

  it("accepts a reachable rootless cgroups-v2 Podman runtime", () => {
    const runCaptureImpl = vi.fn((args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("command -v")) return "/usr/bin/podman\n";
      if (joined.includes("{{json .}}")) {
        return JSON.stringify({
          version: { Version: "5.0.0" },
          host: { os: "linux", arch: "amd64" },
        });
      }
      if (joined.includes("Rootless")) return "true\n";
      if (joined.includes("CgroupVersion")) return "v2\n";
      return "";
    });

    const assessment = assessPodmanRuntime({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv,
      platform: "linux",
      readFileImpl: subidReadFile,
      runCaptureImpl,
      socketExistsImpl: () => true,
      uid: 1000,
      userName: "tester",
    });

    expect(assessment).toMatchObject({
      installed: true,
      reachable: true,
      rootless: true,
      cgroupVersion: "v2",
      socketPath: "/run/user/1000/podman/podman.sock",
      socketExists: true,
      socketReachable: true,
      infoSummary: "5.0.0 · linux · amd64",
    });
    expect(assertPodmanRuntimeAvailable(assessment)).toBe(assessment);
  });

  it("falls back to the host cgroup mount when older Podman omits CgroupVersion", () => {
    const runCaptureImpl = vi.fn((args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("command -v")) return "/usr/bin/podman\n";
      if (joined.includes("{{json .}}")) {
        return JSON.stringify({
          version: { Version: "4.9.3" },
          host: { os: "linux", arch: "amd64" },
        });
      }
      if (joined.includes("Rootless")) return "true\n";
      if (joined.includes("CgroupVersion")) {
        return 'Error: template: info:1:52: executing "info" at <.Host.CgroupVersion>\n';
      }
      return "";
    });

    const assessment = assessPodmanRuntime({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv,
      platform: "linux",
      readFileImpl: subidReadFile,
      runCaptureImpl,
      socketExistsImpl: () => true,
      detectCgroupVersionImpl: () => "v2",
      uid: 1000,
      userName: "tester",
    });

    expect(assessment.cgroupVersion).toBe("v2");
    expect(assertPodmanRuntimeAvailable(assessment)).toBe(assessment);
  });

  it("rejects subordinate ID ranges that include the current user ID", () => {
    const runCaptureImpl = vi.fn((args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("command -v")) return "/usr/bin/tool\n";
      if (joined.includes("{{json .}}")) {
        return JSON.stringify({
          version: { Version: "5.0.0" },
          host: { os: "linux", arch: "amd64" },
        });
      }
      if (joined.includes("Rootless")) return "true\n";
      if (joined.includes("CgroupVersion")) return "v2\n";
      return "";
    });
    const readFileImpl = (filePath: string): string => {
      if (filePath === "/etc/subuid" || filePath === "/etc/subgid") {
        return [
          "nvinf:100000:65536",
          "svcunixadmin:165536:65536",
          "ubuntu:231072:65536",
          "tester:100000:65536",
        ].join("\n");
      }
      return "";
    };

    const assessment = assessPodmanRuntime({
      env: { XDG_RUNTIME_DIR: "/run/user/157668" } as NodeJS.ProcessEnv,
      gid: 157668,
      platform: "linux",
      readFileImpl,
      runCaptureImpl,
      socketExistsImpl: () => true,
      uid: 157668,
      userName: "tester",
    });

    expect(assessment.subuidConfigured).toBe(false);
    expect(assessment.subgidConfigured).toBe(false);
    expect(assessment.invalidSubuidRanges).toContain("100000-165535");
    expect(assessment.invalidSubgidRanges).toContain("100000-165535");
    expect(assessment.recommendedSubidRange).toBe("296608-362143");

    const action = planPodmanRuntimeRemediation(assessment).find(
      (entry) => entry.id === "configure_podman_subids",
    );
    expect(action?.commands.join("\n")).toContain("sudo sed -i '/^tester:/d'");
    expect(action?.commands.join("\n")).toContain("tester:296608:65536");
  });

  it("keeps podman info stderr in the failure detail", () => {
    const runCaptureImpl = vi.fn((args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("command -v") && joined.includes("podman")) return "/usr/bin/podman\n";
      if (joined.includes("command -v") && joined.includes("systemctl")) {
        return "/usr/bin/systemctl\n";
      }
      return "";
    });
    const runCaptureExImpl = vi.fn((args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("{{json .}}")) {
        return {
          stdout: "",
          stderr:
            'time="2026-07-07T17:21:49+05:30" level=error msg="set sticky bit on: chmod /run/user/157668/libpod: read-only file system"',
          exitCode: 1,
          timedOut: false,
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 1,
        timedOut: false,
      };
    });

    const assessment = assessPodmanRuntime({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv,
      platform: "linux",
      readFileImpl: subidReadFile,
      runCaptureExImpl,
      runCaptureImpl,
      socketExistsImpl: () => true,
      uid: 1000,
      userName: "tester",
    });

    expect(assessment.reachable).toBe(false);
    expect(assessment.detail).toContain("set sticky bit");
    expect(assessment.detail).toContain("read-only file system");
  });

  it("exits with actionable diagnostics when the Podman socket is missing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });

    expect(() =>
      assertPodmanRuntimeAvailable(
        {
          ...readyAssessment(),
          socketExists: false,
        },
        exitProcess,
      ),
    ).toThrow("exit 1");

    expect(err.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "systemctl --user enable --now podman.socket",
    );
  });

  it("rejects a Podman socket file that refuses API requests", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const runCaptureImpl = vi.fn((args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("command -v") && joined.includes("podman")) return "/usr/bin/podman\n";
      if (joined.includes("command -v") && joined.includes("systemctl")) {
        return "/usr/bin/systemctl\n";
      }
      return "";
    });
    const runCaptureExImpl = vi.fn((args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("--url")) {
        return {
          stdout: "",
          stderr: "Error: connection error: /run/user/1000/podman/podman.sock: Connection refused",
          exitCode: 125,
          timedOut: false,
        };
      }
      if (joined.includes("{{json .}}")) {
        return {
          stdout: JSON.stringify({
            version: { Version: "5.0.0" },
            host: { os: "linux", arch: "amd64" },
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      if (joined.includes("Rootless")) {
        return { stdout: "true", stderr: "", exitCode: 0, timedOut: false };
      }
      if (joined.includes("CgroupVersion")) {
        return { stdout: "v2", stderr: "", exitCode: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false };
    });

    const assessment = assessPodmanRuntime({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv,
      platform: "linux",
      readFileImpl: subidReadFile,
      runCaptureExImpl,
      runCaptureImpl,
      socketExistsImpl: () => true,
      uid: 1000,
      userName: "tester",
    });

    expect(assessment.reachable).toBe(true);
    expect(assessment.socketExists).toBe(true);
    expect(assessment.socketReachable).toBe(false);
    expect(assessment.detail).toContain("Connection refused");
    expect(() => assertPodmanRuntimeAvailable(assessment, exitProcess)).toThrow("exit 1");

    const output = err.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Podman API socket is not accepting requests");
    expect(output).toContain("systemctl --user restart podman.socket");
    expect(output).toContain("podman --url unix:///run/user/1000/podman/podman.sock info");
  });

  it("plans Podman install, socket, and subuid fixes for an incomplete host", () => {
    const actions = planPodmanRuntimeRemediation(
      readyAssessment({
        installed: false,
        reachable: false,
        socketExists: false,
        socketReachable: false,
        subuidConfigured: false,
        subgidConfigured: false,
      }),
    );

    expect(actions.map((action) => action.id)).toEqual([
      "install_podman",
      "configure_podman_subids",
    ]);
    expect(actions[0].commands.join("\n")).toContain("apt-get");
    expect(actions[1].commands.join("\n")).toContain("/etc/subuid");
    expect(actions[1].commands.join("\n")).toContain("podman system migrate");
  });

  it("plans the rootless Podman user socket start when Podman is installed but unreachable", () => {
    const actions = planPodmanRuntimeRemediation(
      readyAssessment({
        reachable: false,
        socketExists: false,
        socketReachable: false,
      }),
    );

    expect(actions.map((action) => action.id)).toContain("enable_podman_socket");
    expect(actions.find((action) => action.id === "enable_podman_socket")?.commands[0]).toContain(
      "systemctl",
    );
  });

  it("leaves cgroups v2 enablement as a manual blocking prerequisite", () => {
    const actions = planPodmanRuntimeRemediation(
      readyAssessment({
        cgroupVersion: "v1",
      }),
    );

    const action = actions.find((entry) => entry.id === "enable_cgroups_v2");
    expect(action?.kind).toBe("manual");
    expect(action?.blocking).toBe(true);
    expect(action?.setupCommands).toBeUndefined();
  });

  it("applies available Podman setup commands when --yes is active", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const assessments = [
      readyAssessment({ reachable: false, socketExists: false }),
      readyAssessment(),
    ];
    const runInteractiveImpl = vi.fn(() => ({ status: 0 }));

    await expect(
      ensurePodmanRuntimePrerequisitesForOnboard({
        autoYes: true,
        assessImpl: () => assessments.shift() ?? readyAssessment(),
        runInteractiveImpl,
      }),
    ).resolves.toMatchObject({ reachable: true, socketExists: true });

    expect(runInteractiveImpl).toHaveBeenCalledWith(
      ["systemctl", "--user", "enable", "--now", "podman.socket"],
      { ignoreError: true, suppressOutput: false },
    );
    expect(err).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("  Applying Podman gateway runtime prerequisites...");
  });

  it("stops immediately when a Podman setup command fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const runInteractiveImpl = vi.fn(() => ({ status: 1 }));

    await expect(
      ensurePodmanRuntimePrerequisitesForOnboard({
        autoYes: true,
        assessImpl: () =>
          readyAssessment({
            subuidConfigured: false,
            subgidConfigured: false,
          }),
        exitProcess,
        runInteractiveImpl,
      }),
    ).rejects.toThrow("exit 1");

    const output = err.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Podman setup command failed");
    expect(output).toContain("sudo sh -c");
    expect(runInteractiveImpl).toHaveBeenCalledTimes(1);
  });
});
