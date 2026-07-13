// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { wechatManifest } from "../src/lib/messaging/channels/wechat/manifest.ts";
import {
  applyMessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";

const WECHAT_INTEGRITY =
  "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==";
const WECHAT_TARBALL =
  "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz";

function executable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

describe("locked WeChat plugin installation (#5896)", () => {
  it("installs from the reviewed archive using only the dedicated offline graph", () => {
    const runtimeLock = wechatManifest.agentPackages[0].runtimeLock;
    expect(runtimeLock).toEqual({
      cachePath: "/usr/local/share/nemoclaw/wechat-npm-cache",
      legacyPeerDeps: true,
      lockFile: "/usr/local/lib/nemoclaw/wechat-runtime/package-lock.json",
      offline: true,
      projectsRoot: "/sandbox/.openclaw/npm/projects",
      verifierPath: "/usr/local/lib/nemoclaw/verify-wechat-runtime-lock.mts",
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-install-"));
    const trace = path.join(tmp, "trace");
    executable(
      path.join(tmp, "npm"),
      `#!/bin/sh
set -eu
if [ "$1" = view ] && [ "$3" = dist.integrity ]; then printf '%s\n' "$WECHAT_INTEGRITY"; exit 0; fi
if [ "$1" = view ] && [ "$3" = dist.tarball ]; then printf '%s\n' "$WECHAT_TARBALL"; exit 0; fi
if [ "$1" = pack ]; then
  printf 'archive' > "$4/wechat.tgz"
  printf '[{"filename":"wechat.tgz","integrity":"%s"}]\n' "$WECHAT_INTEGRITY"
  exit 0
fi
exit 1
`,
    );
    executable(
      path.join(tmp, "openclaw"),
      `#!/bin/sh
printf 'install|%s|offline=%s|peer=%s|cache=%s\n' "$3" "$NPM_CONFIG_OFFLINE" "$NPM_CONFIG_LEGACY_PEER_DEPS" "$NPM_CONFIG_CACHE" >> "$TRACE"
`,
    );
    executable(
      path.join(tmp, "node"),
      `#!/bin/sh
printf 'verify|%s|%s|offline=%s|cache=%s\n' "$3" "$4" "$NPM_CONFIG_OFFLINE" "$NPM_CONFIG_CACHE" >> "$TRACE"
`,
    );

    const plan = {
      schemaVersion: 1,
      sandboxName: "wechat-test",
      agent: "openclaw",
      channels: [{ channelId: "wechat", active: true }],
      credentialBindings: [],
      agentRender: [],
      buildSteps: [
        {
          channelId: "wechat",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
          },
        },
      ],
    };
    const env = {
      PATH: `${tmp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TRACE: trace,
      WECHAT_INTEGRITY,
      WECHAT_TARBALL,
      NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
    };

    try {
      const serialized = readMessagingBuildPlanFromEnv(env, "openclaw");
      expect(applyMessagingBuildPhase(serialized, "agent-install", env)).toEqual([]);
      const calls = fs.readFileSync(trace, "utf8");
      expect(calls).toContain("install|npm-pack:");
      expect(calls).toContain(
        "offline=true|peer=true|cache=/usr/local/share/nemoclaw/wechat-npm-cache",
      );
      expect(calls).toContain(
        "verify|/usr/local/lib/nemoclaw/wechat-runtime/package-lock.json|/sandbox/.openclaw/npm/projects|offline=true",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
