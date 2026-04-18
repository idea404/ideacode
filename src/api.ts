import * as crypto from "node:crypto";
import { config, type OpenAiCompatProvider } from "./config.js";
import { makeSchema } from "./tools/index.js";

export type ContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
};

export type OpenRouterModel = {
  id: string;
  name?: string;
  context_length?: number;
  description?: string;
};

export type ModelsResponse = {
  data: OpenRouterModel[];
};

/** Prefixed model ids route to `POST .../chat/completions` instead of OpenRouter `/messages`. */
export const OAIC_MODEL_PREFIX = "oaic:";

export type CallApiRoute =
  | { kind: "openrouter"; apiKey: string }
  | { kind: "oaic"; baseUrl: string; apiKey?: string };

export type SummarizeRoute =
  | { kind: "openrouter"; apiKey: string }
  | { kind: "oaic"; baseUrl: string; apiKey?: string };

type OpenAiChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const MAX_RETRIES = 8;

/** vLLM Hermes streaming parser sometimes leaves extra `<tool_call>` blocks in `content`; parse them here. */
const HERMES_TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

function oaicRequestTemperature(): number {
  const raw = process.env.IDEACODE_OAIC_TEMPERATURE?.trim();
  if (raw === undefined || raw === "") return 0.2;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0.2;
  return Math.min(2, Math.max(0, n));
}

function toolUseDedupeKey(name: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of keys) normalized[k] = input[k];
  return `${name}\0${JSON.stringify(normalized)}`;
}

/**
 * Pull Hermes-format tool calls out of plain assistant text so they become structured `tool_use`
 * blocks (avoids re-sending XML in the next request and fixes partial vLLM parser output).
 */
