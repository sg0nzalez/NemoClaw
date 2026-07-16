// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { DUAL_STATION_VLLM_RUNTIME, type DualStationVllmPlan } from "./vllm-station-cluster";
import {
  areDualStationManagedVllmContainersRunning,
  buildDualStationGpuSmokeRunArgs,
  buildDualStationVllmRunArgs,
  cleanupDualStationManagedVllm,
  DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL,
  DUAL_STATION_VLLM_CLUSTER_LABEL,
  DUAL_STATION_VLLM_ENDPOINT_LABEL,
  DUAL_STATION_VLLM_GPU_LABEL,
  DUAL_STATION_VLLM_GPU_SMOKE_LABEL,
  DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
  DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL,
  DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL,
  DUAL_STATION_VLLM_MANAGED_LABEL,
  DUAL_STATION_VLLM_ROLE_LABEL,
  DUAL_STATION_VLLM_TRANSACTION_LABEL,
  DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
  type DualStationDockerOptions,
  type DualStationVllmLifecycleDeps,
  dualStationVllmApiKeyFingerprint,
  dualStationVllmClusterId,
  dualStationVllmLaunchContract,
  getDualStationManagedVllmBaseUrl,
  preflightDualStationGpuRuntime,
  preflightDualStationManagedVllm,
  startDualStationManagedVllm,
  withDualStationManagedVllmLifecycle,
} from "./vllm-station-cluster-lifecycle";

const WORKER_ID = "a".repeat(64);
const HEAD_ID = "b".repeat(64);
const WORKER_SMOKE_ID = "c".repeat(64);
const HEAD_SMOKE_ID = "d".repeat(64);
const API_KEY = "e".repeat(64);
const START_CONFIG = { apiKey: API_KEY };
const API_KEY_FINGERPRINT = dualStationVllmApiKeyFingerprint(API_KEY);
const TRANSACTION_ID = "1".repeat(32);

function fixturePlan(): DualStationVllmPlan {
  return {
    peerSshTarget: "nvidia@station-b",
    peerDockerHost: "ssh://nvidia@station-b",
    runtime: DUAL_STATION_VLLM_RUNTIME,
    local: {
      hostname: "station-a",
      home: "/home/local",
      uid: 1000,
      gpu: {
        index: 0,
        name: "NVIDIA GB300",
        uuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
    },
    peer: {
      hostname: "station-b",
      home: "/home/nvidia",
      uid: 1001,
      gpu: {
        index: 1,
        name: "NVIDIA GB300 Grace Blackwell Superchip",
        uuid: "GPU-99999999-8888-7777-6666-555555555555",
      },
    },
    rails: [
      {
        index: 0,
        subnet: "192.168.240.0/30",
        local: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8a0",
          macAddress: "02:00:00:00:00:01",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0001:03:00.0",
          address: "192.168.240.1",
        },
        peer: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8b0",
          macAddress: "02:00:00:00:00:02",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0002:03:00.0",
          address: "192.168.240.2",
        },
      },
      {
        index: 1,
        subnet: "192.168.240.4/30",
        local: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8a1",
          macAddress: "02:00:00:00:00:05",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0001:03:00.1",
          address: "192.168.240.5",
        },
        peer: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8b1",
          macAddress: "02:00:00:00:00:06",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0002:03:00.1",
          address: "192.168.240.6",
        },
      },
    ],
    masterAddress: "192.168.240.1",
    roceGidIndex: 3,
  };
}

type FakeContainer = {
  id: string;
  name: string;
  state: string;
  image: string;
  labels: Record<string, string>;
};

function dockerValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag && index < args.length - 1 ? [args[index + 1]] : [],
  );
}

function raise(message: string): never {
  throw new Error(message);
}

function row(container: FakeContainer): string {
  return [
    container.id,
    container.name,
    container.state,
    container.image,
    container.labels[DUAL_STATION_VLLM_MANAGED_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_ROLE_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_ENDPOINT_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_CLUSTER_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_GPU_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL] ?? "",
  ].join("\t");
}

