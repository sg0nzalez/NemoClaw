// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const TOOL_DISCLOSURE_PERFORMANCE_TEST_CATALOG_SCHEMA_VERSION =
  "nemoclaw.tool_disclosure.performance_test.catalog.v1" as const;
export const DEFAULT_SYNTHETIC_PERFORMANCE_TEST_CATALOG_SEED =
  "nemoclaw-tool-disclosure-performance-test-v1";
export const MAX_SYNTHETIC_TOOLS = 2_209;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonSchema {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean";
  description?: string;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly JsonPrimitive[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

/**
 * The categories are deliberately synthetic and vendor-neutral. Their labels,
 * resources, and operations make every generated tool understandable without
 * implying access to a real service or copying a production API.
 */
export const SYNTHETIC_CATEGORIES = [
  {
    id: "calendar",
    label: "calendar",
    resource: "event",
    purpose: "appointments, availability, and event logistics",
    operations: [
      "find",
      "schedule",
      "reschedule",
      "cancel",
      "list_attendees",
      "check_availability",
    ],
  },
  {
    id: "contacts",
    label: "contacts",
    resource: "contact",
    purpose: "people and organization directory records",
    operations: ["find", "create", "update", "merge", "list_groups", "verify"],
  },
  {
    id: "email",
    label: "email",
    resource: "message",
    purpose: "mailbox messages and threads",
    operations: ["search", "draft", "send", "archive", "summarize", "list_attachments"],
  },
  {
    id: "documents",
    label: "documents",
    resource: "document",
    purpose: "text documents and their revisions",
    operations: ["search", "create", "update", "compare", "export", "list_revisions"],
  },
  {
    id: "storage",
    label: "storage",
    resource: "file",
    purpose: "files, folders, and object metadata",
    operations: ["find", "upload", "copy", "move", "share", "inspect_metadata"],
  },
  {
    id: "messaging",
    label: "messaging",
    resource: "conversation",
    purpose: "chat conversations and channel messages",
    operations: ["search", "post", "reply", "list_members", "summarize", "pin"],
  },
  {
    id: "projects",
    label: "projects",
    resource: "project",
    purpose: "project plans, milestones, and ownership",
    operations: ["find", "create", "update", "list_milestones", "assign_owner", "summarize"],
  },
  {
    id: "issues",
    label: "issues",
    resource: "issue",
    purpose: "work items, defects, and status tracking",
    operations: ["search", "create", "update", "link", "list_blockers", "triage"],
  },
  {
    id: "source_control",
    label: "source control",
    resource: "revision",
    purpose: "repositories, revisions, and code review metadata",
    operations: ["search", "inspect", "compare", "list_changes", "list_reviews", "summarize"],
  },
  {
    id: "ci_cd",
    label: "continuous integration",
    resource: "pipeline",
    purpose: "build pipelines, jobs, and deployment runs",
    operations: ["find", "inspect", "retry", "cancel", "list_jobs", "summarize"],
  },
  {
    id: "observability",
    label: "observability",
    resource: "signal",
    purpose: "metrics, logs, traces, and service health",
    operations: ["query", "inspect", "compare", "list_alerts", "summarize", "correlate"],
  },
  {
    id: "incidents",
    label: "incidents",
    resource: "incident",
    purpose: "operational incidents and response coordination",
    operations: ["find", "create", "update", "list_responders", "summarize", "close"],
  },
  {
    id: "infrastructure",
    label: "infrastructure",
    resource: "resource",
    purpose: "deployed infrastructure and configuration state",
    operations: ["find", "inspect", "compare", "list_dependencies", "validate", "summarize"],
  },
  {
    id: "compute",
    label: "compute",
    resource: "compute allocation",
    purpose: "compute capacity, allocations, and runtime state",
    operations: ["find", "inspect", "list_capacity", "compare", "validate", "summarize"],
  },
  {
    id: "databases",
    label: "databases",
    resource: "dataset",
    purpose: "database objects, queries, and metadata",
    operations: ["find", "describe", "query", "list_columns", "validate", "summarize"],
  },
  {
    id: "analytics",
    label: "analytics",
    resource: "analysis",
    purpose: "reports, measures, and analytical results",
    operations: ["find", "calculate", "compare", "list_dimensions", "forecast", "summarize"],
  },
  {
    id: "finance",
    label: "finance",
    resource: "financial record",
    purpose: "budgets, transactions, and financial summaries",
    operations: ["find", "calculate", "compare", "list_transactions", "validate", "summarize"],
  },
  {
    id: "commerce",
    label: "commerce",
    resource: "order",
    purpose: "orders, products, and fulfillment records",
    operations: ["find", "create", "update", "list_items", "track", "summarize"],
  },
  {
    id: "travel",
    label: "travel",
    resource: "itinerary",
    purpose: "bookings, itineraries, and travel options",
    operations: ["search", "inspect", "compare", "list_segments", "validate", "summarize"],
  },
  {
    id: "maps",
    label: "maps",
    resource: "place",
    purpose: "places, routes, and geographic information",
    operations: ["search", "inspect", "route", "list_nearby", "compare", "summarize"],
  },
  {
    id: "weather",
    label: "weather",
    resource: "forecast",
    purpose: "forecasts, conditions, and weather alerts",
    operations: ["find", "inspect", "compare", "list_alerts", "validate", "summarize"],
  },
  {
    id: "research",
    label: "research",
    resource: "source",
    purpose: "research sources, evidence, and citations",
    operations: ["search", "inspect", "compare", "list_citations", "validate", "summarize"],
  },
  {
    id: "knowledge",
    label: "knowledge",
    resource: "knowledge entry",
    purpose: "knowledge-base entries and linked concepts",
    operations: ["search", "inspect", "create", "update", "list_links", "summarize"],
  },
  {
    id: "media",
    label: "media",
    resource: "media asset",
    purpose: "audio, image, and video asset metadata",
    operations: ["search", "inspect", "transcode", "list_variants", "compare", "summarize"],
  },
] as const;

export type SyntheticCategoryId = (typeof SYNTHETIC_CATEGORIES)[number]["id"];
export type SchemaComplexity = "small" | "medium" | "large";

export interface SyntheticTool {
  index: number;
  category: SyntheticCategoryId;
  operation: string;
  complexity: SchemaComplexity;
  definition: OpenAIFunctionTool;
  handler: {
    kind: "deterministic_fixture_v1";
    key: string;
  };
}

export interface SyntheticCatalog {
  schema_version: typeof TOOL_DISCLOSURE_PERFORMANCE_TEST_CATALOG_SCHEMA_VERSION;
  seed: string;
  size: number;
  max_size: typeof MAX_SYNTHETIC_TOOLS;
  tools_sha256: string;
  tools: SyntheticTool[];
}

export interface SyntheticCatalogOptions {
  size?: number;
  seed?: string | number;
}

export interface SyntheticToolResult extends JsonObject {
  ok: true;
  tool_name: string;
  category: SyntheticCategoryId;
  operation: string;
  nonce: string;
  arguments_sha256: string;
  summary: string;
}

export class SyntheticToolInvocationError extends Error {}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// A 25/50/25 cycle makes the medium schema the catalog median while retaining
// substantial small and large populations for scaling comparisons. The medium
// definition is intentionally near the performance test's roughly 400-token target;
// authoritative token counts still come from the pinned model tokenizer.
const COMPLEXITY_CYCLE: readonly SchemaComplexity[] = [
  "small",
  "small",
  "small",
  "small",
  "small",
  "medium",
  "medium",
  "medium",
  "medium",
  "medium",
  "medium",
  "medium",
  "medium",
  "medium",
  "medium",
  "large",
  "large",
  "large",
  "large",
  "large",
];

export function canonicalJson(value: JsonValue): string {
  return canonicalize(value, new Set<object>());
}

function canonicalize(value: JsonValue, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("canonical JSON does not support cyclic values");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`);
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeSeed(seed: string | number): string {
  if (typeof seed === "number" && (!Number.isSafeInteger(seed) || seed < 0)) {
    throw new TypeError("catalog seed numbers must be non-negative safe integers");
  }
  const normalized = String(seed);
  if (normalized.length === 0) throw new TypeError("catalog seed must not be empty");
  return normalized;
}

function hashUint32(seed: string, scope: string): number {
  const digest = createHash("sha256").update(`${seed}\0${scope}`, "utf8").digest();
  return digest.readUInt32BE(0);
}

function shuffledCategories(seed: string): readonly (typeof SYNTHETIC_CATEGORIES)[number][] {
  const categories = [...SYNTHETIC_CATEGORIES];
  for (let index = categories.length - 1; index > 0; index -= 1) {
    const swap = hashUint32(seed, `category-permutation:${index}`) % (index + 1);
    [categories[index], categories[swap]] = [categories[swap], categories[index]];
  }
  return categories;
}

function complexityForIndex(index: number): SchemaComplexity {
  return COMPLEXITY_CYCLE[index % COMPLEXITY_CYCLE.length];
}

function resourceIdSchema(resource: string): JsonSchema {
  return {
    type: "string",
    description: `Stable synthetic ${resource} identifier. A prior tool nonce is also valid.`,
    minLength: 1,
    maxLength: 96,
    pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
  };
}

function buildParameters(
  category: (typeof SYNTHETIC_CATEGORIES)[number],
  operation: string,
  complexity: SchemaComplexity,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    resource_id: resourceIdSchema(category.resource),
    query: {
      type: "string",
      description: `Precise synthetic request for the ${operation} operation.`,
      minLength: 1,
      maxLength: 160,
    },
  };
  const required = ["resource_id", "query"];

  if (complexity !== "small") {
    properties.limit = {
      type: "integer",
      description: "Maximum number of deterministic fixture records to consider.",
      minimum: 1,
      maximum: 50,
    };
    properties.include_archived = {
      type: "boolean",
      description: "Whether archived synthetic records participate in the operation.",
    };
    properties.tags = {
      type: "array",
      description: "Optional synthetic labels used to narrow the operation.",
      items: { type: "string", minLength: 1, maxLength: 32 },
      maxItems: 5,
      uniqueItems: true,
    };
    required.push("limit");
  }

  if (complexity === "large") {
    properties.filters = {
      type: "object",
      description: `Structured filters for the synthetic ${category.resource}.`,
      properties: {
        status: {
          type: "string",
          enum: ["active", "pending", "complete"],
          description: "Synthetic lifecycle state to select.",
        },
        owner: {
          type: "string",
          minLength: 1,
          maxLength: 48,
          description: "Synthetic owner identifier.",
        },
        window: {
          type: "object",
          description: "Inclusive logical-day range within the fixture timeline.",
          properties: {
            start_day: { type: "integer", minimum: 1, maximum: 365 },
            end_day: { type: "integer", minimum: 1, maximum: 365 },
          },
          required: ["start_day", "end_day"],
          additionalProperties: false,
        },
      },
      required: ["status", "owner", "window"],
      additionalProperties: false,
    };
    properties.options = {
      type: "object",
      description: "Deterministic projection and ordering controls.",
      properties: {
        sort_order: { type: "string", enum: ["ascending", "descending"] },
        fields: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 32 },
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
        },
        explain: { type: "boolean" },
      },
      required: ["sort_order", "fields", "explain"],
      additionalProperties: false,
    };
    properties.correlation_id = {
      type: "string",
      description: "Caller-provided identifier for deterministic chain assertions.",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9_.:-]+$",
    };
    required.push("filters", "options");
  }

  return {
    type: "object",
    description: `Inputs for a synthetic ${category.label} performance test operation.`,
    properties,
    required,
    additionalProperties: false,
  };
}

function generateTool(
  index: number,
  seed: string,
  categories: readonly (typeof SYNTHETIC_CATEGORIES)[number][],
): SyntheticTool {
  const category = categories[index % categories.length];
  const occurrence = Math.floor(index / categories.length);
  const operationOffset =
    hashUint32(seed, `operation-offset:${category.id}`) % category.operations.length;
  const operation =
    category.operations[(occurrence + operationOffset) % category.operations.length];
  const complexity = complexityForIndex(index);
  const name = `performance_test_${category.id}_${operation}_${index.toString().padStart(4, "0")}`;

  if (!TOOL_NAME_PATTERN.test(name)) throw new Error(`generated unsafe tool name: ${name}`);

  return {
    index,
    category: category.id,
    operation,
    complexity,
    definition: {
      type: "function",
      function: {
        name,
        description: [
          `Synthetic ${category.label} fixture: ${operation.replaceAll("_", " ")} one ${category.resource}.`,
          `Use for performance test requests about ${category.purpose}; it never contacts a real service.`,
        ].join(" "),
        parameters: buildParameters(category, operation, complexity),
      },
    },
    handler: {
      kind: "deterministic_fixture_v1",
      key: sha256Hex(`${seed}\0handler\0${index}`).slice(0, 24),
    },
  };
}

function assertCatalogSize(size: number): void {
  if (!Number.isInteger(size) || size < 1 || size > MAX_SYNTHETIC_TOOLS) {
    throw new RangeError(`catalog size must be an integer from 1 through ${MAX_SYNTHETIC_TOOLS}`);
  }
}

export function generateSyntheticTools(
  size = MAX_SYNTHETIC_TOOLS,
  seed: string | number = DEFAULT_SYNTHETIC_PERFORMANCE_TEST_CATALOG_SEED,
): SyntheticTool[] {
  assertCatalogSize(size);
  const normalizedSeed = normalizeSeed(seed);
  const categories = shuffledCategories(normalizedSeed);
  return Array.from({ length: size }, (_, index) =>
    generateTool(index, normalizedSeed, categories),
  );
}

export function generateSyntheticCatalog(options: SyntheticCatalogOptions = {}): SyntheticCatalog {
  const size = options.size ?? MAX_SYNTHETIC_TOOLS;
  const seed = normalizeSeed(options.seed ?? DEFAULT_SYNTHETIC_PERFORMANCE_TEST_CATALOG_SEED);
  const tools = generateSyntheticTools(size, seed);
  return {
    schema_version: TOOL_DISCLOSURE_PERFORMANCE_TEST_CATALOG_SCHEMA_VERSION,
    seed,
    size,
    max_size: MAX_SYNTHETIC_TOOLS,
    tools_sha256: sha256Hex(canonicalJson(tools as unknown as JsonValue)),
    tools,
  };
}

export function generateCatalogPrefix(catalog: SyntheticCatalog, size: number): SyntheticCatalog {
  assertCatalogSize(size);
  if (size > catalog.size) {
    throw new RangeError(`catalog prefix ${size} exceeds source catalog size ${catalog.size}`);
  }
  const tools = catalog.tools.slice(0, size);
  return {
    ...catalog,
    size,
    tools_sha256: sha256Hex(canonicalJson(tools as unknown as JsonValue)),
    tools,
  };
}

export function generateCatalogPrefixes(
  catalog: SyntheticCatalog,
  sizes: readonly number[],
): SyntheticCatalog[] {
  return sizes.map((size) => generateCatalogPrefix(catalog, size));
}

export function toOpenAIFunctionTools(catalog: SyntheticCatalog): OpenAIFunctionTool[] {
  return catalog.tools.map((tool) => tool.definition);
}

export function buildSyntheticArguments(
  tool: SyntheticTool,
  variant = 0,
  overrides: JsonObject = {},
): JsonObject {
  if (!Number.isSafeInteger(variant) || variant < 0) {
    throw new TypeError("argument variant must be a non-negative safe integer");
  }
  const argumentsObject: JsonObject = {
    resource_id: `${tool.category}-${tool.index}-${variant}`,
    query: `${tool.operation.replaceAll("_", " ")} fixture request ${variant}`,
  };
  if (tool.complexity !== "small") {
    argumentsObject.limit = 3 + (variant % 5);
    argumentsObject.include_archived = variant % 2 === 0;
    argumentsObject.tags = [`fixture-${variant % 7}`, tool.category];
  }
  if (tool.complexity === "large") {
    const startDay = 1 + (variant % 300);
    argumentsObject.filters = {
      status: (["active", "pending", "complete"] as const)[variant % 3],
      owner: `owner-${variant % 11}`,
      window: { start_day: startDay, end_day: startDay + 7 },
    };
    argumentsObject.options = {
      sort_order: variant % 2 === 0 ? "ascending" : "descending",
      fields: ["id", "status", "updated_at"],
      explain: true,
    };
    argumentsObject.correlation_id = `correlation-${tool.index}-${variant}`;
  }
  return { ...argumentsObject, ...overrides };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAgainstSchema(value: unknown, schema: JsonSchema, path: string): string[] {
  if (schema.type === "object") {
    if (!isPlainObject(value)) return [`${path} must be an object`];
    const properties = schema.properties ?? {};
    const errors: string[] = [];
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) errors.push(...validateAgainstSchema(value[key], child, `${path}.${key}`));
    }
    return errors;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    const errors: string[] = [];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} item(s)`);
    }
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => canonicalJson(item as JsonValue))).size !== value.length
    ) {
      errors.push(`${path} items must be unique`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(
          ...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`),
        );
      });
    }
    return errors;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    const errors: string[] = [];
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errors.push(`${path} has an invalid format`);
    if (schema.enum && !schema.enum.includes(value))
      errors.push(`${path} must be an allowed value`);
    return errors;
  }
  if (schema.type === "boolean")
    return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a number`];
    const errors: string[] = [];
    if (schema.type === "integer" && !Number.isInteger(value))
      errors.push(`${path} must be an integer`);
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} is below its minimum`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path} is above its maximum`);
    return errors;
  }
  return [`${path} uses an unsupported schema type`];
}

