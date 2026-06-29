// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import { DASHBOARD_PORT } from "../../../../core/ports";
import { prompt } from "../../../../credentials/store";
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
export function createDefaultGooglechatTunnelGateOptions(): GooglechatTunnelAudienceGateHookOptions {
  const dashboardPort = DASHBOARD_PORT;
  return {
    hasCloudflared: () => {
      try {
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
    prompt: (question: string) => prompt(question),
  };
}
