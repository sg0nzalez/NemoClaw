// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DUAL_STATION_VLLM_RUNTIME, type DualStationVllmPlan } from "./vllm-station-cluster";
import {
  type ModelStagingCommandResult,
  stageDualStationModelSnapshot,
} from "./vllm-station-model-staging";
import {
  createDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";

let sshFixture: DualStationSshBindingFixture;

beforeEach(() => {
  sshFixture = createDualStationSshBindingFixture();
});

function plan(): DualStationVllmPlan {
  return {
    peerSshBinding: sshFixture.binding,
    runtime: DUAL_STATION_VLLM_RUNTIME,
    local: {
      hostname: "station-a",
      home: "/home/nvidia",
      uid: 1000,
      gpu: { index: 0, name: "NVIDIA GB300", uuid: "GPU-a" },
    },
    peer: {
      hostname: "station-b",
      home: "/home/nvidia",
      uid: 1000,
      gpu: { index: 0, name: "NVIDIA GB300", uuid: "GPU-b" },
    },
    rails: [
      {
        index: 0,
        subnet: "192.168.100.0/30",
        local: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8a0",
          macAddress: "02:00:00:00:00:01",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0000:01:00.0",
          address: "192.168.100.1",
        },
        peer: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8b0",
          macAddress: "02:00:00:00:00:02",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0000:01:00.0",
          address: "192.168.100.2",
        },
      },
      {
        index: 1,
        subnet: "192.168.200.0/30",
        local: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8a1",
          macAddress: "02:00:00:00:01:01",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0000:01:00.1",
          address: "192.168.200.1",
        },
        peer: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8b1",
          macAddress: "02:00:00:00:01:02",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0000:01:00.1",
          address: "192.168.200.2",
        },
      },
    ],
    masterAddress: "192.168.100.1",
    roceGidIndex: 3,
  };
}

function result(stdout = "", status = 0): ModelStagingCommandResult {
  return { status, stdout, stderr: "" };
}

function manifest(): string {
  return JSON.stringify({
    schemaVersion: 1,
    files: [{ path: "config.json", size: 2, sha256: "a".repeat(64) }],
    directories: [],
    totalBytes: 2,
  });
}

function successfulTransferRunner() {
  return vi
    .fn()
    .mockResolvedValueOnce(result(manifest()))
    .mockResolvedValueOnce(result('{"state":"transfer"}'))
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result('{"state":"ready"}'));
}

function stagingSuffix(runCommand: ReturnType<typeof successfulTransferRunner>): string {
  const destination = String(runCommand.mock.calls[2][1].at(-1));
  return destination.match(/\.nemoclaw-staging-[a-f0-9]{32}/)?.[0] ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
  sshFixture.cleanup();
});

