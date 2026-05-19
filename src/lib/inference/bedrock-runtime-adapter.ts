// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
  type Message,
  type SystemContentBlock,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";

import { BEDROCK_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { compactText } from "../core/url-utils";
import { run, runCapture, SCRIPTS } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";
import {
  BEDROCK_RUNTIME_ADAPTER_BIND_HOST,
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
  BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV,
  BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV,
  type CustomAnthropicEndpointClassification,
  resolveBedrockRuntimeRegion,
} from "./bedrock-runtime";

const STATE_DIR = path.join(os.homedir(), ".nemoclaw");
const TOKEN_PATH = path.join(STATE_DIR, "bedrock-runtime-adapter-token");
const PID_PATH = path.join(STATE_DIR, "bedrock-runtime-adapter.pid");
const STATE_PATH = path.join(STATE_DIR, "bedrock-runtime-adapter.json");
const MAX_BODY_BYTES = 2 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
type BedrockRuntimeClientLike = {
  send(command: ConverseCommand | ConverseStreamCommand): Promise<unknown>;
};

type OpenAiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAiMessage = {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
  name?: string;
};

type OpenAiChatRequest = {
  model?: string;
  messages?: OpenAiMessage[];
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: unknown;
  max_tokens?: unknown;
  top_p?: unknown;
  stop?: unknown;
  [key: string]: unknown;
};

type OpenAiChatResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

class AdapterHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "bad_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function badRequest(message: string): never {
  throw new AdapterHttpError(400, message, "unsupported_request");
}

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function writeSecretFile(filePath: string, value: string): void {
  ensureStateDir();
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function readTextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureStateDir();
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function readJsonFile(filePath: string): JsonObject | null {
  const raw = readTextFile(filePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonObject)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function responseId(prefix = "chatcmpl-bedrock"): string {
  return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

function parseJsonObject(value: string, label: string): JsonObject {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      badRequest(`${label} must be a JSON object.`);
    }
    return parsed as JsonObject;
  } catch (err) {
    if (err instanceof AdapterHttpError) throw err;
    badRequest(`${label} must be valid JSON.`);
  }
}

function maybeJsonToolResult(value: string): { json: unknown } | { text: string } {
  const trimmed = value.trim();
  if (!trimmed) return { text: "" };
  try {
    return { json: JSON.parse(trimmed) };
  } catch {
    return { text: value };
  }
}

function textFromOpenAiContent(content: unknown, label: string): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") {
        badRequest(`${label} content arrays may only contain text parts.`);
      }
      const part = item as JsonObject;
      if (part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
        continue;
      }
      badRequest(`${label} content only supports text parts for Bedrock Runtime.`);
    }
    return parts.join("");
  }
  badRequest(`${label} content must be a string or text content array.`);
}

function contentBlocksFromText(content: unknown, label: string): ContentBlock[] {
  const text = textFromOpenAiContent(content, label);
  return text ? [{ text }] : [];
}

function toolResultBlocksFromContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [
      {
        toolResult: {
          toolUseId: "",
          content: [maybeJsonToolResult(content)],
        },
      } as ContentBlock,
    ];
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return [
      {
        toolResult: {
          toolUseId: "",
          content: [{ json: content }],
        },
      } as ContentBlock,
    ];
  }
  const text = textFromOpenAiContent(content, "tool");
  return [
    {
      toolResult: {
        toolUseId: "",
        content: [{ text }],
      },
    } as ContentBlock,
  ];
}

function parseToolArguments(args: unknown, toolName: string): unknown {
  if (args == null || args === "") return {};
  if (typeof args !== "string") {
    badRequest(`tool call '${toolName}' arguments must be a JSON string.`);
  }
  return parseJsonObject(args, `tool call '${toolName}' arguments`);
}

