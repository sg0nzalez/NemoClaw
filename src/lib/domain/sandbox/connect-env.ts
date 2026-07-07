// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function hasExplicitBoolean(value: string | undefined): boolean {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return TRUE_VALUES.has(normalized) || FALSE_VALUES.has(normalized);
}

function hostTerminalLooksLight(env: NodeJS.ProcessEnv): boolean {
  const colorfgbg = String(env.COLORFGBG ?? "").trim();
  if (!colorfgbg) return false;

  const lastField = colorfgbg.split(";").at(-1) ?? "";
  const bg = Number(lastField);
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return false;
  return bg === 7 || bg === 15;
}

export function buildSandboxConnectEnv(
  agent: { name?: string } | null | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  if (
    agent?.name === "hermes" &&
    !hasExplicitBoolean(nextEnv.HERMES_TUI_LIGHT) &&
    !String(nextEnv.HERMES_TUI_THEME ?? "").trim() &&
    hostTerminalLooksLight(nextEnv)
  ) {
    nextEnv.HERMES_TUI_LIGHT = "1";
  }
  return nextEnv;
}