function extractHermesToolCallsFromPlainText(text: string): { stripped: string; blocks: ContentBlock[] } {
  const blocks: ContentBlock[] = [];
  if (!text || !/<tool_call>/i.test(text)) {
    return { stripped: text, blocks: [] };
  }
  const re = new RegExp(HERMES_TOOL_CALL_PATTERN.source, HERMES_TOOL_CALL_PATTERN.flags);
  const stripped = text
    .replace(re, (_full, inner: string) => {
      const trimmed = String(inner).trim();
      if (!trimmed) return "";
      let parsed: { name?: string; arguments?: unknown; parameters?: unknown };
      try {
        parsed = JSON.parse(trimmed) as typeof parsed;
      } catch {
        return "";
      }
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      if (!name) return "";
      const rawArgs = parsed.arguments ?? parsed.parameters;
      let input: Record<string, unknown> = {};
      if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        input = rawArgs as Record<string, unknown>;
      }
      const id = `hermes_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      blocks.push({ type: "tool_use", id, name, input });
      return "";
    })
    .replace(/[ \t]*\n[ \t]*\n[ \t]*/g, "\n\n")
    .trim();
  return { stripped, blocks };
}
const INITIAL_BACKOFF_MS = 1200;
const MAX_BACKOFF_MS = 30_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** Retries for fetch(models) when the connection drops before a response. */
const MODELS_FETCH_MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const retrySeconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
      return Math.max(1000, Math.min(MAX_BACKOFF_MS, Math.round(retrySeconds * 1000)));
    }
  }
  const base = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * Math.pow(2, attempt));
  const jitter = 0.75 + Math.random() * 0.5; // 0.75x .. 1.25x
  return Math.max(1000, Math.round(base * jitter));
}

/** True when fetch() failed before an HTTP response (Wi‑Fi blip, TLS, DNS, reset, etc.). */
function isRetryableNetworkFailure(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof Error && err.name === "AbortError") return false;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") return false;
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes("fetch failed")) return true;
    if (m.includes("socket hang up")) return true;
    if (m.includes("econnreset")) return true;
    if (m.includes("etimedout")) return true;
    if (m.includes("econnrefused")) return true;
    if (m.includes("enotfound")) return true;
    if (m.includes("eai_again")) return true;
    if (m.includes("network error")) return true;
    if (err.cause !== undefined) return isRetryableNetworkFailure(err.cause);
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = String((err as { code?: unknown }).code ?? "");
    if (
      ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED", "EPROTO"].includes(code) ||
      code.startsWith("UND_ERR_")
    ) {
      return true;
    }
  }
  return false;
}

function parseUsdField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Remaining balance in USD for the footer: tries account credits first, then `/key` fields.
 *
 * - `GET /credits` returns `total_credits` and `total_usage` (remaining = credits − usage). Docs say a
 *   [management key](https://openrouter.ai/docs/guides/overview/auth/management-api-keys) may be required;
 *   many setups still work with the same bearer key — we try and ignore 403.
 * - `GET /key` exposes `limit_remaining` only when a per-key **spending limit** exists; otherwise it is
 *   often `null` even if the account has prepaid balance. We then use `limit - usage` when both are set.
 */
export async function fetchKeyCreditsRemaining(apiKey: string): Promise<number | null> {
  const key = apiKey.trim();
  if (!key) return null;
  try {
    const creditsRes = await fetch(config.creditsUrl, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (creditsRes.ok) {
      const creditsJson = (await creditsRes.json()) as {
        data?: { total_credits?: unknown; total_usage?: unknown };
      };
      const total = parseUsdField(creditsJson.data?.total_credits);
      const used = parseUsdField(creditsJson.data?.total_usage);
      if (total !== null && used !== null) return Math.max(0, total - used);
    }

    const keyRes = await fetch(config.keyInfoUrl, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!keyRes.ok) return null;
    const keyJson = (await keyRes.json()) as {
      data?: {
        limit_remaining?: unknown;
        limit?: unknown;
        usage?: unknown;
      };
    };
    const d = keyJson.data;
    if (!d) return null;

    const remaining = parseUsdField(d.limit_remaining);
    if (remaining !== null) return remaining;

    const limit = parseUsdField(d.limit);
    const usage = parseUsdField(d.usage);
    if (limit !== null && usage !== null) return Math.max(0, limit - usage);

    return null;
  } catch {
    return null;
  }
}

export async function fetchModels(apiKey: string): Promise<OpenRouterModel[]> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MODELS_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(config.modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch models: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as ModelsResponse;
      return json.data ?? [];
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MODELS_FETCH_MAX_ATTEMPTS - 1 && isRetryableNetworkFailure(err)) {
        await sleep(computeRetryDelayMs(attempt, null));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("Failed to fetch models");
}

/**
 * Normalize user input to an OpenAI-style base URL ending with `/v1` (no trailing slash after v1).
 */
export function normalizeOpenAiBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Base URL is empty");
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const u = new URL(withProto);
  let path = u.pathname.replace(/\/$/, "");
  if (!path.endsWith("/v1")) {
    path = `${path || ""}/v1`.replace(/\/+/g, "/");
    if (!path.startsWith("/")) path = `/${path}`;
  }
  u.pathname = path;
  return `${u.origin}${u.pathname}`;
}

/** Match legacy model ids that used the config UUID instead of the display slug. */
const OAIC_PROVIDER_KEY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveOaicProvider(
  providers: OpenAiCompatProvider[],
  providerKey: string
): OpenAiCompatProvider | undefined {
  if (OAIC_PROVIDER_KEY_UUID.test(providerKey)) {
    return providers.find((p) => p.id === providerKey);
  }
  return providers.find((p) => p.slug === providerKey);
}

export function formatOaicModelId(providerSlug: string, openAiModelId: string): string {
  return `${OAIC_MODEL_PREFIX}${providerSlug}/${openAiModelId}`;
}

/**
 * Parse `oaic:<providerSlug|legacyUuid>/<openAiModelId>` (model id may contain slashes).
 */
export function parseOaicModelId(fullId: string): { providerKey: string; openAiModelId: string } | null {
  if (!fullId.startsWith(OAIC_MODEL_PREFIX)) return null;
  const rest = fullId.slice(OAIC_MODEL_PREFIX.length);
  const i = rest.indexOf("/");
  if (i <= 0 || i >= rest.length - 1) return null;
  return { providerKey: rest.slice(0, i), openAiModelId: rest.slice(i + 1) };
}

/** Rewrite `oaic:<uuid>/…` saved ids to `oaic:<slug>/…` when possible. */
export function maybeMigrateOaicModelId(
  fullModelId: string,
  providers: OpenAiCompatProvider[]
): string {
  const parsed = parseOaicModelId(fullModelId);
  if (!parsed) return fullModelId;
  const p = resolveOaicProvider(providers, parsed.providerKey);
  if (!p) return fullModelId;
  const upgraded = formatOaicModelId(p.slug, parsed.openAiModelId);
  return upgraded === fullModelId ? fullModelId : upgraded;
}

function makeOpenAiToolsFromSchema(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return makeSchema().map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: t.input_schema.type,
        properties: t.input_schema.properties,
        required: t.input_schema.required,
      },
    },
  }));
}

function convertIdeacodeMessagesToOpenAi(
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string
): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = [];
  if (systemPrompt.trim()) {
    out.push({ role: "system", content: systemPrompt });
  }
  for (const m of messages) {
    if (m.role === "user") {
      const c = m.content;
      if (typeof c === "string") {
        out.push({ role: "user", content: c });
      } else if (Array.isArray(c)) {
        for (const item of c) {
          if (!item || typeof item !== "object") continue;
          const t = (item as { type?: string }).type;
          if (t === "tool_result") {
            const tr = item as { tool_use_id?: string; content?: unknown };
            const id = tr.tool_use_id ?? "";
            const text =
              typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "");
            out.push({ role: "tool", tool_call_id: id, content: text });
          }
        }
      }
    } else if (m.role === "assistant") {
      const c = m.content;
      if (typeof c === "string") {
        const { stripped, blocks: hb } = extractHermesToolCallsFromPlainText(c);
        if (hb.length > 0) {
          const toolCalls: OpenAiToolCall[] = hb.map((tu) => ({
            id: tu.id!,
            type: "function",
            function: { name: tu.name!, arguments: JSON.stringify(tu.input ?? {}) },
          }));
          out.push({
            role: "assistant",
            content: stripped.trim() ? stripped : null,
            tool_calls: toolCalls,
          });
        } else if (c.trim()) {
          out.push({ role: "assistant", content: c });
        }
        continue;
      }
      if (!Array.isArray(c)) continue;
      let textParts = "";
      const toolCalls: OpenAiToolCall[] = [];
      for (const b of c) {
        if (!b || typeof b !== "object") continue;
        const typ = (b as { type?: string }).type;
        if (typ === "text") {
          const tx = (b as { text?: string }).text;
          if (tx) textParts += tx;
        } else if (typ === "tool_use") {
          const name = (b as { name?: string }).name;
          const input = (b as { input?: Record<string, unknown> }).input ?? {};
          const id =
            (b as { id?: string }).id?.trim() ||
            `tool_${Math.random().toString(36).slice(2, 14)}`;
          if (name) {
            toolCalls.push({
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            });
          }
        }
      }
      const hermesExtra = extractHermesToolCallsFromPlainText(textParts);
      textParts = hermesExtra.stripped;
      for (const tu of hermesExtra.blocks) {
        toolCalls.push({
          id: tu.id!,
          type: "function",
          function: { name: tu.name!, arguments: JSON.stringify(tu.input ?? {}) },
        });
      }
      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: textParts.trim() ? textParts : null,
          tool_calls: toolCalls,
        });
      } else if (textParts.trim()) {
        out.push({ role: "assistant", content: textParts });
      }
    }
  }
  return out;
}

function parseOpenAiChatCompletion(json: unknown): { content?: ContentBlock[] } {
  const choices = (json as { choices?: Array<{ message?: Record<string, unknown> }> }).choices;
  const msg = choices?.[0]?.message;
  if (!msg) return { content: [] };
  const blocks: ContentBlock[] = [];
  const deduped = new Set<string>();

  const apiToolBlocks: ContentBlock[] = [];
  const toolCalls = msg.tool_calls as
    | Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>
    | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const id = tc.id;
      const fn = tc.function;
      const name = fn?.name;
      if (!id || !name) continue;
      let input: Record<string, unknown> = {};
      if (typeof fn.arguments === "string" && fn.arguments.trim()) {
        try {
          input = JSON.parse(fn.arguments) as Record<string, unknown>;
        } catch {
          input = {};
        }
      }
      apiToolBlocks.push({ type: "tool_use", id, name, input });
      deduped.add(toolUseDedupeKey(name, input));
    }
  }

  let contentStr = "";
  const content = msg.content;
  if (typeof content === "string") {
    contentStr = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; text?: string };
      if (p.type === "text" && typeof p.text === "string") {
        contentStr += p.text;
      }
    }
  }

  const { stripped, blocks: hermesBlocks } = extractHermesToolCallsFromPlainText(contentStr);
  const hermesFiltered = hermesBlocks.filter((b) => {
    if (b.type !== "tool_use" || !b.name) return false;
    const k = toolUseDedupeKey(b.name, (b.input ?? {}) as Record<string, unknown>);
    if (deduped.has(k)) return false;
    deduped.add(k);
    return true;
  });

  if (stripped.trim()) {
    blocks.push({ type: "text", text: stripped });
  }
  for (const b of apiToolBlocks) {
    blocks.push(b);
  }
  for (const b of hermesFiltered) {
    blocks.push(b);
  }
  return { content: blocks };
}

function pickPositiveTokenInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  return undefined;
}

/** Best-effort context window from non-OpenRouter `/v1/models` rows (OpenAI, llama.cpp server, etc.). */
function contextLengthFromOaicModelRow(row: Record<string, unknown>): number | undefined {
  const direct =
    pickPositiveTokenInt(row.context_length) ??
    pickPositiveTokenInt(row.max_model_len) ??
    pickPositiveTokenInt(row.n_ctx) ??
    pickPositiveTokenInt(row.n_ctx_train);
  if (direct) return direct;
  const meta = row.meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>;
    return (
      pickPositiveTokenInt(m.n_ctx_train) ??
      pickPositiveTokenInt(m.n_ctx) ??
      pickPositiveTokenInt(m.context_length)
    );
  }
  return undefined;
}

type OaicModelListRow = { id: string; context_length?: number };

async function fetchOpenAiCompatModels(baseUrl: string, apiKey?: string): Promise<OaicModelListRow[]> {
  const root = baseUrl.replace(/\/$/, "");
  const url = `${root}/models`;
  const headers: Record<string, string> = {};
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`models ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    data?: Array<Record<string, unknown>>;
    /** Some servers (e.g. Ollama-style) list models here without `data`. */
    models?: Array<Record<string, unknown>>;
  };
  const fromData = json.data ?? [];
  const fromModels = json.models ?? [];
  const rows =
    fromData.length > 0
      ? fromData
      : fromModels.map((m) => {
          const id = m.model ?? m.name ?? m.id;
          return typeof id === "string" ? { ...m, id } : m;
        });
  const out: OaicModelListRow[] = [];
  for (const r of rows) {
    const id = r.id;
    if (typeof id !== "string" || !id.trim()) continue;
    const context_length = contextLengthFromOaicModelRow(r);
    out.push(context_length != null ? { id, context_length } : { id });
  }
  return out;
}