function convertOpenAiMessages(messages: OpenAiMessage[]): {
  messages: Message[];
  system?: SystemContentBlock[];
} {
  const bedrockMessages: Message[] = [];
  const system: SystemContentBlock[] = [];

  for (const message of messages) {
    const role = String(message.role || "").toLowerCase();
    if (role === "system" || role === "developer") {
      const text = textFromOpenAiContent(message.content, role);
      if (text) system.push({ text });
      continue;
    }
    if (role === "user") {
      bedrockMessages.push({
        role: "user",
        content: contentBlocksFromText(message.content, "user"),
      });
      continue;
    }
    if (role === "assistant") {
      const content = contentBlocksFromText(message.content, "assistant");
      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.type && toolCall.type !== "function") {
            badRequest("Only function tool calls are supported for Bedrock Runtime.");
          }
          const name = toolCall.function?.name;
          if (!toolCall.id || !name) {
            badRequest("Assistant tool calls require id and function.name.");
          }
          content.push({
            toolUse: {
              toolUseId: toolCall.id,
              name,
              input: parseToolArguments(toolCall.function?.arguments, name) as any,
            },
          });
        }
      }
      bedrockMessages.push({ role: "assistant", content });
      continue;
    }
    if (role === "tool") {
      const toolUseId = String(message.tool_call_id || "").trim();
      if (!toolUseId) badRequest("Tool result messages require tool_call_id.");
      const blocks = toolResultBlocksFromContent(message.content).map((block) => {
        if ("toolResult" in block && block.toolResult) {
          return {
            toolResult: {
              ...block.toolResult,
              toolUseId,
            },
          };
        }
        return block;
      });
      bedrockMessages.push({ role: "user", content: blocks });
      continue;
    }
    badRequest(`Unsupported message role '${message.role}'.`);
  }

  return { messages: bedrockMessages, system: system.length > 0 ? system : undefined };
}

function convertTools(tools: unknown, toolChoice: unknown): ToolConfiguration | undefined {
  if (tools == null) return undefined;
  if (!Array.isArray(tools)) badRequest("tools must be an array.");
  if (toolChoice === "none") return undefined;

  const converted = tools.map((tool) => {
    if (!tool || typeof tool !== "object") badRequest("Each tool must be an object.");
    const item = tool as JsonObject;
    if (item.type !== "function") badRequest("Only function tools are supported.");
    const fn = item.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
      badRequest("Function tools require a function object.");
    }
    const functionDef = fn as JsonObject;
    if (typeof functionDef.name !== "string" || !functionDef.name) {
      badRequest("Function tools require function.name.");
    }
    const parameters =
      functionDef.parameters && typeof functionDef.parameters === "object"
        ? functionDef.parameters
        : { type: "object", properties: {} };
    return {
      toolSpec: {
        name: functionDef.name,
        description:
          typeof functionDef.description === "string" ? functionDef.description : undefined,
        inputSchema: { json: parameters },
      },
    };
  });

  const toolConfig: ToolConfiguration = { tools: converted as any };
  if (toolChoice === "auto" || toolChoice == null) {
    toolConfig.toolChoice = { auto: {} };
  } else if (toolChoice === "required") {
    toolConfig.toolChoice = { any: {} };
  } else if (toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const choice = toolChoice as JsonObject;
    const fn = choice.function;
    if (choice.type !== "function" || !fn || typeof fn !== "object" || Array.isArray(fn)) {
      badRequest("tool_choice object must target a function tool.");
    }
    const name = (fn as JsonObject).name;
    if (typeof name !== "string" || !name) {
      badRequest("tool_choice function requires a name.");
    }
    toolConfig.toolChoice = { tool: { name } };
  } else {
    badRequest("Unsupported tool_choice value.");
  }
  return toolConfig;
}

function numberField(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    badRequest(`${label} must be a finite number.`);
  }
  return value;
}

function positiveIntegerField(value: unknown, label: string): number | undefined {
  const numberValue = numberField(value, label);
  if (numberValue === undefined) return undefined;
  const integer = Math.trunc(numberValue);
  if (integer <= 0) badRequest(`${label} must be greater than zero.`);
  return integer;
}

function stopSequences(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  badRequest("stop must be a string or string array.");
}

const UNSUPPORTED_OPENAI_FIELDS = [
  "audio",
  "frequency_penalty",
  "function_call",
  "functions",
  "logit_bias",
  "logprobs",
  "metadata",
  "modalities",
  "n",
  "parallel_tool_calls",
  "prediction",
  "presence_penalty",
  "reasoning_effort",
  "response_format",
  "seed",
  "service_tier",
  "store",
  "stream_options",
  "top_logprobs",
  "user",
  "web_search_options",
] as const;