export function validateSyntheticArguments(tool: SyntheticTool, args: unknown): string[] {
  return validateAgainstSchema(args, tool.definition.function.parameters, "arguments");
}

export function syntheticResultNonce(tool: SyntheticTool, args: JsonObject): string {
  const errors = validateSyntheticArguments(tool, args);
  if (errors.length > 0) throw new SyntheticToolInvocationError(errors.join("; "));
  return `nonce_${sha256Hex(`${tool.handler.key}\0${canonicalJson(args)}`).slice(0, 20)}`;
}

export function executeSyntheticTool(tool: SyntheticTool, args: JsonObject): SyntheticToolResult {
  const argumentsSha256 = sha256Hex(canonicalJson(args));
  return {
    ok: true,
    tool_name: tool.definition.function.name,
    category: tool.category,
    operation: tool.operation,
    nonce: syntheticResultNonce(tool, args),
    arguments_sha256: argumentsSha256,
    summary: `${tool.operation.replaceAll("_", " ")} completed for ${String(args.resource_id)}`,
  };
}

export function validateSyntheticCatalog(catalog: SyntheticCatalog): string[] {
  const errors: string[] = [];
  if (catalog.schema_version !== TOOL_DISCLOSURE_PERFORMANCE_TEST_CATALOG_SCHEMA_VERSION) {
    errors.push(`unsupported catalog schema version: ${catalog.schema_version}`);
  }
  if (catalog.size !== catalog.tools.length) errors.push("catalog size does not match tool count");
  if (catalog.max_size !== MAX_SYNTHETIC_TOOLS) errors.push("catalog max_size is not canonical");

  const names = new Set<string>();
  catalog.tools.forEach((tool, index) => {
    const name = tool.definition.function.name;
    if (tool.index !== index)
      errors.push(`tool at position ${index} has non-contiguous index ${tool.index}`);
    if (!TOOL_NAME_PATTERN.test(name)) errors.push(`tool ${index} has unsafe name ${name}`);
    if (names.has(name)) errors.push(`duplicate tool name: ${name}`);
    names.add(name);
    if (tool.definition.type !== "function") errors.push(`tool ${index} is not a function tool`);
    if (tool.definition.function.parameters.additionalProperties !== false) {
      errors.push(`tool ${index} parameters must reject additional properties`);
    }
    if (tool.handler.kind !== "deterministic_fixture_v1") {
      errors.push(`tool ${index} has unsupported handler kind`);
    }
  });

  const expectedHash = sha256Hex(canonicalJson(catalog.tools as unknown as JsonValue));
  if (catalog.tools_sha256 !== expectedHash)
    errors.push("catalog tools_sha256 does not match tools");
  return errors;
}

export function assertValidSyntheticCatalog(catalog: SyntheticCatalog): void {
  const errors = validateSyntheticCatalog(catalog);
  if (errors.length > 0) throw new Error(`invalid synthetic catalog: ${errors.join("; ")}`);
}
