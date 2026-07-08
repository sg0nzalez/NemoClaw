// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { failLine } from "../cli/terminal-style";
import { shellQuote } from "../core/shell-quote";
import { printRemediationActions } from "./remediation";

type PackageManager = "apt" | "dnf" | "yum" | "brew" | "pacman" | "unknown";

type RunCapture = (args: readonly string[], opts?: { ignoreError?: boolean }) => string;
type RunCaptureEx = typeof import("../runner").runCaptureEx;
type RunInteractive = (
  args: readonly string[],
  opts?: { ignoreError?: boolean; suppressOutput?: boolean },
) => { status: number | null; error?: Error };

export interface PodmanRuntimeAssessment {
  installed: boolean;
  reachable: boolean;
  rootless: boolean | null;
  cgroupVersion: "v1" | "v2" | "unknown";
  packageManager: PackageManager;
  platform: NodeJS.Platform | string;
  socketPath: string;
  socketExists: boolean;
  socketReachable: boolean;
  subuidConfigured: boolean | null;
  subgidConfigured: boolean | null;
  invalidSubuidRanges?: string[];
  invalidSubgidRanges?: string[];
  recommendedSubidRange?: string | null;
  systemctlAvailable: boolean;
  userName: string | null;
  infoSummary: string | null;
  detail: string | null;
}

export interface AssessPodmanRuntimeOptions {
  detectCgroupVersionImpl?: () => "v1" | "v2" | "unknown";
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFileImpl?: (filePath: string, encoding: BufferEncoding) => string;
  runCaptureExImpl?: RunCaptureEx;
  runCaptureImpl?: RunCapture;
  gid?: number;
  socketExistsImpl?: (socketPath: string) => boolean;
  uid?: number;
  userName?: string | null;
}

const { runCapture, runCaptureEx, runInteractive } =
  require("../runner") as typeof import("../runner");

function commandExists(commandName: string, runCaptureImpl: RunCapture): boolean {
  try {
    return Boolean(
      runCaptureImpl(["sh", "-c", 'command -v "$1"', "--", commandName], {
        ignoreError: true,
      }).trim(),
    );
  } catch {
    return false;
  }
}

function detectPackageManager(runCaptureImpl: RunCapture): PackageManager {
  if (commandExists("apt-get", runCaptureImpl)) return "apt";
  if (commandExists("dnf", runCaptureImpl)) return "dnf";
  if (commandExists("yum", runCaptureImpl)) return "yum";
  if (commandExists("brew", runCaptureImpl)) return "brew";
  if (commandExists("pacman", runCaptureImpl)) return "pacman";
  return "unknown";
}

