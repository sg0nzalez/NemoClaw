// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";

/**
 * A small, independent compositional tool router for the performance-test
 * harness. Model prompting and text embedding are injected so the routing
 * mechanics remain provider- and hardware-neutral.
 */

export const COMPOSITIONAL_ROUTER_TOP_K = 10;
export const COMPOSITIONAL_ROUTER_HINT_COUNT = 12;
export const COMPOSITIONAL_ROUTER_MAX_SELECTED_TOOLS = 16;
export const COMPOSITIONAL_ROUTER_MAX_SUBTASKS = 12;
export const COMPOSITIONAL_ROUTER_MAX_SUBTASK_CHARS = 512;

export type DecompositionPass = "initial" | "refined";

export interface DecompositionRequest {
  pass: DecompositionPass;
  query: string;
  /** Empty for the initial pass and populated only for the refinement pass. */
  tool_hints: readonly string[];
  signal?: AbortSignal;
}

export interface TaskDecomposer {
  /** Implementations return a JSON-like array; the router validates it at runtime. */
  decompose(request: DecompositionRequest): Promise<unknown>;
}

export interface TextEmbedder {
  /**
   * Return one dense vector per input string. The router normalizes every
   * vector before exact inner-product search.
   */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}

export interface ToolRoutingCatalogEntry<Definition = unknown> {
  name: string;
  description: string;
  /** Kept opaque and never copied into routing evidence. */
  definition: Definition;
}

export interface DenseToolVector {
  name: string;
  vector: readonly number[];
}

export interface DenseToolIndex {
  dimension: number;
  tools: readonly DenseToolVector[];
}

export interface RankedTool {
  name: string;
  score: number;
}

export type RoutingFallbackReason =
  | "invalid-query"
  | "invalid-catalog"
  | "initial-decomposition-failed"
  | "initial-decomposition-malformed"
  | "catalog-embedding-failed"
  | "subtask-embedding-failed"
  | "no-candidates"
  | "refinement-failed"
  | "refinement-malformed"
  | "refinement-no-tool-disagreement"
  | "run-deadline-exceeded"
  | "selection-limit-exceeded";

export interface CompositionalRoutingTimings {
  initial_decomposition_ms: number;
  catalog_embedding_ms: number;
  initial_retrieval_ms: number;
  refinement_ms: number;
  final_retrieval_ms: number;
  total_ms: number;
}

/** Prompt-free evidence. Exact tool names require a reviewed public catalog. */
export interface CompositionalRoutingEvidence {
  initial_subtask_count: number;
  refined_subtask_count: number;
  decomposition_passes: number;
  hint_count: number;
  hint_tool_names: readonly string[];
  initial_candidate_counts: readonly number[];
  initial_candidate_tool_names: readonly (readonly string[])[];
  final_candidate_counts: readonly number[];
  final_candidate_tool_names: readonly (readonly string[])[];
  selected_tool_count: number;
  selected_tool_names: readonly string[];
  fallback: RoutingFallbackReason | null;
  timings: CompositionalRoutingTimings;
}

export interface CompositionalRoutingResult {
  /** `passthrough` tells the caller to preserve its complete unfiltered catalog. */
  disposition: "routed" | "passthrough";
  selected_tool_names: readonly string[];
  evidence: CompositionalRoutingEvidence;
}

export interface CompositionalRouterOptions {
  decomposer: TaskDecomposer;
  embedder: TextEmbedder;
  /** Zero runs the initial route; one adds a tool-informed refinement pass. */
  refinementPasses?: 0 | 1;
  topK?: number;
  hintCount?: number;
  maxSelectedTools?: number;
  /** Reuse a prebuilt normalized index instead of embedding the catalog per query. */
  preparedIndex?: DenseToolIndex | Promise<DenseToolIndex>;
  signal?: AbortSignal;
  clock?: () => number;
}

export interface PairedCompositionalRoutingResult {
  initial: CompositionalRoutingResult;
  refined: CompositionalRoutingResult;
  shared_initial_decomposition: true;
  shared_initial_subtask_count: number;
}

interface MutableEvidence {
  initialSubtaskCount: number;
  refinedSubtaskCount: number;
  decompositionPasses: number;
  hintNames: string[];
  initialCandidates: RankedTool[][];
  finalCandidates: RankedTool[][];
  selectedNames: string[];
  timings: CompositionalRoutingTimings;
}

