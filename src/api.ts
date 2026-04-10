import { config } from "./config.js";
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

const MAX_RETRIES = 8;
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

export async function callApi(
  apiKey: string,
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  model: string,
  callbacks?: {
    /** `status` is HTTP code when retrying 5xx/429, or `0` when retrying a dropped connection (fetch failed). */
    onRetry?: (info: { attempt: number; maxAttempts: number; waitMs: number; status: number }) => void;
  }
): Promise<{ content?: ContentBlock[] }> {
  const body = {
    model,
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
          Authorization: `Bearer ${apiKey}`,
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
    if (res.ok) return res.json();
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

async function openRouterSummarizeRequest(
  apiKey: string,
  model: string,
  system: string,
  messages: Array<{ role: string; content: unknown }>,
  maxTokens: number
): Promise<string> {
  const body = {
    model,
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
          Authorization: `Bearer ${apiKey}`,
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

async function mergePartialSummaryStrings(
  apiKey: string,
  model: string,
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
    merged.push(await openRouterSummarizeRequest(apiKey, model, MERGE_SUMMARIES_SYSTEM, mergeMessages, maxOut));
  }

  if (merged.length === 1) return merged[0]!.trim();
  return mergePartialSummaryStrings(apiKey, model, merged, contextLengthTokens);
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
  apiKey: string,
  messages: Array<{ role: string; content: unknown }>,
  model: string,
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
    return openRouterSummarizeRequest(apiKey, model, SUMMARIZE_SYSTEM, messages, maxOut);
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
    partials.push(await openRouterSummarizeRequest(apiKey, model, SUMMARIZE_SYSTEM, ch, maxOut));
  }
  return mergePartialSummaryStrings(apiKey, model, partials, options?.contextLengthTokens);
}
