// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyCsv,
  nonEmptyString,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

const DEFAULT_DM_POLICY = "open";
const DM_POLICIES = new Set(["open", "allowlist", "disabled", "pairing"]);

export const resolveWecomTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  if (reference === "wecomConfig.dmPolicy") {
    return resolvedRenderTemplateReference(wecomPolicy(context));
  }

  const allowedIdsReference = reference.match(/^allowedIds[.]wecom[.](values|csv)$/);
  if (!allowedIdsReference?.[1]) return undefined;
  const ids = allowedIds(context, "wecom");
  switch (allowedIdsReference[1]) {
    case "values":
      return resolvedRenderTemplateReference(nonEmptyArray(ids));
    case "csv":
      return resolvedRenderTemplateReference(nonEmptyCsv(ids));
    default:
      return undefined;
  }
};

function wecomPolicy(context: RenderTemplateContext): string {
  const value = nonEmptyString(stateValue(context, "wecomConfig.dmPolicy"));
  return value && DM_POLICIES.has(value) ? value : DEFAULT_DM_POLICY;
}
