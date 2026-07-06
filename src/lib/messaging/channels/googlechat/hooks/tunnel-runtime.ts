// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../../../../core/ports";
import type { GooglechatTunnelAudienceGateHookOptions } from "./tunnel-audience-gate";

// Side-effectful defaults for the tunnel/audience gate, kept out of the hook
// file itself. The gate composes these with the same service helpers
// `nemoclaw tunnel start/status/stop` use, so it targets the same tunnel.
// tunnel/services, node:child_process, and credentials/store are lazy-required
// inside the callbacks (not imported at the top) so they stay out of the
// eagerly-imported hook graph: the built-in hook registry is constructed at
// module load, and importing tunnel/services eagerly closes an import cycle.
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
    readTunnelState: () => {
      const { readCloudflaredState, resolveServicePidDir } =
        require("../../../../tunnel/services") as typeof import("../../../../tunnel/services");
      return {
        running: readCloudflaredState(resolveServicePidDir()).kind === "running",
      };
    },
    startTunnel: () => {
      const { startAll } =
        require("../../../../tunnel/services") as typeof import("../../../../tunnel/services");
      return startAll();
    },
    stopTunnel: () => {
      const { stopCloudflared } =
        require("../../../../tunnel/services") as typeof import("../../../../tunnel/services");
      stopCloudflared();
    },
    getTunnelUrl: () => {
      const { getTunnelUrl: getServiceTunnelUrl, resolveServicePidDir } =
        require("../../../../tunnel/services") as typeof import("../../../../tunnel/services");
      return getServiceTunnelUrl(resolveServicePidDir(), dashboardPort);
    },
    prompt: (question: string) => {
      const { prompt } =
        require("../../../../credentials/store") as typeof import("../../../../credentials/store");
      return prompt(question);
    },
  };
}
