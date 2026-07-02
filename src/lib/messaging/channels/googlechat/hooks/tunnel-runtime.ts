// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../../../../core/ports";
import {
  getTunnelUrl as getServiceTunnelUrl,
  readCloudflaredState,
  resolveServicePidDir,
  startAll,
  stopCloudflared,
} from "../../../../tunnel/services";
import type { GooglechatTunnelAudienceGateHookOptions } from "./tunnel-audience-gate";

// Side-effectful defaults for the tunnel/audience gate, kept out of the hook
// file itself. The gate composes these with the same service helpers
// `nemoclaw tunnel start/status/stop` use, so it targets the same tunnel.
// node:child_process and credentials/store are lazy-required inside the callbacks
// (not imported at the top) so they stay out of the eagerly-imported hook graph.
export function createDefaultGooglechatTunnelGateOptions(): GooglechatTunnelAudienceGateHookOptions {
  const dashboardPort = DASHBOARD_PORT;
  return {
    hasCloudflared: () => {
      try {
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        execSync("command -v cloudflared", { stdio: ["ignore", "ignore", "ignore"] });
        return true;
      } catch {
        return false;
      }
    },
    readTunnelState: () => ({
      running: readCloudflaredState(resolveServicePidDir()).kind === "running",
    }),
    startTunnel: () => startAll(),
    stopTunnel: () => {
      stopCloudflared();
    },
    getTunnelUrl: () => getServiceTunnelUrl(resolveServicePidDir(), dashboardPort),
    prompt: (question: string) => {
      const { prompt } =
        require("../../../../credentials/store") as typeof import("../../../../credentials/store");
      return prompt(question);
    },
  };
}