function fakeContainer(
  role: "head" | "worker",
  overrides: Partial<FakeContainer> = {},
): FakeContainer {
  return {
    id: role === "head" ? HEAD_ID : WORKER_ID,
    name:
      role === "head"
        ? DUAL_STATION_VLLM_HEAD_CONTAINER_NAME
        : DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
    state: "running",
    image: DUAL_STATION_VLLM_RUNTIME.image,
    labels: {
      [DUAL_STATION_VLLM_MANAGED_LABEL]: "true",
      [DUAL_STATION_VLLM_ROLE_LABEL]: role,
      [DUAL_STATION_VLLM_ENDPOINT_LABEL]:
        role === "head" ? "http://192.168.240.1:8000" : "headless",
      [DUAL_STATION_VLLM_CLUSTER_LABEL]: dualStationVllmClusterId(fixturePlan()),
      [DUAL_STATION_VLLM_GPU_LABEL]:
        role === "head" ? fixturePlan().local.gpu.uuid : fixturePlan().peer.gpu.uuid,
      [DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL]: "1",
      [DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL]: dualStationVllmLaunchContract(fixturePlan(), role),
      [DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL]: API_KEY_FINGERPRINT,
      [DUAL_STATION_VLLM_TRANSACTION_LABEL]: TRANSACTION_ID,
    },
    ...overrides,
  };
}