/**
 * OpenRouter models (when `openRouterKey` is set) plus models from each OpenAI-compatible provider.
 */
export async function fetchAllModels(
  openRouterKey: string | undefined,
  providers: OpenAiCompatProvider[]
): Promise<OpenRouterModel[]> {
  const out: OpenRouterModel[] = [];
  const key = openRouterKey?.trim();
  if (key) {
    try {
      out.push(...(await fetchModels(key)));
    } catch {
      // Missing OpenRouter is OK when using only custom endpoints.
    }
  }
  for (const p of providers) {
    try {
      const rows = await fetchOpenAiCompatModels(p.baseUrl, p.apiKey);
      for (const row of rows) {
        out.push({
          id: formatOaicModelId(p.slug, row.id),
          name: `[${p.name}] ${row.id}`,
          ...(row.context_length != null ? { context_length: row.context_length } : {}),
        });
      }
    } catch {
      // Skip unreachable or nonstandard servers.
    }
  }
  return out;
}

async function postOpenAiChatCompletions(
  baseUrl: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  callbacks?: {
    onRetry?: (info: { attempt: number; maxAttempts: number; waitMs: number; status: number }) => void;
  }
): Promise<Response> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (fetchErr) {
      lastError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
      if (isRetryableNetworkFailure(fetchErr) && attempt < MAX_RETRIES) {
        const waitMs = computeRetryDelayMs(attempt, null);
        callbacks?.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
          waitMs,
          status: 0,
        });
        await sleep(waitMs);
        continue;
      }
      throw new Error(
        `OpenAI-compatible connection failed${isRetryableNetworkFailure(fetchErr) ? " after retries" : ""}: ${lastError.message}`
      );
    }
    if (res.ok) return res;
    const text = await res.text();
    lastError = new Error(`API ${res.status}: ${text}`);
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = computeRetryDelayMs(attempt, retryAfter);
      callbacks?.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: MAX_RETRIES + 1,
        waitMs,
        status: res.status,
      });
      await sleep(waitMs);
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