export function buildBedrockConverseRequest(request: OpenAiChatRequest): ConverseCommandInput {
  const unsupported = UNSUPPORTED_OPENAI_FIELDS.filter((field) => request[field] !== undefined);
  if (unsupported.length > 0) {
    badRequest(`Unsupported OpenAI chat field(s) for Bedrock Runtime: ${unsupported.join(", ")}.`);
  }
  if (typeof request.model !== "string" || !request.model.trim()) {
    badRequest("model is required.");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    badRequest("messages must be a non-empty array.");
  }

  const converted = convertOpenAiMessages(request.messages);
  const input: ConverseCommandInput = {
    modelId: request.model,
    messages: converted.messages,
    system: converted.system,
    inferenceConfig: {
      temperature: numberField(request.temperature, "temperature"),
      maxTokens: positiveIntegerField(request.max_tokens, "max_tokens"),
      topP: numberField(request.top_p, "top_p"),
      stopSequences: stopSequences(request.stop),
    },
    toolConfig: convertTools(request.tools, request.tool_choice),
  };
  const inferenceConfig = input.inferenceConfig;
  if (
    inferenceConfig?.temperature === undefined &&
    inferenceConfig?.maxTokens === undefined &&
    inferenceConfig?.topP === undefined &&
    inferenceConfig?.stopSequences === undefined
  ) {
    delete input.inferenceConfig;
  }
  return input;
}

function finishReason(stopReason: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls || stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "stop_sequence" || stopReason === "end_turn") return "stop";
  return "stop";
}

function usageFromResponse(output: ConverseCommandOutput): OpenAiChatResponse["usage"] {
  const usage = output.usage;
  if (!usage) return undefined;
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
  };
}

export function convertBedrockConverseResponse(
  output: ConverseCommandOutput,
  model: string,
): OpenAiChatResponse {
  const content = output.output?.message?.content ?? [];
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const block of content) {
    if ("text" in block && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if ("toolUse" in block && block.toolUse) {
      const toolUse = block.toolUse;
      toolCalls.push({
        id: toolUse.toolUseId || responseId("toolu"),
        type: "function",
        function: {
          name: toolUse.name || "",
          arguments: stableJson(toolUse.input ?? {}),
        },
      });
    }
  }

  const message: OpenAiChatResponse["choices"][number]["message"] = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: responseId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason(output.stopReason, toolCalls.length > 0),
      },
    ],
    usage: usageFromResponse(output),
  };
}

function streamChunk(
  model: string,
  completionId: string,
  delta: JsonObject,
  finishReasonValue: string | null = null,
): JsonObject {
  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReasonValue,
      },
    ],
  };
}

export async function* convertBedrockConverseStream(
  stream: AsyncIterable<ConverseStreamOutput> | undefined,
  model: string,
): AsyncGenerator<JsonObject> {
  if (!stream) return;
  const completionId = responseId();
  const toolIndexes = new Map<number, number>();
  let nextToolIndex = 0;
  let emittedRole = false;

  for await (const event of stream) {
    if (event.messageStart) {
      emittedRole = true;
      yield streamChunk(model, completionId, { role: "assistant" });
      continue;
    }
    if (!emittedRole && (event.contentBlockStart || event.contentBlockDelta)) {
      emittedRole = true;
      yield streamChunk(model, completionId, { role: "assistant" });
    }
    if (event.contentBlockStart?.start && "toolUse" in event.contentBlockStart.start) {
      const toolUse = event.contentBlockStart.start.toolUse;
      if (!toolUse) continue;
      const index = nextToolIndex++;
      toolIndexes.set(event.contentBlockStart.contentBlockIndex ?? index, index);
      yield streamChunk(model, completionId, {
        tool_calls: [
          {
            index,
            id: toolUse.toolUseId,
            type: "function",
            function: { name: toolUse.name, arguments: "" },
          },
        ],
      });
      continue;
    }
    if (event.contentBlockDelta?.delta) {
      const delta = event.contentBlockDelta.delta;
      if ("text" in delta && typeof delta.text === "string") {
        yield streamChunk(model, completionId, { content: delta.text });
        continue;
      }
      if ("toolUse" in delta && delta.toolUse?.input) {
        const index = toolIndexes.get(event.contentBlockDelta.contentBlockIndex ?? -1) ?? 0;
        yield streamChunk(model, completionId, {
          tool_calls: [
            {
              index,
              function: { arguments: delta.toolUse.input },
            },
          ],
        });
      }
      continue;
    }
    if (event.messageStop) {
      yield streamChunk(
        model,
        completionId,
        {},
        finishReason(event.messageStop.stopReason, toolIndexes.size > 0),
      );
      continue;
    }
    const serviceError =
      event.internalServerException ||
      event.modelStreamErrorException ||
      event.serviceUnavailableException ||
      event.throttlingException ||
      event.validationException;
    if (serviceError) {
      throw new Error(serviceError.message || "Bedrock Runtime stream error");
    }
  }
}