function harness(
  options: {
    failRole?: "head" | "worker";
    invalidIdRole?: "head" | "worker";
    failSmokeTarget?: "local" | "peer";
    failSmokeCleanupTarget?: "local" | "peer";
    missingImageTarget?: "local" | "peer";
    smokeGpuOutput?: Partial<Record<"local" | "peer", string>>;
    lateCreateRole?: "head" | "worker";
    failedRoleForeignTransaction?: "head" | "worker";
  } = {},
) {
  const containers = new Map<string, FakeContainer[]>();
  const operations: Array<{ kind: "capture" | "rm" | "run"; target: string; value: string }> = [];
  const captureOptions: Array<DualStationDockerOptions | undefined> = [];
  const rmOptions: Array<DualStationDockerOptions | undefined> = [];
  const runCalls: Array<{
    args: readonly string[];
    options: DualStationDockerOptions | undefined;
  }> = [];
  const buildRemoteDockerEnv = vi.fn((sshUri: string) => ({
    TARGET: "peer",
    DOCKER_HOST: sshUri,
    VLLM_API_KEY: "ambient-must-be-stripped",
  }));
  let nonceCounter = 0;
  let transactionCounter = 0;
  let lifecycleLockActive = 0;
  let maxLifecycleLockActive = 0;
  let lifecycleLockTail = Promise.resolve();
  const lifecycleLockContext = new AsyncLocalStorage<boolean>();
  let lateContainer: { targetName: string; container: FakeContainer } | null = null;

  async function acquireLifecycleLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = lifecycleLockTail;
    let release: () => void = () => undefined;
    lifecycleLockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    lifecycleLockActive += 1;
    maxLifecycleLockActive = Math.max(maxLifecycleLockActive, lifecycleLockActive);
    try {
      return await lifecycleLockContext.run(true, operation);
    } finally {
      lifecycleLockActive -= 1;
      release();
    }
  }

  function target(optionsArg?: DualStationDockerOptions): string {
    return String(optionsArg?.env?.TARGET ?? "unknown");
  }

  function key(targetName: string, name: string): string {
    return `${targetName}:${name}`;
  }

  const deps: DualStationVllmLifecycleDeps = {
    buildLocalDockerEnv: () => ({
      TARGET: "local",
      VLLM_API_KEY: "ambient-must-be-stripped",
    }),
    buildRemoteDockerEnv,
    createProbeNonce: () => {
      nonceCounter += 1;
      return nonceCounter.toString(16).padStart(32, "0");
    },
    createTransactionId: () => {
      transactionCounter += 1;
      return transactionCounter.toString(16).padStart(32, "0");
    },
    loadApiKey: () => API_KEY,
    localInterfaceAddresses: () => [fixturePlan().masterAddress],
    waitBeforeReconcile: async () => {
      const pending = lateContainer;
      lateContainer = null;
      return pending
        ? void containers.set(key(pending.targetName, pending.container.name), [pending.container])
        : undefined;
    },
    withLifecycleLock: async <T>(operation: () => Promise<T> | T) =>
      lifecycleLockContext.getStore() ? await operation() : await acquireLifecycleLock(operation),
    dockerCapture: (args, optionsArg) => {
      captureOptions.push(optionsArg);
      const targetName = target(optionsArg);
      switch (args[0]) {
        case "image": {
          operations.push({ kind: "capture", target: targetName, value: `image:${args.at(-1)}` });
          return options.missingImageTarget === targetName
            ? raise("missing image")
            : `sha256:${"f".repeat(64)}\n`;
        }
        case "wait":
          operations.push({ kind: "capture", target: targetName, value: `wait:${args[1]}` });
          return "0\n";
        case "logs": {
          operations.push({ kind: "capture", target: targetName, value: `logs:${args[1]}` });
          const defaultUuid =
            targetName === "local" ? fixturePlan().local.gpu.uuid : fixturePlan().peer.gpu.uuid;
          return `${options.smokeGpuOutput?.[targetName as "local" | "peer"] ?? defaultUuid}\n`;
        }
        default:
          break;
      }
      const filter = dockerValues(args, "--filter")[0] ?? "";
      const name = filter.replace(/^name=\^\//, "").replace(/\$$/, "");
      operations.push({ kind: "capture", target: targetName, value: name });
      const isSmokeInspection =
        dockerValues(args, "--format")[0]?.includes(DUAL_STATION_VLLM_GPU_SMOKE_LABEL) ?? false;
      return (containers.get(key(targetName, name)) ?? [])
        .map((container) =>
          isSmokeInspection
            ? [
                container.id,
                container.name,
                container.image,
                container.labels[DUAL_STATION_VLLM_GPU_SMOKE_LABEL] ?? "",
                container.labels[DUAL_STATION_VLLM_ROLE_LABEL] ?? "",
              ].join("\t")
            : row(container),
        )
        .join("\n");
    },
    dockerRunDetached: (args, optionsArg) => {
      const targetName = target(optionsArg);
      const name = dockerValues(args, "--name")[0];
      runCalls.push({ args: [...args], options: optionsArg });
      operations.push({ kind: "run", target: targetName, value: name });
      const labels = Object.fromEntries(
        dockerValues(args, "--label").map((label) => {
          const separator = label.indexOf("=");
          return [label.slice(0, separator), label.slice(separator + 1)];
        }),
      );
      switch (name.startsWith("nemoclaw-vllm-gpu-smoke-")) {
        case true:
          return options.failSmokeTarget === targetName
            ? { status: 1, stdout: "", stderr: "smoke failed" }
            : (() => {
                const smokeContainer: FakeContainer = {
                  id: targetName === "local" ? HEAD_SMOKE_ID : WORKER_SMOKE_ID,
                  name,
                  state: "exited",
                  image: DUAL_STATION_VLLM_RUNTIME.image,
                  labels,
                };
                containers.set(key(targetName, name), [smokeContainer]);
                return { status: 0, stdout: `${smokeContainer.id}\n` };
              })();
        default:
          break;
      }
      const role = name === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME ? "head" : "worker";
      const imageIndex = args.indexOf("/bin/bash") + 1;
      const container = fakeContainer(role, {
        image: args[imageIndex],
        labels,
      });
      return options.failedRoleForeignTransaction === role
        ? (() => {
            container.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL] = "f".repeat(32);
            containers.set(key(targetName, name), [container]);
            return { status: 1, stdout: "", stderr: "ambiguous failed create" };
          })()
        : options.lateCreateRole === role
          ? (() => {
              lateContainer = { targetName, container };
              return { status: null, stdout: "", stderr: "timed out" };
            })()
          : options.failRole === role
            ? { status: 1, stdout: "", stderr: "failed" }
            : (() => {
                containers.set(key(targetName, name), [container]);
                return {
                  status: 0,
                  stdout:
                    options.invalidIdRole === role ? "not-a-container-id\n" : `${container.id}\n`,
                };
              })();
    },
    dockerForceRm: (containerId, optionsArg) => {
      rmOptions.push(optionsArg);
      const targetName = target(optionsArg);
      operations.push({ kind: "rm", target: targetName, value: containerId });
      const shouldFail =
        options.failSmokeCleanupTarget === targetName &&
        (containerId === WORKER_SMOKE_ID || containerId === HEAD_SMOKE_ID);
      const match = [...containers.entries()].find(
        ([containerKey, entries]) =>
          containerKey.startsWith(`${targetName}:`) &&
          entries.some((entry) => entry.id === containerId),
      );
      return shouldFail || !match
        ? { status: 1 }
        : (() => {
            const [containerKey, entries] = match;
            const remaining = entries.filter((entry) => entry.id !== containerId);
            containers.set(containerKey, remaining);
            return { status: 0 };
          })();
    },
  };

  function seed(targetName: "local" | "peer", container: FakeContainer): void {
    const containerKey = key(targetName, container.name);
    containers.set(containerKey, [...(containers.get(containerKey) ?? []), container]);
  }

  return {
    buildRemoteDockerEnv,
    captureOptions,
    containers,
    deps,
    getMaxLifecycleLockActive: () => maxLifecycleLockActive,
    operations,
    rmOptions,
    runCalls,
    seed,
  };
}