export async function callApi(
  route: CallApiRoute,
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  requestModel: string,
  callbacks?: {
    /** `status` is HTTP code when retrying 5xx/429, or `0` when retrying a dropped connection (fetch failed). */
    onRetry?: (info: { attempt: number; maxAttempts: number; waitMs: number; status: number }) => void;
  }
): Promise<{ content?: ContentBlock[] }> {
  if (route.kind === "openrouter") {
    const body = {
      model: requestModel,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
      tools: makeSchema(),
    };
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(config.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${route.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (fetchErr) {
        lastError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
        if (isRetryableNetworkFailure(fetchErr) && attempt < MAX_RETRIES) {
          const waitMs = computeRetryDelayMs(attempt, null);
          callbacks?.onRetry?.({
            attempt: attempt + 1,
            maxAttempts: MAX_RETRIES + 1,
            waitMs,
            status: 0,
          });
          await sleep(waitMs);
          continue;
        }
        throw new Error(
          `OpenRouter connection failed${isRetryableNetworkFailure(fetchErr) ? " after retries" : ""}: ${lastError.message}`
        );
      }
      if (res.ok) return res.json() as Promise<{ content?: ContentBlock[] }>;
      const text = await res.text();
      lastError = new Error(`API ${res.status}: ${text}`);
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get("retry-after");
        const waitMs = computeRetryDelayMs(attempt, retryAfter);
        callbacks?.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
          waitMs,
          status: res.status,
        });
        await sleep(waitMs);
        continue;
      }
      throw lastError;
    }
    throw lastError;
  }

  const oaMessages = convertIdeacodeMessagesToOpenAi(messages, systemPrompt);
  const body = {
    model: requestModel,
    max_tokens: 8192,
    messages: oaMessages,
    tools: makeOpenAiToolsFromSchema(),
    tool_choice: "auto" as const,
    /** Non-streaming avoids vLLM Hermes parser gaps (e.g. multiple `<tool_call>` in one chunk). */
    stream: false as const,
    /** Lower default reduces malformed Hermes tool markup; override with IDEACODE_OAIC_TEMPERATURE. */
    temperature: oaicRequestTemperature(),
  };
  const res = await postOpenAiChatCompletions(route.baseUrl, route.apiKey, body, callbacks);
  const json = (await res.json()) as unknown;
  return parseOpenAiChatCompletion(json);
}