export async function createOpenAiChatCompletion(
  request: OpenAiChatRequest,
  client: BedrockRuntimeClientLike,
): Promise<OpenAiChatResponse> {
  const input = buildBedrockConverseRequest(request);
  const output = (await client.send(new ConverseCommand(input))) as ConverseCommandOutput;
  return convertBedrockConverseResponse(output, input.modelId || request.model || "");
}

export async function streamOpenAiChatCompletion(
  request: OpenAiChatRequest,
  client: BedrockRuntimeClientLike,
): Promise<AsyncGenerator<JsonObject>> {
  const input = buildBedrockConverseRequest(request) as ConverseStreamCommandInput;
  const output = (await client.send(new ConverseStreamCommand(input))) as {
    stream?: AsyncIterable<ConverseStreamOutput>;
  };
  return convertBedrockConverseStream(output.stream, input.modelId || request.model || "");
}

function authMatches(actual: string | string[] | undefined, token: string): boolean {
  const header = Array.isArray(actual) ? actual[0] : actual;
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function adapterTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof AdapterHttpError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Bedrock Runtime request failed.";
}

function sendError(res: http.ServerResponse, err: unknown): void {
  const status = err instanceof AdapterHttpError ? err.status : 502;
  const code = err instanceof AdapterHttpError ? err.code : "bedrock_runtime_error";
  const message = safeErrorMessage(err);
  sendJson(res, status, {
    error: {
      message: compactText(message),
      type: code,
      code,
    },
  });
}

function readRequestJson(req: http.IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AdapterHttpError(413, "Request body is too large.", "request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(parseJsonObject(Buffer.concat(chunks).toString("utf8"), "request body"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function createBedrockRuntimeAdapterServer(options: {
  token: string;
  client: BedrockRuntimeClientLike;
  endpointUrl: string;
  region: string;
}): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          endpointUrl: options.endpointUrl,
          region: options.region,
          tokenHash: adapterTokenHash(options.token),
        });
        return;
      }
      if (!authMatches(req.headers.authorization, options.token)) {
        sendJson(res, 401, {
          error: { message: "Unauthorized", type: "unauthorized", code: "unauthorized" },
        });
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        sendJson(res, 404, {
          error: { message: "Not found", type: "not_found", code: "not_found" },
        });
        return;
      }

      const body = (await readRequestJson(req)) as OpenAiChatRequest;
      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunks = await streamOpenAiChatCompletion(body, options.client);
        for await (const chunk of chunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const response = await createOpenAiChatCompletion(body, options.client);
      sendJson(res, 200, response);
    } catch (err) {
      if (!res.headersSent) {
        sendError(res, err);
      } else {
        res.write(
          `data: ${JSON.stringify({ error: { message: compactText(safeErrorMessage(err)) } })}\n\n`,
        );
        res.end();
      }
    }
  });
}

export function startBedrockRuntimeAdapterFromEnv(): http.Server {
  const token = process.env[BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV];
  const endpointUrl = process.env.NEMOCLAW_BEDROCK_RUNTIME_ENDPOINT_URL;
  const region = process.env.NEMOCLAW_BEDROCK_RUNTIME_REGION || process.env.AWS_REGION;
  const port = Number(process.env.NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT || BEDROCK_RUNTIME_ADAPTER_PORT);

  if (!token) throw new Error(`${BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV} is required`);
  if (!endpointUrl) throw new Error("NEMOCLAW_BEDROCK_RUNTIME_ENDPOINT_URL is required");
  if (!region) throw new Error("NEMOCLAW_BEDROCK_RUNTIME_REGION or AWS_REGION is required");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT must be a valid port");
  }

  const client = new BedrockRuntimeClient({ region, endpoint: endpointUrl });
  const server = createBedrockRuntimeAdapterServer({ token, client, endpointUrl, region });
  server.listen(port, BEDROCK_RUNTIME_ADAPTER_BIND_HOST, () => {
    console.log(
      `Bedrock Runtime adapter listening on ${BEDROCK_RUNTIME_ADAPTER_BIND_HOST}:${port} -> ${endpointUrl}`,
    );
  });
  return server;
}

function loadPersistedPid(): number | null {
  const raw = readTextFile(PID_PATH);
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAdapterProcess(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  const cmdline = runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true });
  return Boolean(cmdline && cmdline.includes("bedrock-runtime-adapter.js"));
}

function killStaleAdapter(): void {
  const persistedPid = loadPersistedPid();
  if (isAdapterProcess(persistedPid)) {
    run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
  }
  try {
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  } catch {
    /* ignore */
  }
}

