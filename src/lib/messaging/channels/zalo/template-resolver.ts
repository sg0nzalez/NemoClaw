// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyString,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

const DEFAULT_PROXY_HOST = "10.200.0.1";
const DEFAULT_PROXY_PORT = "3128";
const DEFAULT_ZALO_GROUP_POLICY = "allowlist";
const ZALO_GROUP_POLICIES = new Set(["open", "allowlist", "disabled"]);

export const resolveZaloTemplateReference: BuiltInRenderTemplateResolver = (reference, context) => {
  if (reference === "zaloProxyUrl") return resolvedRenderTemplateReference(proxyUrl(context.env));

  switch (reference) {
    case "zalo.allowedUsers.values":
      return resolvedRenderTemplateReference(nonEmptyArray(zaloAllowedUsers(context)));
    case "zalo.allowedUsers.dmPolicy":
      return resolvedRenderTemplateReference(
        zaloAllowedUsers(context).length > 0 ? "allowlist" : undefined,
      );
    case "zalo.groupPolicy":
      return resolvedRenderTemplateReference(zaloGroupPolicy(context));
    default:
      return undefined;
  }
};

function zaloAllowedUsers(context: RenderTemplateContext): string[] {
  return [...new Set(allowedIds(context, "zalo"))];
}

function zaloGroupPolicy(context: RenderTemplateContext): string {
  const value = nonEmptyString(stateValue(context, "zaloConfig.groupPolicy"));
  return value && ZALO_GROUP_POLICIES.has(value) ? value : DEFAULT_ZALO_GROUP_POLICY;
}

function proxyUrl(env: RenderTemplateContext["env"]): string {
  const host = nonEmptyString(env?.NEMOCLAW_PROXY_HOST) ?? DEFAULT_PROXY_HOST;
  const port = nonEmptyString(env?.NEMOCLAW_PROXY_PORT) ?? DEFAULT_PROXY_PORT;
  return `http://${host}:${port}`;
}