export type StreamCallbacks = {
  onTextDelta: (delta: string) => void;
  onToolCall: (block: { id: string; name: string; input: Record<string, unknown> }) => Promise<string>;
};

function parseStreamChunk(line: string): Record<string, unknown> | null {
  if (line.startsWith("data: ")) {
    const data = line.slice(6).trim();
    if (data === "[DONE]") return { __done: true };
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

type ToolAccum = { id?: string; name?: string; arguments: string };

export async function callApiStream(
  apiKey: string,
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  model: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<ContentBlock[]> {
  const chatMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages,
  ];
  const body = {
    model,
    max_tokens: 8192,
    messages: chatMessages,
    tools: makeSchema(),
    stream: true,
  };
  let res!: Response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await fetch(config.chatCompletionsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      break;
    } catch (fetchErr) {
      if (signal?.aborted) throw fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
      if (isRetryableNetworkFailure(fetchErr) && attempt < MAX_RETRIES) {
        await sleep(computeRetryDelayMs(attempt, null));
        continue;
      }
      throw fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
    }
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  const contentBlocks: ContentBlock[] = [];
  let textAccum = "";
  let textBlockIndex = -1;
  const toolAccum: ToolAccum[] = [];

  const tryEmitToolCall = async (index: number): Promise<boolean> => {
    const t = toolAccum[index];
    if (!t?.id || !t?.name) return false;
    let args: Record<string, unknown> = {};
    if (t.arguments.trim()) {
      try {
        args = JSON.parse(t.arguments) as Record<string, unknown>;
      } catch {
        return false;
      }
    }
    await callbacks.onToolCall({ id: t.id, name: t.name, input: args });
    contentBlocks.push({ type: "tool_use", id: t.id, name: t.name, input: args });
    toolAccum[index] = { arguments: "" };
    return true;
  };

  const flushRemainingToolCalls = async (): Promise<void> => {
    for (let i = 0; i < toolAccum.length; i++) {
      if (toolAccum[i]?.id && toolAccum[i]?.name) await tryEmitToolCall(i);
    }
  };

  const finish = (): ContentBlock[] => {
    if (textBlockIndex >= 0) (contentBlocks[textBlockIndex] as { text?: string }).text = textAccum;
    else if (textAccum.trim()) contentBlocks.unshift({ type: "text", text: textAccum });
    return contentBlocks;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    let batch = "";
    for (const line of lines) {
      const parsed = parseStreamChunk(line);
      if (!parsed) continue;
      if ("__done" in parsed && parsed.__done === true) {
        if (batch) callbacks.onTextDelta(batch);
        await flushRemainingToolCalls();
        return finish();
      }
      const choices = parsed.choices as Array<{
        delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; name?: string; arguments?: string }> };
        finish_reason?: string;
      }> | undefined;
      const delta = choices?.[0]?.delta;
      const finishReason = choices?.[0]?.finish_reason;
      if (typeof delta?.content === "string" && delta.content) {
        textAccum += delta.content;
        batch += delta.content;
        if (textBlockIndex < 0) {
          contentBlocks.push({ type: "text", text: textAccum });
          textBlockIndex = contentBlocks.length - 1;
        } else {
          (contentBlocks[textBlockIndex] as { text?: string }).text = textAccum;
        }
      }
      const tc = delta?.tool_calls;
      if (Array.isArray(tc)) {
        for (const d of tc) {
          const i = d.index ?? 0;
          if (!toolAccum[i]) toolAccum[i] = { arguments: "" };
          if (d.id) toolAccum[i]!.id = d.id;
          if (d.name) toolAccum[i]!.name = d.name;
          if (typeof d.arguments === "string") toolAccum[i]!.arguments += d.arguments;
        }
        for (let i = 0; i < toolAccum.length; i++) {
          await tryEmitToolCall(i);
        }
      }
      if (finishReason) {
        if (batch) callbacks.onTextDelta(batch);
        await flushRemainingToolCalls();
        return finish();
      }
    }
    if (batch) callbacks.onTextDelta(batch);
  }
  await flushRemainingToolCalls();
  return finish();
}

