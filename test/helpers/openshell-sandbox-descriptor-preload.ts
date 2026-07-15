// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/** Replace only the strict descriptor read in fake-OpenShell CLI subprocess tests. */
export function writeOpenShellSandboxDescriptorPreload(home: string, image: string): string {
  const preload = path.join(home, "openshell-sandbox-descriptor-preload.cjs");
  fs.writeFileSync(
    preload,
    `const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function loadWithSandboxDescriptor(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (typeof request === "string" && /sandbox-control-routing(?:\\.[cm]?[jt]s)?$/.test(request)) {
    return {
      ...loaded,
      getOpenShellSandboxDescriptor: async (_gatewayName, sandboxName) => ({
        id: sandboxName + "-id",
        name: sandboxName,
        image: ${JSON.stringify(image)},
      }),
    };
  }
  return loaded;
};
`,
    { mode: 0o600 },
  );
  return [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
}