function normalizeSocketPath(value: string): string {
  return value.trim().replace(/^unix:\/\//, "");
}

export function resolvePodmanSocketPath({
  env = process.env,
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
}: Pick<AssessPodmanRuntimeOptions, "env" | "platform" | "uid"> = {}): string {
  const explicit = env.OPENSHELL_PODMAN_SOCKET || env.NEMOCLAW_PODMAN_SOCKET;
  if (explicit?.trim()) return normalizeSocketPath(explicit);
  if (platform === "darwin") {
    return path.join(os.homedir(), ".local/share/containers/podman/machine/podman.sock");
  }
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim() || `/run/user/${uid}`;
  return path.join(runtimeDir, "podman/podman.sock");
}

function parsePodmanRootless(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function parsePodmanCgroupVersion(raw: string): "v1" | "v2" | "unknown" {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "v2" || normalized === "2") return "v2";
  if (normalized === "v1" || normalized === "1") return "v1";
  return "unknown";
}

function unescapeMountPath(value: string): string {
  return value.replace(/\\040/g, " ");
}

function detectHostCgroupVersion(): "v1" | "v2" | "unknown" {
  try {
    const mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf-8");
    for (const line of mountInfo.split("\n")) {
      const separator = line.indexOf(" - ");
      if (separator < 0) continue;
      const mountFields = line.slice(0, separator).split(" ");
      const fsFields = line.slice(separator + 3).split(" ");
      const mountPoint = unescapeMountPath(mountFields[4] ?? "");
      const fsType = fsFields[0] ?? "";
      if (mountPoint !== "/sys/fs/cgroup") continue;
      if (fsType === "cgroup2") return "v2";
      if (fsType === "cgroup") return "v1";
    }
  } catch {
    // Fall through to the file-system feature probe below.
  }
  try {
    if (fs.existsSync("/sys/fs/cgroup/cgroup.controllers")) return "v2";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function detectUserName(
  env: NodeJS.ProcessEnv,
  runCaptureImpl: RunCapture,
  explicit: string | null | undefined,
): string | null {
  const candidate = explicit ?? env.USER ?? env.LOGNAME ?? "";
  if (candidate.trim()) return candidate.trim();
  try {
    const idUser = runCaptureImpl(["id", "-un"], { ignoreError: true }).trim();
    return idUser || null;
  } catch {
    return null;
  }
}

const SUBID_BLOCK_SIZE = 65_536;
const SUBID_MIN_START = 100_000;
const SUBID_MAX_START = 2_000_000_000;

interface SubidRange {
  owner: string;
  start: number;
  count: number;
  end: number;
}

interface SubidFileAssessment {
  configured: boolean;
  invalidRanges: string[];
  ranges: SubidRange[];
}

function parseSubidRanges(contents: string): SubidRange[] {
  const ranges: SubidRange[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [owner, startRaw, countRaw] = trimmed.split(":");
    const start = Number.parseInt(startRaw ?? "", 10);
    const count = Number.parseInt(countRaw ?? "", 10);
    if (!owner || !Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;
    ranges.push({
      owner,
      start,
      count,
      end: start + count - 1,
    });
  }
  return ranges;
}

function subidOwners(userName: string | null, uid: number | undefined): Set<string> {
  const names = new Set([userName, typeof uid === "number" ? String(uid) : null].filter(Boolean));
  return names as Set<string>;
}

function rangeSpec(range: Pick<SubidRange, "start" | "end">): string {
  return `${range.start}-${range.end}`;
}

function rangesOverlap(
  first: Pick<SubidRange, "start" | "end">,
  second: Pick<SubidRange, "start" | "end">,
): boolean {
  return first.start <= second.end && second.start <= first.end;
}

function rangeIncludesId(
  range: Pick<SubidRange, "start" | "end">,
  id: number | undefined,
): boolean {
  return typeof id === "number" && id >= range.start && id <= range.end;
}

function assessSubidRanges(
  ranges: SubidRange[],
  userName: string | null,
  primaryId: number | undefined,
): SubidFileAssessment {
  const owners = subidOwners(userName, primaryId);
  if (owners.size === 0) return { configured: false, invalidRanges: [], ranges };

  const userRanges = ranges.filter((range) => owners.has(range.owner));
  const invalidRanges = userRanges
    .filter(
      (range) =>
        rangeIncludesId(range, primaryId) ||
        ranges.some((other) => other.owner !== range.owner && rangesOverlap(range, other)),
    )
    .map(rangeSpec);
  const invalidRangeSet = new Set(invalidRanges);
  const configured = userRanges.some(
    (range) => range.count >= SUBID_BLOCK_SIZE && !invalidRangeSet.has(rangeSpec(range)),
  );
  return { configured, invalidRanges, ranges };
}

function readSubidAssessment(
  filePath: string,
  readFileImpl: (filePath: string, encoding: BufferEncoding) => string,
  userName: string | null,
  primaryId: number | undefined,
): SubidFileAssessment {
  try {
    return assessSubidRanges(
      parseSubidRanges(readFileImpl(filePath, "utf-8")),
      userName,
      primaryId,
    );
  } catch {
    return { configured: false, invalidRanges: [], ranges: [] };
  }
}

function findRecommendedSubidRange(
  ranges: SubidRange[],
  uid: number | undefined,
  gid: number | undefined,
): string | null {
  for (let start = SUBID_MIN_START; start <= SUBID_MAX_START; start += SUBID_BLOCK_SIZE) {
    const candidate = { start, end: start + SUBID_BLOCK_SIZE - 1 };
    if (rangeIncludesId(candidate, uid) || rangeIncludesId(candidate, gid)) continue;
    if (ranges.some((range) => rangesOverlap(candidate, range))) continue;
    return rangeSpec(candidate);
  }
  return null;
}

function podmanInfoSummary(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as {
      version?: { Version?: string; version?: string };
      host?: { os?: string; arch?: string };
    };
    const version = parsed.version?.Version || parsed.version?.version;
    const osName = parsed.host?.os;
    const arch = parsed.host?.arch;
    return [version, osName, arch].filter(Boolean).join(" · ") || null;
  } catch {
    return text.split("\n", 1)[0]?.slice(0, 120) || null;
  }
}

interface PodmanInfoFieldResult {
  output: string;
  detail: string | null;
}

function outputTail(output: string, maxLines = 4): string {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines)
    .join("\n");
}

function readPodmanInfoField(
  runCaptureImpl: RunCapture,
  runCaptureExImpl: RunCaptureEx | null,
  format: string,
): PodmanInfoFieldResult {
  return readPodmanInfoCommand(
    runCaptureImpl,
    runCaptureExImpl,
    ["podman", "info", "--format", format],
    "podman info",
  );
}

function readPodmanInfoCommand(
  runCaptureImpl: RunCapture,
  runCaptureExImpl: RunCaptureEx | null,
  argv: readonly string[],
  label: string,
): PodmanInfoFieldResult {
  if (runCaptureExImpl) {
    try {
      const result = runCaptureExImpl(argv);
      const output = result.stdout.trim();
      const diagnostics = outputTail(
        [result.stderr ?? "", result.stdout].filter(Boolean).join("\n"),
      );
      if (result.timedOut) {
        return {
          output,
          detail: `${label} timed out${diagnostics ? `: ${diagnostics}` : ""}`,
        };
      }
      if (result.exitCode !== 0) {
        return {
          output,
          detail: `${label} failed (exit ${result.exitCode ?? "unknown"})${
            diagnostics ? `: ${diagnostics}` : ""
          }`,
        };
      }
      return {
        output,
        detail: output ? null : `${label} returned no runtime metadata`,
      };
    } catch (err) {
      return {
        output: "",
        detail: `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const output = runCaptureImpl(argv, { ignoreError: true }).trim();
    return {
      output,
      detail: output ? null : `${label} returned no runtime metadata`,
    };
  } catch (err) {
    return {
      output: "",
      detail: `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function readPodmanSocketInfo(
  runCaptureImpl: RunCapture,
  runCaptureExImpl: RunCaptureEx | null,
  socketPath: string,
): PodmanInfoFieldResult {
  return readPodmanInfoCommand(
    runCaptureImpl,
    runCaptureExImpl,
    ["podman", "--url", `unix://${socketPath}`, "info", "--format", "{{json .}}"],
    `podman --url unix://${socketPath} info`,
  );
}

function combineDetails(details: Array<string | null | undefined>): string | null {
  const unique = [...new Set(details.map((detail) => detail?.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.join("\n") : null;
}

export function assessPodmanRuntime(
  opts: AssessPodmanRuntimeOptions = {},
): PodmanRuntimeAssessment {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const runCaptureImpl = opts.runCaptureImpl ?? runCapture;
  const runCaptureExImpl = opts.runCaptureExImpl ?? (opts.runCaptureImpl ? null : runCaptureEx);
  const readFileImpl = opts.readFileImpl ?? fs.readFileSync;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const gid = opts.gid ?? (typeof process.getgid === "function" ? process.getgid() : undefined);
  const installed = commandExists("podman", runCaptureImpl);
  const packageManager = detectPackageManager(runCaptureImpl);
  const systemctlAvailable = commandExists("systemctl", runCaptureImpl);
  const userName = detectUserName(env, runCaptureImpl, opts.userName);
  const socketPath = resolvePodmanSocketPath({ env, platform, uid });
  const socketExists = (opts.socketExistsImpl ?? fs.existsSync)(socketPath);
  const shouldCheckSubids = platform === "linux";
  const subuidAssessment = shouldCheckSubids
    ? readSubidAssessment("/etc/subuid", readFileImpl, userName, uid)
    : null;
  const subgidAssessment = shouldCheckSubids
    ? readSubidAssessment("/etc/subgid", readFileImpl, userName, gid)
    : null;
  const subuidConfigured = subuidAssessment?.configured ?? null;
  const subgidConfigured = subgidAssessment?.configured ?? null;
  const recommendedSubidRange = shouldCheckSubids
    ? findRecommendedSubidRange(
        [...(subuidAssessment?.ranges ?? []), ...(subgidAssessment?.ranges ?? [])],
        uid,
        gid,
      )
    : null;
  if (!installed) {
    return {
      installed,
      reachable: false,
      rootless: null,
      cgroupVersion: "unknown",
      packageManager,
      platform,
      socketPath,
      socketExists,
      socketReachable: false,
      subuidConfigured,
      subgidConfigured,
      invalidSubuidRanges: subuidAssessment?.invalidRanges ?? [],
      invalidSubgidRanges: subgidAssessment?.invalidRanges ?? [],
      recommendedSubidRange,
      systemctlAvailable,
      userName,
      infoSummary: null,
      detail: "podman command was not found",
    };
  }

  const infoProbe = readPodmanInfoField(runCaptureImpl, runCaptureExImpl, "{{json .}}");
  const infoOutput = infoProbe.output;
  const socketProbe = socketExists
    ? readPodmanSocketInfo(runCaptureImpl, runCaptureExImpl, socketPath)
    : { output: "", detail: `Podman API socket was not found at ${socketPath}` };
  const rootless = parsePodmanRootless(
    readPodmanInfoField(runCaptureImpl, runCaptureExImpl, "{{.Host.Security.Rootless}}").output,
  );
  let cgroupVersion = parsePodmanCgroupVersion(
    readPodmanInfoField(runCaptureImpl, runCaptureExImpl, "{{.Host.CgroupVersion}}").output,
  );
  if (platform === "linux" && cgroupVersion === "unknown") {
    cgroupVersion = (opts.detectCgroupVersionImpl ?? detectHostCgroupVersion)();
  }
  const reachable = Boolean(infoOutput.trim());
  const socketReachable = socketExists && Boolean(socketProbe.output.trim());

  return {
    installed,
    reachable,
    rootless,
    cgroupVersion,
    packageManager,
    platform,
    socketPath,
    socketExists,
    socketReachable,
    subuidConfigured,
    subgidConfigured,
    invalidSubuidRanges: subuidAssessment?.invalidRanges ?? [],
    invalidSubgidRanges: subgidAssessment?.invalidRanges ?? [],
    recommendedSubidRange,
    systemctlAvailable,
    userName,
    infoSummary: podmanInfoSummary(infoOutput),
    detail:
      reachable && socketReachable
        ? null
        : combineDetails([
            reachable ? null : (infoProbe.detail ?? "podman info did not return runtime metadata"),
            socketReachable ? null : socketProbe.detail,
          ]),
  };
}

type PodmanSetupCommand = {
  argv: readonly string[];
  ignoreError?: boolean;
};

export interface PodmanRemediationAction {
  id: string;
  title: string;
  kind: "info" | "manual" | "auto" | "sudo";
  reason: string;
  commands: string[];
  blocking: boolean;
  setupCommands?: PodmanSetupCommand[];
}

function renderArgv(argv: readonly string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg)))
    .join(" ");
}

function parseRangeSpecToStartCount(range: string | null | undefined): {
  start: number;
  count: number;
} | null {
  const match = /^(\d+)-(\d+)$/.exec(String(range || ""));
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return {
    start,
    count: end - start + 1,
  };
}

function escapeBasicRegex(value: string): string {
  return value.replace(/[[\]\\/.*^$]/g, "\\$&");
}

function buildSubidPatchSetupCommand(
  userName: string | null,
  range: string | null | undefined,
): PodmanSetupCommand | null {
  if (!userName) return null;
  const parsed = parseRangeSpecToStartCount(range);
  if (!parsed) return null;
  const script = [
    "set -eu",
    "user=$1",
    "start=$2",
    "count=$3",
    "update_file() {",
    "  file=$1",
    '  touch "$file"',
    '  cp -p "$file" "$file.bak-$(date +%s)"',
    "  tmp=$(mktemp)",
    '  awk -F: -v user="$user" \'$1 != user { print }\' "$file" > "$tmp"',
    '  printf \'%s:%s:%s\\n\' "$user" "$start" "$count" >> "$tmp"',
    '  cat "$tmp" > "$file"',
    '  rm -f "$tmp"',
    "}",
    "update_file /etc/subuid",
    "update_file /etc/subgid",
  ].join("\n");
  return {
    argv: [
      "sudo",
      "sh",
      "-c",
      script,
      "nemoclaw-subids",
      userName,
      String(parsed.start),
      String(parsed.count),
    ],
  };
}

function buildSubidPatchDisplayCommands(userName: string, range: string): string[] {
  const parsed = parseRangeSpecToStartCount(range);
  if (!parsed) return [];
  const entry = `${userName}:${parsed.start}:${parsed.count}`;
  const sedExpression = `/^${escapeBasicRegex(userName)}:/d`;
  return [
    "sudo cp -p /etc/subuid /etc/subuid.bak-$(date +%s)",
    "sudo cp -p /etc/subgid /etc/subgid.bak-$(date +%s)",
    `sudo sed -i ${shellQuote(sedExpression)} /etc/subuid /etc/subgid`,
    `printf ${shellQuote(`${entry}\n`)} | sudo tee -a /etc/subuid >/dev/null`,
    `printf ${shellQuote(`${entry}\n`)} | sudo tee -a /etc/subgid >/dev/null`,
  ];
}

function installPodmanCommands(packageManager: PackageManager): PodmanSetupCommand[] {
  switch (packageManager) {
    case "apt":
      return [
        { argv: ["sudo", "apt-get", "update"] },
        { argv: ["sudo", "apt-get", "install", "-y", "podman"] },
      ];
    case "dnf":
      return [{ argv: ["sudo", "dnf", "install", "-y", "podman"] }];
    case "yum":
      return [{ argv: ["sudo", "yum", "install", "-y", "podman"] }];
    case "pacman":
      return [{ argv: ["sudo", "pacman", "-S", "--noconfirm", "podman"] }];
    case "brew":
      return [{ argv: ["brew", "install", "podman"] }];
    case "unknown":
      return [];
  }
}

export function planPodmanRuntimeRemediation(
  assessment: PodmanRuntimeAssessment,
): PodmanRemediationAction[] {
  const actions: PodmanRemediationAction[] = [];

  if (!assessment.installed) {
    const setupCommands = installPodmanCommands(assessment.packageManager);
    actions.push({
      id: "install_podman",
      title: "Install Podman",
      kind: setupCommands.length > 0 ? "sudo" : "manual",
      reason: "Podman is required when NEMOCLAW_GATEWAY_RUNTIME=podman.",
      commands:
        setupCommands.length > 0
          ? setupCommands.map((command) => renderArgv(command.argv))
          : ["Install Podman with your OS package manager, then rerun `nemoclaw onboard`."],
      blocking: true,
      setupCommands: setupCommands.length > 0 ? setupCommands : undefined,
    });
  }

  if (assessment.platform === "linux" && assessment.cgroupVersion !== "v2") {
    actions.push({
      id: "enable_cgroups_v2",
      title: "Enable cgroups v2",
      kind: "manual",
      reason:
        "Rootless Podman needs cgroups v2 so OpenShell can enforce sandbox resource limits without a root daemon.",
      commands: [
        "Enable unified cgroups v2 for this host, reboot, verify `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`, then rerun `nemoclaw onboard`.",
      ],
      blocking: true,
    });
  }

  if (
    assessment.platform === "linux" &&
    assessment.installed &&
    (!assessment.reachable || !assessment.socketExists || !assessment.socketReachable)
  ) {
    const setupCommands: PodmanSetupCommand[] = assessment.systemctlAvailable
      ? assessment.socketExists && !assessment.socketReachable
        ? [{ argv: ["systemctl", "--user", "restart", "podman.socket"] }]
        : [{ argv: ["systemctl", "--user", "enable", "--now", "podman.socket"] }]
      : [];
    const verificationCommand = `podman --url unix://${assessment.socketPath} info`;
    actions.push({
      id: "enable_podman_socket",
      title:
        assessment.socketExists && !assessment.socketReachable
          ? "Restart the rootless Podman API socket"
          : "Start the rootless Podman API socket",
      kind: setupCommands.length > 0 ? "auto" : "manual",
      reason:
        "OpenShell's Podman driver needs the current user's Podman API socket to accept Podman REST API requests.",
      commands:
        setupCommands.length > 0
          ? [...setupCommands.map((command) => renderArgv(command.argv)), verificationCommand]
          : [
              "Start the rootless Podman API socket for your user, verify it with `podman --url unix://$OPENSHELL_PODMAN_SOCKET info`, then rerun `nemoclaw onboard`.",
            ],
      blocking: true,
      setupCommands: setupCommands.length > 0 ? setupCommands : undefined,
    });
  }

  if (assessment.rootless === false) {
    actions.push({
      id: "use_rootless_podman",
      title: "Use rootless Podman",
      kind: "manual",
      reason: "NemoClaw's Podman gateway runtime requires the user-scoped rootless Podman service.",
      commands: [
        "Stop using the rootful Podman socket for NemoClaw.",
        "Run `systemctl --user enable --now podman.socket`, then set OPENSHELL_PODMAN_SOCKET to the user socket if needed.",
      ],
      blocking: true,
    });
  }

  if (
    assessment.platform === "linux" &&
    (assessment.subuidConfigured === false || assessment.subgidConfigured === false)
  ) {
    const subidPatchCommand = buildSubidPatchSetupCommand(
      assessment.userName,
      assessment.recommendedSubidRange,
    );
    const setupCommands = subidPatchCommand
      ? [
          subidPatchCommand,
          { argv: ["podman", "system", "migrate"] },
          ...(assessment.systemctlAvailable
            ? [{ argv: ["systemctl", "--user", "restart", "podman.socket"] }]
            : []),
        ]
      : [];
    const invalidRangeSummary = [
      ...(assessment.invalidSubuidRanges ?? []).map((range) => `/etc/subuid:${range}`),
      ...(assessment.invalidSubgidRanges ?? []).map((range) => `/etc/subgid:${range}`),
    ].join(", ");
    const displayCommands =
      assessment.userName && assessment.recommendedSubidRange
        ? [
            ...buildSubidPatchDisplayCommands(
              assessment.userName,
              assessment.recommendedSubidRange,
            ),
            "podman system migrate",
            ...(assessment.systemctlAvailable ? ["systemctl --user restart podman.socket"] : []),
          ]
        : [];
    actions.push({
      id: "configure_podman_subids",
      title: "Configure rootless Podman subordinate UID/GID ranges",
      kind: setupCommands.length > 0 ? "sudo" : "manual",
      reason: invalidRangeSummary
        ? `Rootless containers need subordinate UID/GID mappings that do not include the current user's UID/GID or overlap another owner. Invalid current-user ranges: ${invalidRangeSummary}.`
        : "Rootless containers need subordinate UID/GID mappings so container root maps to unprivileged host IDs instead of host root.",
      commands:
        displayCommands.length > 0
          ? displayCommands
          : [
              "Add subordinate UID/GID ranges for the current user in /etc/subuid and /etc/subgid that do not include the user's UID/GID and do not overlap another owner, then rerun `nemoclaw onboard`.",
            ],
      blocking: true,
      setupCommands: setupCommands.length > 0 ? setupCommands : undefined,
    });
  }

  return actions;
}

function hasBlockingFailure(assessment: PodmanRuntimeAssessment): boolean {
  return (
    !assessment.installed ||
    !assessment.reachable ||
    assessment.rootless !== true ||
    (assessment.platform === "linux" && assessment.cgroupVersion !== "v2") ||
    !assessment.socketExists ||
    !assessment.socketReachable ||
    assessment.subuidConfigured === false ||
    assessment.subgidConfigured === false
  );
}

export async function ensurePodmanRuntimePrerequisitesForOnboard({
  autoYes = false,
  nonInteractive = false,
  confirm = async () => false,
  assessImpl = assessPodmanRuntime,
  runInteractiveImpl = runInteractive,
  exitProcess = (code: number): never => process.exit(code),
}: {
  autoYes?: boolean;
  nonInteractive?: boolean;
  confirm?: (question: string, defaultIsYes: boolean) => Promise<boolean>;
  assessImpl?: () => PodmanRuntimeAssessment;
  runInteractiveImpl?: RunInteractive;
  exitProcess?: (code: number) => never;
} = {}): Promise<PodmanRuntimeAssessment> {
  let assessment = assessImpl();
  if (!hasBlockingFailure(assessment)) return assessment;

  const actions = planPodmanRuntimeRemediation(assessment);
  printRemediationActions(actions);

  const setupCommands = actions.flatMap((action) => action.setupCommands ?? []);
  const hasManualBlockingAction = actions.some(
    (action) => action.blocking && !action.setupCommands?.length,
  );
  if (setupCommands.length === 0 || hasManualBlockingAction) {
    exitProcess(1);
  }

  if (!autoYes) {
    if (nonInteractive) {
      console.error("");
      console.error("  Re-run with --yes / -y to let onboarding apply Podman setup commands.");
      exitProcess(1);
    }
    const proceed = await confirm("  Apply the Podman setup commands now?", false);
    if (!proceed) {
      console.error(
        "  Podman setup was not applied. Apply the suggested fix and rerun onboarding.",
      );
      exitProcess(1);
    }
  }

  console.log("  Applying Podman gateway runtime prerequisites...");
  for (const command of setupCommands) {
    const result = runInteractiveImpl(command.argv, {
      ignoreError: true,
      suppressOutput: false,
    });
    const status = result.status ?? (result.error ? 1 : 0);
    if (status !== 0 && command.ignoreError !== true) {
      console.error("");
      console.error(failLine("Podman setup command failed."));
      console.error(`    Command: ${renderArgv(command.argv)}`);
      console.error(`    Exit status: ${status}`);
      console.error("    Fix the command above, then rerun onboarding.");
      exitProcess(status || 1);
    }
  }

  assessment = assessImpl();
  return assertPodmanRuntimeAvailable(assessment, exitProcess);
}

export function assertPodmanRuntimeAvailable(
  assessment: PodmanRuntimeAssessment = assessPodmanRuntime(),
  exitProcess: (code: number) => never = (code) => process.exit(code),
): PodmanRuntimeAssessment {
  const failures: string[] = [];
  if (!assessment.installed) failures.push("Podman is not installed or is not on PATH.");
  if (assessment.installed && !assessment.reachable) {
    failures.push("Podman is installed, but `podman info` is not reachable.");
  }
  if (assessment.rootless === false) {
    failures.push(
      "Podman is running rootful; NemoClaw's Podman gateway runtime requires rootless Podman.",
    );
  }
  if (assessment.rootless === null && assessment.reachable) {
    failures.push("Could not confirm that Podman is running rootless.");
  }
  if (assessment.cgroupVersion !== "v2" && process.platform === "linux") {
    failures.push("Rootless Podman requires cgroups v2 for the NemoClaw gateway runtime.");
  }
  if (!assessment.socketExists) {
    failures.push(`Podman API socket was not found at ${assessment.socketPath}.`);
  } else if (!assessment.socketReachable) {
    failures.push(`Podman API socket is not accepting requests at ${assessment.socketPath}.`);
  }
  if (assessment.subuidConfigured === false || assessment.subgidConfigured === false) {
    failures.push("Rootless Podman subordinate UID/GID ranges are missing for this user.");
  }

  if (failures.length > 0) {
    console.error(failLine("Podman gateway runtime preflight failed."));
    for (const failure of failures) console.error(`    ${failure}`);
    console.error("");
    printRemediationActions(planPodmanRuntimeRemediation(assessment));
    console.error("  Override the socket with OPENSHELL_PODMAN_SOCKET when needed.");
    if (assessment.detail) console.error(`  Detail: ${assessment.detail}`);
    exitProcess(1);
  }

  return assessment;
}