describe("dual-Station managed vLLM run argv", () => {
  it.each(["head", "worker"] as const)("builds the exact %s launch contract", (role) => {
    const plan = fixturePlan();
    const args = buildDualStationVllmRunArgs(plan, role, TRANSACTION_ID, API_KEY_FINGERPRINT);
    const env = dockerValues(args, "--env");
    const expectedNode = role === "head" ? plan.local : plan.peer;
    const expectedNetdev = role === "head" ? "cx8a0" : "cx8b0";

    expect(args).toEqual(
      expect.arrayContaining(["--network", "host", "--shm-size", "16g", "--read-only"]),
    );
    expect(dockerValues(args, "--tmpfs")).toEqual([
      "/tmp:rw,nosuid,nodev,size=17179869184",
      "/root/.cache:rw,nosuid,nodev,size=68719476736",
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--cap-drop",
        "ALL",
        "--cap-add",
        "IPC_LOCK",
        "--cap-add",
        "DAC_READ_SEARCH",
      ]),
    );
    expect(dockerValues(args, "--ulimit")).toEqual([
      "memlock=-1",
      "stack=67108864",
      "nofile=1048576:1048576",
    ]);
    expect(dockerValues(args, "--gpus")).toEqual([`device=${expectedNode.gpu.uuid}`]);
    expect(args.filter((arg) => arg.startsWith("--device="))).toEqual([
      "--device=/dev/infiniband/uverbs0",
      "--device=/dev/infiniband/uverbs1",
    ]);
    expect(dockerValues(args, "--volume")).toEqual([
      `${expectedNode.home}/.cache/huggingface/hub:/root/.cache/huggingface/hub:ro`,
    ]);
    expect(dockerValues(args, "--volume").join("\n")).not.toContain("/huggingface/token");
    expect(env).toEqual(
      expect.arrayContaining([
        "NCCL_IB_HCA=mlx5_0,mlx5_1",
        "NCCL_IB_DISABLE=0",
        "NCCL_IB_GID_INDEX=3",
        `NCCL_SOCKET_IFNAME=${expectedNetdev}`,
        `GLOO_SOCKET_IFNAME=${expectedNetdev}`,
        `TP_SOCKET_IFNAME=${expectedNetdev}`,
        `OMPI_MCA_btl_tcp_if_include=${expectedNetdev}`,
        `MN_IF_NAME=${expectedNetdev}`,
        "NCCL_IGNORE_CPU_AFFINITY=1",
        "UCX_NET_DEVICES=mlx5_0:1,mlx5_1:1",
        "UCX_IB_GID_INDEX=3",
        "HF_HUB_OFFLINE=1",
        "TRANSFORMERS_OFFLINE=1",
      ]),
    );
    expect(args).toContain(plan.runtime.image);
    expect(dockerValues(args, "--label")).toEqual(
      expect.arrayContaining([
        `${DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL}=1`,
        `${DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL}=${dualStationVllmLaunchContract(plan, role)}`,
        `${DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL}=${API_KEY_FINGERPRINT}`,
        `${DUAL_STATION_VLLM_TRANSACTION_LABEL}=${TRANSACTION_ID}`,
      ]),
    );
    expect(args).not.toContain("--privileged");
    expect(args.join("\n")).not.toContain("--device=/dev/infiniband:");
    expect(dockerValues(args, "--env").filter((name) => name === "VLLM_API_KEY")).toEqual(
      role === "head" ? ["VLLM_API_KEY"] : [],
    );
    expect(args).not.toContain(API_KEY);
    expect(args.join("\n")).not.toMatch(/HF_TOKEN|HUGGING_FACE_HUB_TOKEN|docker run/u);
    const command = args.at(-1) ?? "";
    const imageIndex = args.indexOf(plan.runtime.image);
    expect(args.slice(imageIndex - 2, imageIndex + 2)).toEqual([
      "--entrypoint",
      "/bin/bash",
      plan.runtime.image,
      "-lc",
    ]);
    expect(args.filter((arg) => arg === "-lc")).toHaveLength(1);
    expect(imageIndex).toBe(args.length - 3);
    expect(command).toContain(`--node-rank ${role === "head" ? "0" : "1"}`);
    expect(command).toContain(role === "head" ? "--host 192.168.240.1" : "--host 127.0.0.1");
    expect(command.includes("--headless")).toBe(role === "worker");
  });

  it.each(["head", "worker"] as const)("builds a bounded, no-pull %s GPU smoke command", (role) => {
    const nonce = "1".repeat(32);
    const { args, containerName } = buildDualStationGpuSmokeRunArgs(fixturePlan(), role, nonce);

    expect(containerName).toBe(`nemoclaw-vllm-gpu-smoke-${role}-${nonce}`);
    expect(dockerValues(args, "--gpus")).toEqual([
      `device=${role === "head" ? fixturePlan().local.gpu.uuid : fixturePlan().peer.gpu.uuid}`,
    ]);
    expect(dockerValues(args, "--network")).toEqual(["none"]);
    expect(dockerValues(args, "--cap-drop")).toEqual(["ALL"]);
    expect(dockerValues(args, "--label")).toEqual(
      expect.arrayContaining([
        `${DUAL_STATION_VLLM_GPU_SMOKE_LABEL}=${nonce}`,
        `${DUAL_STATION_VLLM_ROLE_LABEL}=${role}`,
      ]),
    );
    expect(args).toContain("--pull=never");
    expect(args).toContain(DUAL_STATION_VLLM_RUNTIME.image);
    expect(args).toEqual(expect.arrayContaining(["--entrypoint", "nvidia-smi"]));
    expect(args).not.toContain("--rm");
    expect(args.join("\n")).not.toContain("VLLM_API_KEY");
  });

  it.each([
    "/dev/infiniband/rdma_cm",
    "/dev/infiniband/uverbs0",
  ])("rejects an unsafe or duplicate verbs character device: %s", (uverbsDevice) => {
    const plan = fixturePlan();
    plan.rails[1].local.uverbsDevice = uverbsDevice;

    expect(() =>
      buildDualStationVllmRunArgs(plan, "head", TRANSACTION_ID, API_KEY_FINGERPRINT),
    ).toThrow(/rails must use two distinct devices|rail endpoint is invalid/u);
  });
});