class RoutingFailure extends Error {
  constructor(readonly reason: RoutingFallbackReason) {
    super(reason);
  }
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function roundedMilliseconds(value: number): number {
  return Number(Math.max(0, value).toFixed(3));
}

function elapsed(clock: () => number, startedAt: number): number {
  return roundedMilliseconds(clock() - startedAt);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("routing aborted", "AbortError");
}

/** Normalize a finite, non-zero dense vector to unit L2 length. */
export function l2Normalize(vector: readonly number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new TypeError("embedding vectors must be non-empty arrays");
  }
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new TypeError("embedding vectors must be finite");
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) {
    throw new TypeError("embedding vectors must have a positive finite L2 norm");
  }
  const norm = Math.sqrt(squaredNorm);
  return vector.map((value) => value / norm);
}

function exactInnerProduct(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new TypeError("embedding dimensions do not match");
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Object.is(score, -0) ? 0 : score;
}

function validateCatalog<Definition>(
  catalog: readonly ToolRoutingCatalogEntry<Definition>[],
): void {
  if (!Array.isArray(catalog)) throw new RoutingFailure("invalid-catalog");
  const names = new Set<string>();
  for (const entry of catalog) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      entry.name !== entry.name.trim() ||
      typeof entry.description !== "string" ||
      names.has(entry.name)
    ) {
      throw new RoutingFailure("invalid-catalog");
    }
    names.add(entry.name);
  }
}

function toolText(entry: ToolRoutingCatalogEntry): string {
  return `${entry.name}\n${entry.description}`;
}

function normalizedMatrix(
  vectors: readonly (readonly number[])[],
  expectedRows: number,
): { dimension: number; vectors: number[][] } {
  if (!Array.isArray(vectors) || vectors.length !== expectedRows) {
    throw new TypeError("embedder returned the wrong number of vectors");
  }
  if (expectedRows === 0) return { dimension: 0, vectors: [] };
  const normalized = vectors.map((vector) => l2Normalize(vector));
  const dimension = normalized[0].length;
  if (normalized.some((vector) => vector.length !== dimension)) {
    throw new TypeError("embedder returned inconsistent vector dimensions");
  }
  return { dimension, vectors: normalized };
}

/** Build a normalized dense index without retaining opaque tool definitions. */
export async function buildDenseToolIndex(
  catalog: readonly ToolRoutingCatalogEntry[],
  embedder: TextEmbedder,
  signal?: AbortSignal,
): Promise<DenseToolIndex> {
  validateCatalog(catalog);
  if (catalog.length === 0) return { dimension: 0, tools: [] };
  throwIfAborted(signal);
  const embedded = await embedder.embed(catalog.map(toolText), signal);
  throwIfAborted(signal);
  const matrix = normalizedMatrix(embedded, catalog.length);
  return {
    dimension: matrix.dimension,
    tools: catalog.map((entry, index) => ({
      name: entry.name,
      vector: matrix.vectors[index],
    })),
  };
}

/** Rank a normalized exact inner-product index with deterministic name ties. */
export function exactInnerProductTopK(
  index: DenseToolIndex,
  queryVector: readonly number[],
  k = COMPOSITIONAL_ROUTER_TOP_K,
): RankedTool[] {
  validatePositiveInteger(k, "k");
  if (index.tools.length === 0) return [];
  const normalizedQuery = l2Normalize(queryVector);
  if (normalizedQuery.length !== index.dimension) {
    throw new TypeError("query and tool embedding dimensions do not match");
  }
  return index.tools
    .map((tool) => ({
      name: tool.name,
      score: exactInnerProduct(normalizedQuery, tool.vector),
    }))
    .sort((left, right) => right.score - left.score || compareNames(left.name, right.name))
    .slice(0, k);
}

/** Merge per-subtask candidates by maximum score, then apply a deterministic cap. */
export function unionToolHints(
  candidatesBySubtask: readonly (readonly RankedTool[])[],
  limit = COMPOSITIONAL_ROUTER_HINT_COUNT,
): RankedTool[] {
  validatePositiveInteger(limit, "hint limit");
  const maximumScores = new Map<string, number>();
  for (const candidates of candidatesBySubtask) {
    for (const candidate of candidates) {
      if (!candidate.name || !Number.isFinite(candidate.score)) continue;
      const current = maximumScores.get(candidate.name);
      if (current === undefined || candidate.score > current) {
        maximumScores.set(candidate.name, candidate.score);
      }
    }
  }
  return [...maximumScores.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort((left, right) => right.score - left.score || compareNames(left.name, right.name))
    .slice(0, limit);
}

function validateSubtasks(value: unknown, malformedReason: RoutingFallbackReason): string[] {
  if (!Array.isArray(value) || value.length > COMPOSITIONAL_ROUTER_MAX_SUBTASKS) {
    throw new RoutingFailure(malformedReason);
  }
  const subtasks: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new RoutingFailure(malformedReason);
    const normalized = item.trim();
    if (!normalized || normalized.length > COMPOSITIONAL_ROUTER_MAX_SUBTASK_CHARS) {
      throw new RoutingFailure(malformedReason);
    }
    subtasks.push(normalized);
  }
  return subtasks;
}