describe("dual-Station pinned model staging", () => {
  it("copies only the audited snapshot through strict SSH and verifies it before install", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_AUTH_TOKEN", "must-not-cross-ssh");
    vi.stubEnv("HF_TOKEN", "must-not-cross-ssh");
    const runCommand = successfulTransferRunner();

    await expect(stageDualStationModelSnapshot(plan(), { runCommand })).resolves.toEqual({
      ok: true,
      transferred: true,
    });

    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(runCommand.mock.calls.map((call) => call[0])).toEqual([
      "python3",
      "ssh",
      "rsync",
      "ssh",
    ]);
    const localArgs = runCommand.mock.calls[0][1] as string[];
    expect(localArgs).toEqual([
      "-",
      `/home/nvidia/.cache/huggingface/hub/models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}/snapshots/${DUAL_STATION_VLLM_RUNTIME.modelRevision}`,
      `/home/nvidia/.cache/huggingface/hub/models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}`,
    ]);
    expect(runCommand.mock.calls[0][2].input).toContain("snapshot symlink escapes");
    expect(runCommand.mock.calls[0][2].input).toContain("len(shards) != 113");

    const sshArgs = runCommand.mock.calls[1][1] as string[];
    expect(sshArgs).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ClearAllForwardings=yes",
        "ControlMaster=no",
        `UserKnownHostsFile=${sshFixture.binding.knownHostsFile}`,
        "GlobalKnownHostsFile=/dev/null",
        `HostKeyAlias=${sshFixture.binding.lookupHost}`,
        `Hostname=${sshFixture.binding.resolvedHost}`,
        "User=nvidia",
        "Port=22",
        "--",
        "nvidia@station-b",
        "python3 -",
      ]),
    );
    expect(runCommand.mock.calls[1][2].input).toContain("peer pinned snapshot already exists");
    expect(runCommand.mock.calls[1][2].input).toContain("shutil.disk_usage(STAGING.parent).free");
    expect(runCommand.mock.calls[3][2].input).toContain("os.rename(STAGING, FINAL)");
    expect(runCommand.mock.calls[3][2].input).toContain("installed_identity != staged_identity");

    const rsyncArgs = runCommand.mock.calls[2][1] as string[];
    expect(rsyncArgs).toEqual(
      expect.arrayContaining(["--copy-links", "--checksum", "--partial", "--protect-args", "--"]),
    );
    expect(rsyncArgs).not.toContain("--delete");
    expect(rsyncArgs.at(-1)).toMatch(
      new RegExp(
        `^nvidia@station-b:/home/nvidia/\\.cache/huggingface/hub/models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}/snapshots/\\.nemoclaw-staging-[a-f0-9]{32}/$`,
      ),
    );
    expect(rsyncArgs.join(" ")).toContain("StrictHostKeyChecking=yes");
    expect(runCommand.mock.calls[2][2]).toMatchObject({
      idleTimeoutMs: 30 * 60 * 1000,
      streamOutput: true,
    });
    expect(runCommand.mock.calls[2][2].env.OPENSHELL_GATEWAY_AUTH_TOKEN).toBeUndefined();
    expect(runCommand.mock.calls[2][2].env.HF_TOKEN).toBeUndefined();
  });

  it("does no transfer when the peer already has the exact byte manifest", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result(manifest()))
      .mockResolvedValueOnce(result('{"state":"ready"}'));

    await expect(stageDualStationModelSnapshot(plan(), { runCommand })).resolves.toEqual({
      ok: true,
      transferred: false,
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).not.toHaveBeenCalledWith("rsync", expect.anything(), expect.anything());
  });

  it("gives concurrent reversed and different local heads disjoint retry-safe staging paths", async () => {
    const original = plan();
    const reversed = plan();
    const reversedLocal = reversed.local;
    reversed.local = reversed.peer;
    reversed.peer = reversedLocal;
    const reversedSshFixture = createDualStationSshBindingFixture("nvidia@station-a");
    reversed.peerSshBinding = reversedSshFixture.binding;
    const differentHead = plan();
    differentHead.local.gpu.uuid = "GPU-c";
    const originalRunner = successfulTransferRunner();
    const reversedRunner = successfulTransferRunner();
    const differentHeadRunner = successfulTransferRunner();

    try {
      await Promise.all([
        stageDualStationModelSnapshot(original, { runCommand: originalRunner }),
        stageDualStationModelSnapshot(reversed, { runCommand: reversedRunner }),
        stageDualStationModelSnapshot(differentHead, { runCommand: differentHeadRunner }),
      ]);
    } finally {
      reversedSshFixture.cleanup();
    }

    const suffixes = [
      stagingSuffix(originalRunner),
      stagingSuffix(reversedRunner),
      stagingSuffix(differentHeadRunner),
    ];
    expect(suffixes.every((suffix) => /^\.nemoclaw-staging-[a-f0-9]{32}$/.test(suffix))).toBe(true);
    expect(new Set(suffixes).size).toBe(3);
  });

  it("reuses the same deterministic partial path for the same ordered pair", async () => {
    const firstRunner = successfulTransferRunner();
    const retryRunner = successfulTransferRunner();

    await stageDualStationModelSnapshot(plan(), { runCommand: firstRunner });
    await stageDualStationModelSnapshot(plan(), { runCommand: retryRunner });

    expect(stagingSuffix(firstRunner)).toBe(stagingSuffix(retryRunner));
  });

  it("leaves the private staging tree for a safe retry when rsync fails", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result(manifest()))
      .mockResolvedValueOnce(result('{"state":"transfer"}'))
      .mockResolvedValueOnce({ status: 23, stdout: "", stderr: "partial transfer" });

    await expect(stageDualStationModelSnapshot(plan(), { runCommand })).resolves.toEqual({
      ok: false,
      reason: "peer snapshot transfer failed: partial transfer",
    });
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it("rejects a peer home that cannot be represented without remote shell syntax", async () => {
    const unsafe = plan();
    unsafe.peer.home = "/home/nvidia;touch-pwned";
    const runCommand = vi.fn();

    await expect(stageDualStationModelSnapshot(unsafe, { runCommand })).resolves.toEqual({
      ok: false,
      reason: "peer home is unsafe for model staging",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails before any command when the qualified host-key pin changes", async () => {
    fs.appendFileSync(sshFixture.binding.knownHostsFile, "changed\n");
    const runCommand = vi.fn();

    await expect(stageDualStationModelSnapshot(plan(), { runCommand })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("known-hosts binding changed"),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails before SSH when the local manifest is malformed", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(result('{"schemaVersion":1}'));

    await expect(stageDualStationModelSnapshot(plan(), { runCommand })).resolves.toEqual({
      ok: false,
      reason: "local pinned snapshot audit returned an invalid manifest",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
