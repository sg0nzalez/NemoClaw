// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyString,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

const DEFAULT_AUDIENCE_TYPE = "app-url";
const DEFAULT_WEBHOOK_PATH = "/googlechat";

export const resolveGooglechatTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  switch (reference) {
    case "googlechatConfig.audienceType":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "googlechatConfig.audienceType")) ??
          DEFAULT_AUDIENCE_TYPE,
      );
    case "googlechatConfig.audience":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "googlechatConfig.audience")),
      );
    case "googlechatConfig.appPrincipal":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "googlechatConfig.appPrincipal")),
      );
    case "googlechatConfig.webhookPath":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "googlechatConfig.webhookPath")) ?? DEFAULT_WEBHOOK_PATH,
      );
    default:
      break;
  }

  // DM allowlist normalization. `values` resolving to undefined drops the
  // `allowFrom` key; `dmPolicy` resolving to undefined drops `dm.policy`. When
  // both drop, the empty `dm` object is removed by the render engine and
  // OpenClaw falls back to its default (pairing) DM policy.
  const allowReference = reference.match(/^allowedIds[.]googlechat[.](values|dmPolicy)$/);
  if (!allowReference?.[1]) return undefined;
  const ids = allowedIds(context, "googlechat");
  switch (allowReference[1]) {
    case "values":
      return resolvedRenderTemplateReference(nonEmptyArray(ids));
    case "dmPolicy":
      return resolvedRenderTemplateReference(ids.length > 0 ? "allowlist" : undefined);
    default:
      return undefined;
  }
};