async function embedSubtasks(
  subtasks: readonly string[],
  embedder: TextEmbedder,
  index: DenseToolIndex,
  signal?: AbortSignal,
): Promise<number[][]> {
  throwIfAborted(signal);
  const embedded = await embedder.embed(subtasks, signal);
  throwIfAborted(signal);
  const matrix = normalizedMatrix(embedded, subtasks.length);
  if (matrix.dimension !== index.dimension) {
    throw new TypeError("subtask and catalog embedding dimensions do not match");
  }
  return matrix.vectors;
}

function emptyTimings(): CompositionalRoutingTimings {
  return {
    initial_decomposition_ms: 0,
    catalog_embedding_ms: 0,
    initial_retrieval_ms: 0,
    refinement_ms: 0,
    final_retrieval_ms: 0,
    total_ms: 0,
  };
}

function evidence(
  mutable: MutableEvidence,
  fallback: RoutingFallbackReason | null,
): CompositionalRoutingEvidence {
  return {
    initial_subtask_count: mutable.initialSubtaskCount,
    refined_subtask_count: mutable.refinedSubtaskCount,
    decomposition_passes: mutable.decompositionPasses,
    hint_count: mutable.hintNames.length,
    hint_tool_names: [...mutable.hintNames],
    initial_candidate_counts: mutable.initialCandidates.map((candidates) => candidates.length),
    initial_candidate_tool_names: mutable.initialCandidates.map((candidates) =>
      candidates.map((candidate) => candidate.name),
    ),
    final_candidate_counts: mutable.finalCandidates.map((candidates) => candidates.length),
    final_candidate_tool_names: mutable.finalCandidates.map((candidates) =>
      candidates.map((candidate) => candidate.name),
    ),
    selected_tool_count: mutable.selectedNames.length,
    selected_tool_names: [...mutable.selectedNames],
    fallback,
    timings: { ...mutable.timings },
  };
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

interface RoutingLimits {
  topK: number;
  hintCount: number;
  maxSelectedTools: number;
}

interface InitialRoutingStage {
  initialSubtasks: readonly string[];
  index: DenseToolIndex | null;
  mutable: MutableEvidence;
  fallback: RoutingFallbackReason | null;
}

function routingLimits(options: CompositionalRouterOptions): RoutingLimits {
  const limits = {
    topK: options.topK ?? COMPOSITIONAL_ROUTER_TOP_K,
    hintCount: options.hintCount ?? COMPOSITIONAL_ROUTER_HINT_COUNT,
    maxSelectedTools: options.maxSelectedTools ?? COMPOSITIONAL_ROUTER_MAX_SELECTED_TOOLS,
  };
  validatePositiveInteger(limits.topK, "topK");
  validatePositiveInteger(limits.hintCount, "hintCount");
  validatePositiveInteger(limits.maxSelectedTools, "maxSelectedTools");
  return limits;
}

function emptyMutableEvidence(): MutableEvidence {
  return {
    initialSubtaskCount: 0,
    refinedSubtaskCount: 0,
    decompositionPasses: 0,
    hintNames: [],
    initialCandidates: [],
    finalCandidates: [],
    selectedNames: [],
    timings: emptyTimings(),
  };
}

function cloneCandidates(candidates: readonly (readonly RankedTool[])[]): RankedTool[][] {
  return candidates.map((ranked) => ranked.map((candidate) => ({ ...candidate })));
}

function cloneMutableEvidence(source: MutableEvidence): MutableEvidence {
  return {
    initialSubtaskCount: source.initialSubtaskCount,
    refinedSubtaskCount: source.refinedSubtaskCount,
    decompositionPasses: source.decompositionPasses,
    hintNames: [...source.hintNames],
    initialCandidates: cloneCandidates(source.initialCandidates),
    finalCandidates: cloneCandidates(source.finalCandidates),
    selectedNames: [...source.selectedNames],
    timings: { ...source.timings },
  };
}

function fallbackReason(error: unknown): RoutingFallbackReason {
  return error instanceof RoutingFailure ? error.reason : "subtask-embedding-failed";
}

async function prepareInitialRoutingStage<Definition>(
  query: string,
  catalog: readonly ToolRoutingCatalogEntry<Definition>[],
  options: Omit<CompositionalRouterOptions, "refinementPasses">,
  limits: RoutingLimits,
  clock: () => number,
): Promise<InitialRoutingStage> {
  const mutable = emptyMutableEvidence();
  let initialSubtasks: string[] = [];
  let index: DenseToolIndex | null = null;
  try {
    throwIfAborted(options.signal);
    if (typeof query !== "string" || !query.trim()) throw new RoutingFailure("invalid-query");
    validateCatalog(catalog);

    const initialStartedAt = clock();
    let rawInitial: unknown;
    mutable.decompositionPasses = 1;
    try {
      rawInitial = await options.decomposer.decompose({
        pass: "initial",
        query,
        tool_hints: [],
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      throw new RoutingFailure("initial-decomposition-failed");
    } finally {
      mutable.timings.initial_decomposition_ms = elapsed(clock, initialStartedAt);
    }
    initialSubtasks = validateSubtasks(rawInitial, "initial-decomposition-malformed");
    mutable.initialSubtaskCount = initialSubtasks.length;
    if (initialSubtasks.length === 0) {
      return { initialSubtasks, index, mutable, fallback: null };
    }

    const catalogStartedAt = clock();
    try {
      index = await (options.preparedIndex ??
        buildDenseToolIndex(catalog, options.embedder, options.signal));
      const catalogNames = catalog.map((entry) => entry.name);
      if (
        index.tools.length !== catalogNames.length ||
        index.tools.some((tool, position) => tool.name !== catalogNames[position])
      ) {
        throw new TypeError("prepared index does not match the routing catalog");
      }
    } catch {
      throw new RoutingFailure("catalog-embedding-failed");
    } finally {
      mutable.timings.catalog_embedding_ms = elapsed(clock, catalogStartedAt);
    }
    if (index.tools.length === 0) throw new RoutingFailure("no-candidates");

    const initialRetrievalStartedAt = clock();
    try {
      const vectors = await embedSubtasks(initialSubtasks, options.embedder, index, options.signal);
      mutable.initialCandidates = vectors.map((vector) =>
        exactInnerProductTopK(
          index as DenseToolIndex,
          vector,
          Math.max(limits.hintCount, limits.topK),
        ),
      );
    } catch {
      throw new RoutingFailure("subtask-embedding-failed");
    } finally {
      mutable.timings.initial_retrieval_ms = elapsed(clock, initialRetrievalStartedAt);
    }
    return { initialSubtasks, index, mutable, fallback: null };
  } catch (error) {
    return { initialSubtasks, index, mutable, fallback: fallbackReason(error) };
  }
}

async function routeFromInitialStage<Definition>(
  query: string,
  catalog: readonly ToolRoutingCatalogEntry<Definition>[],
  options: Omit<CompositionalRouterOptions, "refinementPasses">,
  refinementPasses: 0 | 1,
  limits: RoutingLimits,
  clock: () => number,
  totalStartedAt: number,
  stage: InitialRoutingStage,
): Promise<CompositionalRoutingResult> {
  const mutable = cloneMutableEvidence(stage.mutable);
  const finish = (
    disposition: CompositionalRoutingResult["disposition"],
    fallback: RoutingFallbackReason | null,
  ): CompositionalRoutingResult => {
    mutable.timings.total_ms = elapsed(clock, totalStartedAt);
    return {
      disposition,
      selected_tool_names: disposition === "routed" ? [...mutable.selectedNames] : [],
      evidence: evidence(mutable, fallback),
    };
  };

  if (stage.fallback !== null) return finish("passthrough", stage.fallback);
  if (stage.initialSubtasks.length === 0) return finish("routed", null);
  const index = stage.index;
  if (index === null) return finish("passthrough", "no-candidates");

  try {
    if (refinementPasses === 0) {
      mutable.finalCandidates = mutable.initialCandidates.map((candidates) =>
        candidates.slice(0, limits.topK),
      );
      const selectedNames = uniqueInOrder(
        mutable.finalCandidates.map((candidates) => candidates[0]?.name).filter(Boolean),
      );
      if (selectedNames.length > limits.maxSelectedTools) {
        throw new RoutingFailure("selection-limit-exceeded");
      }
      mutable.selectedNames = selectedNames;
      return finish("routed", null);
    }

    const hints = unionToolHints(mutable.initialCandidates, limits.hintCount);
    mutable.hintNames = hints.map((candidate) => candidate.name);
    if (mutable.hintNames.length === 0) throw new RoutingFailure("no-candidates");

    const refinementStartedAt = clock();
    let rawRefined: unknown;
    mutable.decompositionPasses = 2;
    try {
      rawRefined = await options.decomposer.decompose({
        pass: "refined",
        query,
        tool_hints: mutable.hintNames,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      throw new RoutingFailure("refinement-failed");
    } finally {
      mutable.timings.refinement_ms = elapsed(clock, refinementStartedAt);
    }
    const refinedSubtasks = validateSubtasks(rawRefined, "refinement-malformed");
    mutable.refinedSubtaskCount = refinedSubtasks.length;
    if (refinedSubtasks.length === 0) {
      throw new RoutingFailure("refinement-no-tool-disagreement");
    }

    const finalRetrievalStartedAt = clock();
    try {
      const vectors = await embedSubtasks(refinedSubtasks, options.embedder, index, options.signal);
      mutable.finalCandidates = vectors.map((vector) =>
        exactInnerProductTopK(index, vector, limits.topK),
      );
    } catch {
      throw new RoutingFailure("subtask-embedding-failed");
    } finally {
      mutable.timings.final_retrieval_ms = elapsed(clock, finalRetrievalStartedAt);
    }
    if (mutable.finalCandidates.some((candidates) => candidates.length === 0)) {
      throw new RoutingFailure("no-candidates");
    }

    const selectedNames = uniqueInOrder(
      mutable.finalCandidates.map((candidates) => candidates[0]?.name).filter(Boolean),
    );
    if (selectedNames.length > limits.maxSelectedTools) {
      throw new RoutingFailure("selection-limit-exceeded");
    }
    mutable.selectedNames = selectedNames;
    return finish("routed", null);
  } catch (error) {
    return finish("passthrough", fallbackReason(error));
  }
}

/**
 * Run an initial decomposition and, by default, one tool-informed refinement.
 * Set `refinementPasses` to zero to score the initial route. Any malformed model
 * output or unavailable retrieval dependency returns `passthrough`, so a caller
 * can retain the complete original tool catalog rather than losing a capability.
 * An empty initial decomposition is treated as an intentional no-tool route.
 */
export async function routeCompositionalTools<Definition>(
  query: string,
  catalog: readonly ToolRoutingCatalogEntry<Definition>[],
  options: CompositionalRouterOptions,
): Promise<CompositionalRoutingResult> {
  const limits = routingLimits(options);
  const refinementPasses = options.refinementPasses ?? 1;
  if (refinementPasses !== 0 && refinementPasses !== 1) {
    throw new TypeError("refinementPasses must be zero or one");
  }
  const clock = options.clock ?? (() => performance.now());
  const totalStartedAt = clock();
  const sharedOptions = { ...options, refinementPasses: undefined };
  const stage = await prepareInitialRoutingStage(query, catalog, sharedOptions, limits, clock);
  return routeFromInitialStage(
    query,
    catalog,
    sharedOptions,
    refinementPasses,
    limits,
    clock,
    totalStartedAt,
    stage,
  );
}

/**
 * Produce a fair initial/refined pair from one initial decomposition and one
 * shared catalog index and initial retrieval stage.
 */
export async function routeCompositionalToolsPaired<Definition>(
  query: string,
  catalog: readonly ToolRoutingCatalogEntry<Definition>[],
  options: Omit<CompositionalRouterOptions, "refinementPasses">,
): Promise<PairedCompositionalRoutingResult> {
  const limits = routingLimits(options);
  const clock = options.clock ?? (() => performance.now());
  const totalStartedAt = clock();
  const stage = await prepareInitialRoutingStage(query, catalog, options, limits, clock);
  const initial = await routeFromInitialStage(
    query,
    catalog,
    options,
    0,
    limits,
    clock,
    totalStartedAt,
    stage,
  );
  const refined = await routeFromInitialStage(
    query,
    catalog,
    options,
    1,
    limits,
    clock,
    totalStartedAt,
    stage,
  );
  if (initial.evidence.initial_subtask_count !== refined.evidence.initial_subtask_count) {
    throw new Error("paired routes did not share the initial decomposition");
  }
  return {
    initial,
    refined,
    shared_initial_decomposition: true,
    shared_initial_subtask_count: initial.evidence.initial_subtask_count,
  };
}

/**
 * Resolve selected names back to the caller-owned definitions. Routed results
 * preserve selected order; passthrough results preserve the full catalog order.
 */
export function selectRoutedToolDefinitions<Definition>(
  catalog: readonly ToolRoutingCatalogEntry<Definition>[],
  result: CompositionalRoutingResult,
): Definition[] {
  if (result.disposition === "passthrough") return catalog.map((entry) => entry.definition);
  const byName = new Map(catalog.map((entry) => [entry.name, entry.definition]));
  return result.selected_tool_names.flatMap((name) => {
    const definition = byName.get(name);
    return definition === undefined ? [] : [definition];
  });
}