describe("dual-Station managed vLLM lifecycle", () => {
  it("provides a read-only ownership preflight before download work", () => {
    const fake = harness();

    expect(preflightDualStationManagedVllm(fixturePlan(), fake.deps)).toEqual({ ok: true });
    expect(fake.operations.filter((operation) => operation.kind === "capture")).toHaveLength(2);
    expect(fake.operations.some((operation) => operation.kind === "run")).toBe(false);
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it("proves exact-image GPU execution on both daemons and removes both exact probe IDs", async () => {
    const fake = harness();

    expect(await preflightDualStationGpuRuntime(fixturePlan(), fake.deps)).toEqual({ ok: true });
    expect(fake.operations.filter((operation) => operation.kind === "run")).toHaveLength(2);
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
      { kind: "rm", target: "local", value: HEAD_SMOKE_ID },
    ]);
    expect(
      fake.operations.filter(
        (operation) => operation.kind === "capture" && operation.value.startsWith("image:"),
      ),
    ).toHaveLength(2);
    for (const call of fake.runCalls) {
      expect(call.args).toContain("--pull=never");
      expect(call.args).toContain(DUAL_STATION_VLLM_RUNTIME.image);
      expect(call.options?.env?.VLLM_API_KEY).toBeUndefined();
    }
    for (const options of [...fake.captureOptions, ...fake.rmOptions]) {
      expect(options?.env?.VLLM_API_KEY).toBeUndefined();
    }
  });

  it("does not mutate either daemon unless both exact pinned images are present", async () => {
    const fake = harness({ missingImageTarget: "local" });

    expect(await preflightDualStationGpuRuntime(fixturePlan(), fake.deps)).toEqual({
      ok: false,
      reason: "head pinned vLLM image is not present or could not be inspected",
    });
    expect(fake.operations.some((operation) => operation.kind === "run")).toBe(false);
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it("removes an exact failed GPU probe and never starts the managed containers", async () => {
    const fake = harness({ smokeGpuOutput: { peer: "GPU-not-the-discovered-device" } });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker GPU smoke did not expose exactly the discovered GPU",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "run")).toHaveLength(1);
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
    ]);
  });

  it.each([
    "short",
    "A".repeat(64),
  ])("rejects an unsafe API key before probing: %s", async (apiKey) => {
    const fake = harness();

    expect(await startDualStationManagedVllm(fixturePlan(), { apiKey }, fake.deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("64 lowercase hexadecimal"),
    });
    expect(fake.operations).toEqual([]);
  });

  it("starts the worker before the head and returns validated exact IDs", async () => {
    const fake = harness();

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: true,
      baseUrl: "http://192.168.240.1:8000",
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
      reusedExisting: false,
    });
    expect(fake.operations.filter((operation) => operation.kind === "run")).toEqual([
      {
        kind: "run",
        target: "peer",
        value: `nemoclaw-vllm-gpu-smoke-worker-${"1".padStart(32, "0")}`,
      },
      {
        kind: "run",
        target: "local",
        value: `nemoclaw-vllm-gpu-smoke-head-${"2".padStart(32, "0")}`,
      },
      { kind: "run", target: "peer", value: DUAL_STATION_VLLM_WORKER_CONTAINER_NAME },
      { kind: "run", target: "local", value: DUAL_STATION_VLLM_HEAD_CONTAINER_NAME },
    ]);
    const headRun = fake.runCalls.find(
      ({ args }) => dockerValues(args, "--name")[0] === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
    );
    expect(headRun?.options?.env?.VLLM_API_KEY).toBe(API_KEY);
    expect(headRun?.args).toContain("VLLM_API_KEY");
    expect(headRun?.args).not.toContain(API_KEY);
    for (const call of fake.runCalls.filter((call) => call !== headRun)) {
      expect(call.options?.env?.VLLM_API_KEY).toBeUndefined();
      expect(call.args).not.toContain(API_KEY);
    }
    for (const options of [...fake.captureOptions, ...fake.rmOptions]) {
      expect(options?.env?.VLLM_API_KEY).toBeUndefined();
    }
    expect(fake.buildRemoteDockerEnv).toHaveBeenCalledWith("ssh://nvidia@station-b");
  });

  it("reuses an already-running exact pair without tearing down the working service", async () => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));
    fake.seed("peer", fakeContainer("worker"));

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: true,
      baseUrl: "http://192.168.240.1:8000",
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
      reusedExisting: true,
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
      { kind: "rm", target: "local", value: HEAD_SMOKE_ID },
    ]);
  });

  it.each([
    [DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL, "f".repeat(64)],
    [DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL, "d".repeat(64)],
  ])("recreates an owned pair whose %s no longer matches", async (label, value) => {
    const fake = harness();
    const head = fakeContainer("head");
    const worker = fakeContainer("worker");
    head.labels[label] = value;
    worker.labels[label] = value;
    fake.seed("local", head);
    fake.seed("peer", worker);

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toMatchObject(
      {
        ok: true,
        reusedExisting: false,
      },
    );
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual(
      expect.arrayContaining([
        { kind: "rm", target: "local", value: HEAD_ID },
        { kind: "rm", target: "peer", value: WORKER_ID },
      ]),
    );
  });

  it("recreates a mixed pair from different lifecycle transactions", async () => {
    const fake = harness();
    const worker = fakeContainer("worker");
    worker.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL] = "f".repeat(32);
    fake.seed("local", fakeContainer("head"));
    fake.seed("peer", worker);

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toMatchObject(
      {
        ok: true,
        reusedExisting: false,
      },
    );
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual(
      expect.arrayContaining([
        { kind: "rm", target: "local", value: HEAD_ID },
        { kind: "rm", target: "peer", value: WORKER_ID },
      ]),
    );
  });

  it("serializes concurrent same-plan starts so only one worker is created", async () => {
    const fake = harness();

    const results = await Promise.all([
      startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps),
      startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: true, reusedExisting: false }),
      expect.objectContaining({ ok: true, reusedExisting: true }),
    ]);
    expect(
      fake.operations.filter(
        (operation) =>
          operation.kind === "run" && operation.value === DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
      ),
    ).toHaveLength(1);
    expect(fake.getMaxLifecycleLockActive()).toBe(1);
  });

  it("holds the lifecycle lease after start until validation commits", async () => {
    const fake = harness();
    let releaseValidation: () => void = () => undefined;
    let reportStarted: () => void = () => undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const first = withDualStationManagedVllmLifecycle(async () => {
      const result = await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps);
      reportStarted();
      await validationGate;
      return result;
    }, fake.deps);
    await started;

    const second = startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps);
    await Promise.resolve();
    expect(
      fake.operations.filter(
        (operation) =>
          operation.kind === "run" && operation.value === DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
      ),
    ).toHaveLength(1);

    releaseValidation();
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ ok: true, reusedExisting: false }),
      expect.objectContaining({ ok: true, reusedExisting: true }),
    ]);
    expect(fake.getMaxLifecycleLockActive()).toBe(1);
  });

  it("reconciles a late worker create and rolls back only its transaction", async () => {
    const fake = harness({ lateCreateRole: "worker" });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker container failed to start",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toContainEqual({
      kind: "rm",
      target: "peer",
      value: WORKER_ID,
    });
  });

  it("never rolls back an ambiguous worker labeled by another transaction", async () => {
    const fake = harness({ failedRoleForeignTransaction: "worker" });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker container failed to start",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).not.toContainEqual({
      kind: "rm",
      target: "peer",
      value: WORKER_ID,
    });
    expect(fake.containers.get(`peer:${DUAL_STATION_VLLM_WORKER_CONTAINER_NAME}`)).toHaveLength(1);
  });

  it("migrates only the exact legacy single-Station head when the peer name is absent", async () => {
    const fake = harness();
    fake.seed(
      "local",
      fakeContainer("head", {
        labels: { [DUAL_STATION_VLLM_MANAGED_LABEL]: "true" },
      }),
    );

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toMatchObject(
      {
        ok: true,
        reusedExisting: false,
      },
    );
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toContainEqual({
      kind: "rm",
      target: "local",
      value: HEAD_ID,
    });
  });

  it("refuses a same-image worker that belongs to another physical cluster plan", () => {
    const fake = harness();
    const unrelatedWorker = fakeContainer("worker");
    unrelatedWorker.labels[DUAL_STATION_VLLM_CLUSTER_LABEL] = "f".repeat(64);
    fake.seed("peer", unrelatedWorker);

    expect(preflightDualStationManagedVllm(fixturePlan(), fake.deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("foreign"),
    });
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it("fails before mutation when an exact name has foreign ownership", async () => {
    const fake = harness();
    fake.seed(
      "local",
      fakeContainer("head", {
        labels: {
          [DUAL_STATION_VLLM_MANAGED_LABEL]: "false",
          [DUAL_STATION_VLLM_ROLE_LABEL]: "head",
          [DUAL_STATION_VLLM_ENDPOINT_LABEL]: "http://192.168.240.1:8000",
        },
      }),
    );

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toMatchObject(
      {
        ok: false,
        reason: expect.stringContaining("foreign"),
      },
    );
    expect(fake.operations.some((operation) => operation.kind === "run")).toBe(false);
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it("rolls back the exact worker ID when the head fails", async () => {
    const fake = harness({ failRole: "head" });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "head container failed to start",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
      { kind: "rm", target: "local", value: HEAD_SMOKE_ID },
      { kind: "rm", target: "peer", value: WORKER_ID },
    ]);
  });

  it("rejects an invalid docker-run ID and recovers only its exact owned ID", async () => {
    const fake = harness({ invalidIdRole: "worker" });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker container failed to start",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
      { kind: "rm", target: "local", value: HEAD_SMOKE_ID },
      { kind: "rm", target: "peer", value: WORKER_ID },
    ]);
  });

  it("cleans up exact owned IDs head-first and reports both-running state", async () => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));
    fake.seed("peer", fakeContainer("worker"));

    expect(areDualStationManagedVllmContainersRunning(fixturePlan(), fake.deps)).toBe(true);
    expect(await cleanupDualStationManagedVllm(fixturePlan(), fake.deps)).toEqual({
      ok: true,
      removedContainerIds: [HEAD_ID, WORKER_ID],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "local", value: HEAD_ID },
      { kind: "rm", target: "peer", value: WORKER_ID },
    ]);
    expect(areDualStationManagedVllmContainersRunning(fixturePlan(), fake.deps)).toBe(false);
  });

  it("refuses all cleanup when either exact name is ambiguous", async () => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));
    fake.seed("local", fakeContainer("head", { id: "c".repeat(64) }));
    fake.seed("peer", fakeContainer("worker"));

    expect(await cleanupDualStationManagedVllm(fixturePlan(), fake.deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ambiguous"),
    });
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });
});