const SUMMARIZE_SAFETY_TOKENS = 3072;
/** When model context is unknown, assume this window for chunk sizing (conservative). */
const SUMMARIZE_DEFAULT_CONTEXT_TOKENS = 128 * 1024;
/** Map phase: each chunk summary may use up to this fraction of the model context (output). */
const CHUNK_OUTPUT_FRACTION = 0.12;
/** Intermediate merge: partial combine before the last reduction. */
const MERGE_INTERMEDIATE_OUTPUT_FRACTION = 0.15;
/** Final merge (single batch): up to this fraction of context for the aggregated summary. */
const MERGE_FINAL_OUTPUT_FRACTION = 0.3;
const SUMMARIZE_OUTPUT_HARD_CAP = 100_000;
const SUMMARIZE_OUTPUT_MIN = 1024;

const SUMMARIZE_SYSTEM =
  "You are a summarizer. Compress the conversation while preserving fidelity. Output plain text with these exact sections: Goal, Constraints, Decisions, Open Questions, Next Actions, Critical Facts. Keep literals (paths, model ids, command names, env vars, URLs, numbers, error messages) whenever available. Include key tool results in concise form. Do not add preamble or commentary.";

const MERGE_SUMMARIES_SYSTEM =
  "You merge partial summaries of the same coding session (in chronological order). Output ONE plain-text summary with these exact sections: Goal, Constraints, Decisions, Open Questions, Next Actions, Critical Facts. Deduplicate overlapping content; preserve every distinct fact, path, identifier, error, and number. Do not add preamble or commentary.";

function roughTokensForMessages(messages: Array<{ role: string; content: unknown }>): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else chars += JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

function roughTokensForString(s: string): number {
  return Math.ceil(s.length / 4);
}

function effectiveContextCap(contextLengthTokens: number | undefined): number {
  return contextLengthTokens ?? SUMMARIZE_DEFAULT_CONTEXT_TOKENS;
}

/**
 * Max *input* tokens for a request, reserving space for planned max output + system + margin.
 */
function maxPromptInputTokens(
  contextLengthTokens: number | undefined,
  systemText: string,
  reservedOutputTokens: number
): number {
  const cap = effectiveContextCap(contextLengthTokens);
  const systemTokens = Math.ceil(systemText.length / 4) + 64;
  const reserved = reservedOutputTokens + systemTokens + SUMMARIZE_SAFETY_TOKENS;
  return Math.max(12_000, cap - reserved);
}

function plannedChunkOutputBudget(contextLengthTokens: number | undefined): number {
  const cap = effectiveContextCap(contextLengthTokens);
  return Math.min(SUMMARIZE_OUTPUT_HARD_CAP, Math.floor(cap * CHUNK_OUTPUT_FRACTION) + 512);
}

function plannedFullSummarizeOutputBudget(contextLengthTokens: number | undefined): number {
  const cap = effectiveContextCap(contextLengthTokens);
  return Math.min(SUMMARIZE_OUTPUT_HARD_CAP, Math.floor(cap * MERGE_FINAL_OUTPUT_FRACTION) + 1024);
}

