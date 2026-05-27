// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export interface FixtureDefinition {
  id: string;
  type: string;
  service?: string;
  files?: Record<string, string>;
}

export interface FixtureContext {
  contextDir: string;
  homeDir?: string;
}

export interface FixtureHandle {
  id: string;
  type: string;
  contextDir: string;
  homeDir?: string;
  evidencePath: string;
  outputs: Record<string, unknown>;
}

export interface FixtureTeardownResult {
  ok: boolean;
  evidencePath: string;
}

export interface RuntimeActionDefinition {
  id: string;
  order: number;
  args?: Record<string, unknown>;
}

export interface RuntimeActionEvidence {
  id: string;
  order: number;
  evidencePath: string;
  outputs: Record<string, unknown>;
}

export interface RuntimeActionResult {
  evidence: RuntimeActionEvidence[];
  outputs: Record<string, Record<string, unknown>>;
}

export async function setupFixture(
  fixture: FixtureDefinition,
  context: FixtureContext,
): Promise<FixtureHandle> {
  const fixtureDir = path.join(context.contextDir, "fixtures", fixture.id);
  fs.mkdirSync(fixtureDir, { recursive: true });
  const outputs: Record<string, unknown> = {};

  if (fixture.type === "fake-service") {
    const port = deterministicPort(fixture.id);
    outputs.endpointUrl = `http://127.0.0.1:${port}`;
    outputs.service = fixture.service ?? fixture.id;
    outputs.pid = null;
  } else if (fixture.type === "home-state") {
    const homeDir = context.homeDir ?? path.join(context.contextDir, "home");
    const nemoDir = path.join(homeDir, ".nemoclaw");
    const files: Record<string, string> = {};
    for (const [relative, content] of Object.entries(fixture.files ?? {})) {
      const target = path.join(nemoDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      files[target] = relative;
    }
    outputs.files = files;
  } else {
    outputs.created = true;
  }

  const evidencePath = path.join(fixtureDir, "setup-evidence.json");
  writeJson(evidencePath, {
    fixtureId: fixture.id,
    type: fixture.type,
    outputs,
    phase: "setup",
  });

  return {
    id: fixture.id,
    type: fixture.type,
    contextDir: context.contextDir,
    homeDir: context.homeDir,
    evidencePath,
    outputs,
  };
}

export async function teardownFixture(handle: FixtureHandle): Promise<FixtureTeardownResult> {
  if (handle.type === "home-state") {
    for (const file of Object.keys((handle.outputs.files as Record<string, string>) ?? {})) {
      fs.rmSync(file, { force: true });
    }
  }
  const evidencePath = path.join(handle.contextDir, "fixtures", handle.id, "teardown-evidence.json");
  writeJson(evidencePath, {
    fixtureId: handle.id,
    type: handle.type,
    phase: "teardown",
    ok: true,
  });
  return { ok: true, evidencePath };
}

export async function runRuntimeActions(
  actions: RuntimeActionDefinition[],
  context: { contextDir: string },
): Promise<RuntimeActionResult> {
  const evidence: RuntimeActionEvidence[] = [];
  const outputs: Record<string, Record<string, unknown>> = {};
  const actionDir = path.join(context.contextDir, "runtime-actions");
  fs.mkdirSync(actionDir, { recursive: true });

  for (const action of [...actions].sort((a, b) => a.order - b.order)) {
    const actionOutputs = actionOutputsFor(action);
    const evidencePath = path.join(actionDir, `${String(action.order).padStart(3, "0")}-${safeName(action.id)}.json`);
    writeJson(evidencePath, {
      actionId: action.id,
      order: action.order,
      outputs: actionOutputs,
    });
    outputs[action.id] = actionOutputs;
    evidence.push({
      id: action.id,
      order: action.order,
      evidencePath,
      outputs: actionOutputs,
    });
  }
  return { evidence, outputs };
}

function actionOutputsFor(action: RuntimeActionDefinition): Record<string, unknown> {
  const args = action.args ?? {};
  if (action.id === "channels.add") {
    return { channel: args.channel, changed: true };
  }
  if (action.id === "inference.set") {
    return { provider: args.provider, changed: true };
  }
  if (action.id === "snapshot.create") {
    return { snapshotId: "snapshot-0001" };
  }
  if (action.id === "rebuild") {
    return { rebuilt: true };
  }
  return { ok: true, ...args };
}

function deterministicPort(id: string): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 33 + ch.charCodeAt(0)) % 1000;
  return 18000 + hash;
}

function safeName(id: string): string {
  return id.replace(/[^a-z0-9_.-]+/gi, "-");
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
