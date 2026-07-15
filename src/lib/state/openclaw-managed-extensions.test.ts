// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isAllowedStateSymlink,
  OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS,
  shouldPreserveOpenClawManagedExtensions,
} from "./openclaw-managed-extensions";

const EXPECTED_MANAGED_EXTENSIONS = [
  "nemoclaw",
  "diagnostics-otel",
  "brave",
  "discord",
  "openclaw-weixin",
  "slack",
  "whatsapp",
  "msteams",
] as const;

describe("OpenClaw managed extension policy", () => {
  it("tracks every image-managed extension with a unique safe directory name", () => {
    expect(OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS).toEqual(EXPECTED_MANAGED_EXTENSIONS);
    expect(new Set(OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS).size).toBe(
      OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS.length,
    );
    expect(OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS).toSatisfy((names: readonly string[]) =>
      names.every((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)),
    );
  });

  it("preserves managed extensions only for an OpenClaw extension restore", () => {
    expect(
      shouldPreserveOpenClawManagedExtensions({ agentType: "openclaw" }, "/sandbox/custom-state", [
        "workspace",
        "extensions",
      ]),
    ).toBe(true);
    expect(
      shouldPreserveOpenClawManagedExtensions({ agentType: "custom" }, "/sandbox/.openclaw/", [
        "extensions",
      ]),
    ).toBe(true);
    expect(
      shouldPreserveOpenClawManagedExtensions({ agentType: "openclaw" }, "/sandbox/.openclaw", [
        "workspace",
      ]),
    ).toBe(false);
    expect(
      shouldPreserveOpenClawManagedExtensions({ agentType: "custom" }, "/sandbox/custom-state", [
        "extensions",
      ]),
    ).toBe(false);
  });
});

describe("OpenClaw managed extension symlink policy", () => {
  it("allows exact image links and extension-local npm executable links", () => {
    expect(
      isAllowedStateSymlink(
        "extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal",
        "../qrcode-terminal/bin/qrcode-terminal.js",
      ),
    ).toBe(true);
    expect(
      isAllowedStateSymlink(
        "extensions/slack/node_modules/openclaw",
        "/usr/local/lib/node_modules/openclaw",
      ),
    ).toBe(true);
    expect(
      isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/json5", "../json5/lib/cli.js"),
    ).toBe(true);
  });

  it("rejects tampered, absolute, empty, and escaping npm link targets", () => {
    expect(
      isAllowedStateSymlink(
        "extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal",
        "/etc/passwd",
      ),
    ).toBe(false);
    expect(isAllowedStateSymlink("extensions/slack/node_modules/openclaw", "/etc/passwd")).toBe(
      false,
    );
    expect(
      isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/json5", "/usr/bin/json5"),
    ).toBe(false);
    expect(isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/json5", "")).toBe(false);
    expect(
      isAllowedStateSymlink(
        "extensions/nemoclaw/node_modules/.bin/leak",
        "../../../../openclaw.json",
      ),
    ).toBe(false);
    expect(isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/leak", "../..")).toBe(
      false,
    );
    expect(
      isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/loop", "../.bin/other"),
    ).toBe(false);
  });

  it("rejects allowed targets outside the narrowly recognized source paths", () => {
    expect(
      isAllowedStateSymlink("workspace/openclaw", "/usr/local/lib/node_modules/openclaw"),
    ).toBe(false);
    expect(isAllowedStateSymlink("extensions/nemoclaw/bin/json5", "../json5/lib/cli.js")).toBe(
      false,
    );
  });

  it.each([
    ["extensions/../nemoclaw/node_modules/.bin/json5", "../json5/lib/cli.js"],
    ["extensions/nemoclaw/node_modules/.bin/../json5", "../json5/lib/cli.js"],
    ["extensions\\..\\slack\\node_modules\\openclaw", "/usr/local/lib/node_modules/openclaw"],
    ["extensions/nemoclaw/node_modules/.bin/json5", "../json5/../../../openclaw.json"],
    ["extensions/%2e%2e/node_modules/.bin/json5", "../json5/lib/cli.js"],
    ["extensions/nemoclaw/node_modules/.bin/json5", "%2e%2e/%2e%2e/etc/passwd"],
    ["extensions/nemoclaw/node_modules/.bin/json5", "/proc/self/exe"],
    ["extensions/nemoclaw/node_modules/.bin/json5", "/host/etc/passwd"],
  ])("rejects source and target traversal vectors: %s -> %s", (source, target) => {
    expect(isAllowedStateSymlink(source, target)).toBe(false);
  });
});
