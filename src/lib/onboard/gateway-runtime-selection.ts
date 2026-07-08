// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NEMOCLAW_GATEWAY_RUNTIME_ENV = "NEMOCLAW_GATEWAY_RUNTIME";

export type NemoClawGatewayRuntime = "docker" | "podman";

export interface GatewayRuntimeChoice {
  runtime: NemoClawGatewayRuntime;
  displayName: string;
  description: string;
}

export function resolveNemoClawGatewayRuntime(
  env: NodeJS.ProcessEnv = process.env,
): NemoClawGatewayRuntime {
  const raw = env[NEMOCLAW_GATEWAY_RUNTIME_ENV];
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "docker") return "docker";
  if (normalized === "podman") return "podman";
  throw new Error(
    `${NEMOCLAW_GATEWAY_RUNTIME_ENV} must be either "docker" or "podman"; got ${JSON.stringify(raw)}`,
  );
}

export function isPodmanGatewayRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveNemoClawGatewayRuntime(env) === "podman";
}

export function gatewayRuntimeLabel(runtime: NemoClawGatewayRuntime): string {
  return runtime === "podman" ? "Podman" : "Docker";
}

export function isGatewayRuntimeExplicit(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(String(env[NEMOCLAW_GATEWAY_RUNTIME_ENV] ?? "").trim());
}

export function getGatewayRuntimeChoices(
  platform: NodeJS.Platform | string = process.platform,
): GatewayRuntimeChoice[] {
  const choices: GatewayRuntimeChoice[] = [
    {
      runtime: "docker",
      displayName: "Docker",
      description: "Default tested gateway runtime",
    },
  ];
  if (platform === "linux") {
    choices.push({
      runtime: "podman",
      displayName: "Podman",
      description: "Experimental rootless Linux gateway-runtime POC",
    });
  }
  return choices;
}

export async function selectNemoClawGatewayRuntime({
  env = process.env,
  platform = process.platform,
  canPrompt = false,
  isNonInteractive,
  log = console.log,
  note = () => undefined,
  prompt,
  selectFromNumberedMenu,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  canPrompt?: boolean;
  isNonInteractive: () => boolean;
  log?: (message?: string) => void;
  note?: (message: string) => void;
  prompt: (question: string) => Promise<string>;
  selectFromNumberedMenu: (
    rawChoice: string,
    defaultIdx: number,
    options: GatewayRuntimeChoice[],
  ) => GatewayRuntimeChoice;
}): Promise<NemoClawGatewayRuntime> {
  if (isGatewayRuntimeExplicit(env)) {
    const runtime = resolveNemoClawGatewayRuntime(env);
    note(`  Gateway runtime: ${gatewayRuntimeLabel(runtime)} (${NEMOCLAW_GATEWAY_RUNTIME_ENV})`);
    return runtime;
  }

  const choices = getGatewayRuntimeChoices(platform);
  if (!canPrompt || isNonInteractive() || choices.length === 1) {
    const runtime = choices[0].runtime;
    if (isNonInteractive()) {
      note(`  [non-interactive] Gateway runtime: ${gatewayRuntimeLabel(runtime)}`);
    }
    return runtime;
  }

  log("");
  log("  Select gateway runtime:");
  choices.forEach((choice, index) => {
    log(`    ${index + 1}) ${choice.displayName} — ${choice.description}`);
  });
  log("");
  const reply = await prompt("  Choose [1]: ");
  return selectFromNumberedMenu(reply, 1, choices).runtime;
}