describe("managed dual-Station base URL recovery", () => {
  it("returns only a running, owned RFC1918 head endpoint with a bounded inspect", () => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));

    expect(getDualStationManagedVllmBaseUrl(fake.deps)).toBe("http://192.168.240.1:8000");
    expect(
      fake.operations.some(
        (operation) =>
          operation.kind === "capture" &&
          operation.target === "local" &&
          operation.value === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
      ),
    ).toBe(true);
    expect(fake.captureOptions.at(-1)).toMatchObject({ timeout: 10_000 });
    expect(fake.captureOptions.at(-1)?.env?.VLLM_API_KEY).toBeUndefined();
  });

  it.each([
    ["missing persisted key", { loadApiKey: () => null }],
    ["mismatched persisted key", { loadApiKey: () => "a".repeat(64) }],
    ["endpoint absent from local interfaces", { localInterfaceAddresses: () => [] }],
  ])("rejects day-2 recovery with %s", (_case, overrides) => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));

    expect(getDualStationManagedVllmBaseUrl({ ...fake.deps, ...overrides })).toBeNull();
  });

  it.each([
    "http://8.8.8.8:8000",
    "http://0.0.0.0:8000",
    "http://192.168.240.1:8000/",
  ])("rejects unsafe or non-canonical endpoint label %s", (endpoint) => {
    const fake = harness();
    fake.seed(
      "local",
      fakeContainer("head", {
        labels: {
          [DUAL_STATION_VLLM_MANAGED_LABEL]: "true",
          [DUAL_STATION_VLLM_ROLE_LABEL]: "head",
          [DUAL_STATION_VLLM_ENDPOINT_LABEL]: endpoint,
        },
      }),
    );

    expect(getDualStationManagedVllmBaseUrl(fake.deps)).toBeNull();
  });

  it("rejects an owned-looking head that does not use the pinned runtime image", () => {
    const fake = harness();
    fake.seed(
      "local",
      fakeContainer("head", {
        image:
          "nvcr.io/nvidia/vllm:forged@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );

    expect(getDualStationManagedVllmBaseUrl(fake.deps)).toBeNull();
  });
});
