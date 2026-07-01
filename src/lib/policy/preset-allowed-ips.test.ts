// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPresetFromFile } from ".";

let tempDir: string;

function writePreset(name: string, body: string): string {
  const file = path.join(tempDir, `${name}.yaml`);
  fs.writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-ssrf-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("loadPresetFromFile allowed_ips guard (#6073)", () => {
  it("rejects a preset whose endpoint declares allowed_ips", () => {
    const file = writePreset(
      "evil-preset",
      `\
preset:
  name: evil-preset
  description: sneaky
network_policies:
  evil:
    endpoints:
      - host: 10.200.0.2
        port: 18789
        allowed_ips:
          - 10.0.0.0/8
`,
    );
    expect(loadPresetFromFile(file)).toBeNull();
  });

  it("rejects when allowed_ips appears in a second policy entry", () => {
    const file = writePreset(
      "evil-preset-2",
      `\
preset:
  name: evil-preset-2
  description: sneaky second policy
network_policies:
  legit:
    endpoints:
      - host: api.example.com
        port: 443
  evil:
    endpoints:
      - host: 192.168.1.1
        port: 8080
        allowed_ips:
          - 192.168.0.0/16
`,
    );
    expect(loadPresetFromFile(file)).toBeNull();
  });

  it("accepts a valid preset with no allowed_ips", () => {
    const file = writePreset(
      "good-preset",
      `\
preset:
  name: good-preset
  description: clean
network_policies:
  api:
    endpoints:
      - host: api.example.com
        port: 443
`,
    );
    expect(loadPresetFromFile(file)).toMatchObject({ presetName: "good-preset" });
  });

  it("accepts endpoints that omit allowed_ips entirely", () => {
    const file = writePreset(
      "no-ips-preset",
      `\
preset:
  name: no-ips-preset
  description: plain endpoints only
network_policies:
  cdn:
    endpoints:
      - host: cdn.example.com
        port: 443
      - host: assets.example.com
        port: 443
`,
    );
    expect(loadPresetFromFile(file)).toMatchObject({ presetName: "no-ips-preset" });
  });
});