function plannedMergeOutputBudget(
  contextLengthTokens: number | undefined,
  isFinalMergeBatch: boolean
): number {
  const cap = effectiveContextCap(contextLengthTokens);
  const frac = isFinalMergeBatch ? MERGE_FINAL_OUTPUT_FRACTION : MERGE_INTERMEDIATE_OUTPUT_FRACTION;
  return Math.min(SUMMARIZE_OUTPUT_HARD_CAP, Math.floor(cap * frac) + 512);
}

function estimatedInputTokens(system: string, messages: Array<{ role: string; content: unknown }>): number {
  return Math.ceil(system.length / 4) + 64 + roughTokensForMessages(messages);
}

/**
 * `max_tokens` for this call: aim for `desiredMax` but never exceed context − input − margin.
 */
function capMaxOutputTokens(
  contextLengthTokens: number | undefined,
  system: string,
  messages: Array<{ role: string; content: unknown }>,
  desiredMax: number
): number {
  const cap = effectiveContextCap(contextLengthTokens);
  const inputTok = estimatedInputTokens(system, messages);
  const margin = 512;
  const maxByWindow = cap - inputTok - margin;
  const out = Math.min(desiredMax, maxByWindow, SUMMARIZE_OUTPUT_HARD_CAP);
  return Math.max(SUMMARIZE_OUTPUT_MIN, Math.floor(out));
}

function clipMessageToInputBudget(
  m: { role: string; content: unknown },
  maxInputTokens: number
): { role: string; content: unknown } {
  const maxChars = Math.max(4000, maxInputTokens * 4 - 400);
  if (typeof m.content === "string") {
    if (m.content.length <= maxChars) return m;
    return {
      role: m.role,
      content: m.content.slice(0, maxChars) + "\n\n[…truncated for summarization chunk…]",
    };
  }
  const s = JSON.stringify(m.content);
  if (s.length <= maxChars) return m;
  return { role: m.role, content: s.slice(0, maxChars) + "…[truncated]" };
}

function chunkMessagesForSummarize(
  messages: Array<{ role: string; content: unknown }>,
  maxInputTokens: number
): Array<Array<{ role: string; content: unknown }>> {
  const chunks: Array<Array<{ role: string; content: unknown }>> = [];
  let current: Array<{ role: string; content: unknown }> = [];
  let curTokens = 0;

  for (const m of messages) {
    const one = roughTokensForMessages([m]);
    if (one > maxInputTokens) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        curTokens = 0;
      }
      chunks.push([clipMessageToInputBudget(m, maxInputTokens)]);
      continue;
    }
    if (curTokens + one > maxInputTokens && current.length > 0) {
      chunks.push(current);
      current = [];
      curTokens = 0;
    }
    current.push(m);
    curTokens += one;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function summarizeOneRequest(
  route: SummarizeRoute,
  requestModel: string,
  system: string,
  messages: Array<{ role: string; content: unknown }>,
  maxTokens: number
): Promise<string> {
  if (route.kind === "openrouter") {
    const body = {
      model: requestModel,
      max_tokens: maxTokens,
      system,
      messages,
    };
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(config.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${route.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (fetchErr) {
        lastError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
        if (isRetryableNetworkFailure(fetchErr) && attempt < MAX_RETRIES) {
          await sleep(computeRetryDelayMs(attempt, null));
          continue;
        }
        throw new Error(
          `Summarize connection failed${isRetryableNetworkFailure(fetchErr) ? " after retries" : ""}: ${lastError.message}`
        );
      }
      if (res.ok) {
        const data = (await res.json()) as { content?: ContentBlock[] };
        const blocks = data.content ?? [];
        const textBlock = blocks.find((b) => b.type === "text" && b.text);
        return (textBlock?.text ?? "").trim();
      }
      const text = await res.text();
      lastError = new Error(`Summarize API ${res.status}: ${text}`);
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get("retry-after");
        const waitMs = computeRetryDelayMs(attempt, retryAfter);
        await sleep(waitMs);
        continue;
      }
      throw lastError;
    }
    throw lastError;
  }

  const oaMessages = convertIdeacodeMessagesToOpenAi(messages, system);
  const body = {
    model: requestModel,
    max_tokens: maxTokens,
    messages: oaMessages,
    stream: false as const,
    temperature: oaicRequestTemperature(),
  };
  const res = await postOpenAiChatCompletions(route.baseUrl, route.apiKey, body);
  const json = (await res.json()) as unknown;
  const blocks = parseOpenAiChatCompletion(json).content ?? [];
  const textBlock = blocks.find((b) => b.type === "text" && b.text);
  return (textBlock?.text ?? "").trim();
}