function getAdapterScriptPath(): string {
  const scriptsDir = typeof SCRIPTS === "string" ? SCRIPTS : path.join(process.cwd(), "scripts");
  return path.join(scriptsDir, "bedrock-runtime-adapter.js");
}

function copyAwsEnv(extra: Record<string, string>): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.startsWith("AWS_")) {
      extra[key] = value;
    }
  }
}

function forwardedAwsEnvSnapshot(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.startsWith("AWS_")) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function adapterCredentialHash(options: {
  endpointUrl: string;
  region: string;
  compatibleCredential: string | null;
}): string {
  const values: Record<string, string | null> = {
    endpointUrl: options.endpointUrl,
    region: options.region,
    compatibleCredential: options.compatibleCredential,
    ...forwardedAwsEnvSnapshot(),
  };
  return crypto.createHash("sha256").update(stableJson(values)).digest("hex");
}

function probeAdapterHealth(options: {
  port?: number;
  tokenHash?: string | null;
} = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const tokenHash = options.tokenHash || null;
    const port = options.port || BEDROCK_RUNTIME_ADAPTER_PORT;
    const req = http.request(
      {
        hostname: BEDROCK_RUNTIME_ADAPTER_BIND_HOST,
        port,
        path: "/health",
        method: "GET",
        timeout: 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          if (!tokenHash) {
            resolve(true);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tokenHash?: unknown };
            resolve(body.tokenHash === tokenHash);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function waitForAdapterHealth(token: string, port = BEDROCK_RUNTIME_ADAPTER_PORT): Promise<boolean> {
  const tokenHash = adapterTokenHash(token);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await probeAdapterHealth({ port, tokenHash })) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function ensureBedrockRuntimeAdapter(options: {
  classification: Extract<CustomAnthropicEndpointClassification, { kind: "bedrock-runtime" }>;
  compatibleCredential?: string | null;
}): Promise<{
  baseUrl: string;
  credentialEnv: string;
  token: string;
  region: string;
}> {
  const region = resolveBedrockRuntimeRegion(options.classification);
  const endpointUrl = options.classification.endpointUrl;
  const compatibleCredential = options.compatibleCredential || null;
  const credentialHash = adapterCredentialHash({ endpointUrl, region, compatibleCredential });
  const priorState = readJsonFile(STATE_PATH);
  const priorToken = readTextFile(TOKEN_PATH);
  const priorPid = loadPersistedPid();
  if (
    priorToken &&
    isAdapterProcess(priorPid) &&
    priorState?.endpointUrl === endpointUrl &&
    priorState?.region === region &&
    priorState?.credentialHash === credentialHash &&
    (await probeAdapterHealth({ tokenHash: adapterTokenHash(priorToken) }))
  ) {
    process.env[BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV] = priorToken;
    return {
      baseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      credentialEnv: BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
      token: priorToken,
      region,
    };
  }

  killStaleAdapter();
  const token = crypto.randomBytes(24).toString("hex");
  const childEnv: Record<string, string> = {
    NEMOCLAW_BEDROCK_RUNTIME_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_BEDROCK_RUNTIME_REGION: region,
    NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT: String(BEDROCK_RUNTIME_ADAPTER_PORT),
    [BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV]: token,
    AWS_REGION: process.env.AWS_REGION || region,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || region,
  };
  copyAwsEnv(childEnv);
  if (compatibleCredential && !childEnv[BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV]) {
    childEnv[BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV] = compatibleCredential;
  }

  const child = spawn(process.execPath, [getAdapterScriptPath()], {
    detached: true,
    stdio: "ignore",
    env: buildSubprocessEnv(childEnv),
  });
  child.unref();
  if (child.pid) writeSecretFile(PID_PATH, String(child.pid));

  if (!(await waitForAdapterHealth(token))) {
    throw new Error(
      `Bedrock Runtime adapter did not become healthy on ${BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL}`,
    );
  }

  writeSecretFile(TOKEN_PATH, token);
  writeJsonFile(STATE_PATH, {
    endpointUrl,
    region,
    credentialHash,
    pid: child.pid ?? null,
    updatedAt: new Date().toISOString(),
  });
  process.env[BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV] = token;

  return {
    baseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    credentialEnv: BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
    token,
    region,
  };
}

export function getCompatibleAnthropicCredentialForBedrock(): string | null {
  return process.env[BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV]?.trim() || null;
}

export const __test = {
  adapterCredentialHash,
};
