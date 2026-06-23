// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = path.join(import.meta.dirname, "..");

type PolicyRule = {
  allow?: {
    method?: string;
    path?: string;
  };
};

type PolicyEndpoint = {
  host?: string;
  rules?: PolicyRule[];
};

type PolicyDocument = {
  network_policies?: Record<
    string,
    {
      endpoints?: PolicyEndpoint[];
    }
  >;
};

function parseRepoYaml(relativePath: string): PolicyDocument {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8")) as PolicyDocument;
}

describe("WeCom policy presets", () => {
  it("do not allow the Agent gettoken exchange", () => {
    const policySources = [
      "nemoclaw-blueprint/policies/presets/wecom.yaml",
      "agents/hermes/policy-additions.yaml",
    ];

    for (const relativePath of policySources) {
      const parsed = parseRepoYaml(relativePath);
      const qyapiRules = Object.values(parsed.network_policies ?? {})
        .flatMap((policy) => policy.endpoints ?? [])
        .filter((endpoint) => endpoint.host === "qyapi.weixin.qq.com")
        .flatMap((endpoint) => endpoint.rules ?? [])
        .map((rule) => rule.allow)
        .filter((rule): rule is { method: string; path: string } =>
          Boolean(rule?.method && rule?.path),
        );

      expect(qyapiRules).not.toContainEqual({ method: "GET", path: "/cgi-bin/gettoken" });
    }
  });
});