async function mergePartialSummaryStrings(
  route: SummarizeRoute,
  requestModel: string,
  partials: string[],
  contextLengthTokens: number | undefined
): Promise<string> {
  if (partials.length === 0) return "";
  if (partials.length === 1) return partials[0]!.trim();

  const mergeOutReserve = plannedMergeOutputBudget(contextLengthTokens, true);
  const userBudget = maxPromptInputTokens(
    contextLengthTokens,
    MERGE_SUMMARIES_SYSTEM,
    mergeOutReserve
  );
  const intro =
    "These segments are chronological partial summaries of one session. Merge them.\n\n";
  const introTokens = roughTokensForString(intro);
  const segmentHeader = (i: number) => `\n\n--- Segment ${i} ---\n`;
  const headerTokens = roughTokensForString(segmentHeader(0));

  const batches: string[][] = [];
  let batch: string[] = [];
  let batchTokens = introTokens;

  for (const p of partials) {
    const addition = headerTokens + roughTokensForString(p);
    if (batch.length > 0 && batchTokens + addition > userBudget) {
      batches.push(batch);
      batch = [];
      batchTokens = introTokens;
    }
    batch.push(p);
    batchTokens += addition;
  }
  if (batch.length > 0) batches.push(batch);

  const contextT = effectiveContextCap(contextLengthTokens);
  const merged: string[] = [];
  const isFinalRound = batches.length === 1;
  for (const b of batches) {
    let userContent =
      intro + b.map((text, j) => `${segmentHeader(j + 1)}${text}`).join("");
    if (roughTokensForString(userContent) > userBudget) {
      const maxChars = Math.max(8000, userBudget * 4 - 400);
      userContent = userContent.slice(0, maxChars) + "\n\n[…truncated for merge request…]";
    }
    const mergeMessages = [{ role: "user" as const, content: userContent }];
    const desiredOut = plannedMergeOutputBudget(contextLengthTokens, isFinalRound);
    const maxOut = capMaxOutputTokens(contextT, MERGE_SUMMARIES_SYSTEM, mergeMessages, desiredOut);
    merged.push(
      await summarizeOneRequest(route, requestModel, MERGE_SUMMARIES_SYSTEM, mergeMessages, maxOut)
    );
  }

  if (merged.length === 1) return merged[0]!.trim();
  return mergePartialSummaryStrings(route, requestModel, merged, contextLengthTokens);
}

export type CallSummarizeOptions = {
  /** Model's context_length from OpenRouter; used to size chunks so requests stay under the limit. */
  contextLengthTokens?: number;
};

/**
 * Summarizes conversation messages. Automatically chunks map→reduce when input exceeds a safe
 * fraction of the model context (so summarization works on huge histories).
 */
export async function callSummarize(
  route: SummarizeRoute,
  requestModel: string,
  messages: Array<{ role: string; content: unknown }>,
  options?: CallSummarizeOptions
): Promise<string> {
  if (messages.length === 0) return "";

  const ctx = options?.contextLengthTokens;
  const contextT = effectiveContextCap(ctx);
  const fullOutReserve = plannedFullSummarizeOutputBudget(ctx);
  const maxInSingle = maxPromptInputTokens(ctx, SUMMARIZE_SYSTEM, fullOutReserve);

  if (roughTokensForMessages(messages) <= maxInSingle) {
    const desiredOut = Math.min(
      SUMMARIZE_OUTPUT_HARD_CAP,
      Math.floor(contextT * MERGE_FINAL_OUTPUT_FRACTION)
    );
    const maxOut = capMaxOutputTokens(contextT, SUMMARIZE_SYSTEM, messages, desiredOut);
    return summarizeOneRequest(route, requestModel, SUMMARIZE_SYSTEM, messages, maxOut);
  }

  const chunkOutReserve = plannedChunkOutputBudget(ctx);
  const maxInChunk = maxPromptInputTokens(ctx, SUMMARIZE_SYSTEM, chunkOutReserve);
  const chunks = chunkMessagesForSummarize(messages, maxInChunk);
  const partials: string[] = [];
  const desiredChunkOut = Math.min(
    SUMMARIZE_OUTPUT_HARD_CAP,
    Math.floor(contextT * CHUNK_OUTPUT_FRACTION)
  );
  for (const ch of chunks) {
    const maxOut = capMaxOutputTokens(contextT, SUMMARIZE_SYSTEM, ch, desiredChunkOut);
    partials.push(await summarizeOneRequest(route, requestModel, SUMMARIZE_SYSTEM, ch, maxOut));
  }
  return mergePartialSummaryStrings(route, requestModel, partials, options?.contextLengthTokens);
}
