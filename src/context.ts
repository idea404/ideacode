import { callSummarize } from "./api.js";

export type Message = { role: string; content: unknown };
const MAX_PINNED_FACTS = 28;

function isToolResultsOnlyUser(m: Message): boolean {
  if (m.role !== "user") return false;
  const c = m.content;
  if (!Array.isArray(c) || c.length === 0) return false;
  return c.every(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as { type?: string }).type === "tool_result"
  );
}

function assistantHasToolUse(m: Message): boolean {
  if (m.role !== "assistant") return false;
  const c = m.content;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_use");
}

function toolUseIdsFromAssistant(m: Message): Set<string> {
  const ids = new Set<string>();
  const c = m.content;
  if (!Array.isArray(c)) return ids;
  for (const b of c) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "tool_use") {
      const id = (b as { id?: string }).id;
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * A user message that is only tool_result blocks must immediately follow an assistant message
 * that contains the matching tool_use ids. Otherwise providers reject the request (e.g. OpenRouter
 * “tool role but no previous assistant tool call”).
 */
function isOrphanToolResultsUserAt(messages: Message[], index: number): boolean {
  const m = messages[index];
  if (!m || !isToolResultsOnlyUser(m)) return false;
  if (index === 0) return true;
  const prev = messages[index - 1]!;
  if (prev.role !== "assistant" || !assistantHasToolUse(prev)) return true;
  const ids = toolUseIdsFromAssistant(prev);
  const blocks = m.content as Array<{ tool_use_id?: string }>;
  for (const tr of blocks) {
    const tid = tr.tool_use_id;
    if (!tid || !ids.has(tid)) return true;
  }
  return false;
}

/**
 * Remove tool_result-only user messages that are not paired with the immediately preceding
 * assistant tool_use turn. Trimming/compression can leave these anywhere in the transcript.
 */
export function sanitizeMessagesForApi(messages: Message[]): Message[] {
  let out = [...messages];
  for (;;) {
    const idx = out.findIndex((_, i) => isOrphanToolResultsUserAt(out, i));
    if (idx < 0) break;
    out = out.slice(0, idx).concat(out.slice(idx + 1));
  }
  return out;
}

/** Last `keepLast` messages, extended backward to include the assistant that owns leading tool results. */
function takeRecentSlice(state: Message[], keepLast: number): Message[] {
  if (state.length === 0) return state;
  let start = Math.max(0, state.length - keepLast);
  while (
    start > 0 &&
    isToolResultsOnlyUser(state[start]!) &&
    state[start - 1]?.role === "assistant" &&
    assistantHasToolUse(state[start - 1]!)
  ) {
    start--;
  }
  let recent = state.slice(start);
  while (recent.length > 0 && isOrphanToolResultsUserAt(recent, 0)) {
    recent = recent.slice(1);
  }
  return recent;
}
const MAX_PINNED_FACT_CHARS = 200;

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        const maybe = item as { content?: unknown; type?: unknown; name?: unknown; input?: unknown };
        if (typeof maybe.content === "string") parts.push(maybe.content);
        if (maybe.type === "tool_use" && typeof maybe.name === "string") {
          parts.push(`tool_use ${maybe.name} ${JSON.stringify(maybe.input ?? {})}`);
        }
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content);
}

function extractPinnedFacts(messages: Message[]): string[] {
  const allLines = messages
    .flatMap((m) => messageContentToText(m.content).split("\n"))
    .map((l) => l.trim())
    .filter(Boolean);

  const facts: string[] = [];
  const seen = new Set<string>();
  const importantPattern =
    /(\/[A-Za-z0-9._/-]{2,}|https?:\/\/\S+|\b[A-Z][A-Z0-9_]{2,}\b|\b(error|failed|must|never|always|todo|fixme|constraint)\b)/i;

  for (const line of allLines) {
    if (!importantPattern.test(line)) continue;
    const cleaned = line.replace(/\s+/g, " ").slice(0, MAX_PINNED_FACT_CHARS);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    facts.push(cleaned);
    if (facts.length >= MAX_PINNED_FACTS) break;
  }
  return facts;
}

function buildSummaryEnvelope(summary: string, pinnedFacts: string[]): string {
  const factBlock =
    pinnedFacts.length > 0
      ? `Pinned facts (verbatim, highest priority):\n${pinnedFacts.map((f) => `- ${f}`).join("\n")}\n\n`
      : "";
  return `${factBlock}Conversation summary:\n${summary}`.trim();
}

export function estimateTokens(messages: Message[], systemPrompt?: string): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else chars += JSON.stringify(m.content).length;
  }
  if (systemPrompt) chars += systemPrompt.length;
  return Math.round(chars / 4);
}

export function estimateTokensForString(str: string): number {
  return Math.round(str.length / 4);
}

export async function compressState(
  apiKey: string,
  state: Message[],
  systemPrompt: string,
  model: string,
  options: { keepLast: number; modelContextLength?: number }
): Promise<Message[]> {
  const { keepLast, modelContextLength } = options;
  const cleaned = sanitizeMessagesForApi(state);
  if (cleaned.length <= keepLast) return cleaned;
  const recent = takeRecentSlice(cleaned, keepLast);
  const toSummarize = cleaned.slice(0, cleaned.length - recent.length);
  if (toSummarize.length === 0) return cleaned;
  const summary = await callSummarize(apiKey, toSummarize, model, {
    contextLengthTokens: modelContextLength,
  });
  const pinnedFacts = extractPinnedFacts(toSummarize);
  const summaryMessage: Message = {
    role: "assistant",
    content: buildSummaryEnvelope(summary, pinnedFacts),
  };
  return sanitizeMessagesForApi([summaryMessage, ...recent]);
}

export async function ensureUnderBudget(
  apiKey: string,
  state: Message[],
  systemPrompt: string,
  model: string,
  options: { maxTokens: number; keepLast: number; modelContextLength?: number }
): Promise<Message[]> {
  const { maxTokens, keepLast, modelContextLength } = options;
  let working = sanitizeMessagesForApi(state);
  if (estimateTokens(working, systemPrompt) <= maxTokens) return working;
  if (working.length > keepLast) {
    working = await compressState(apiKey, working, systemPrompt, model, {
      keepLast,
      modelContextLength,
    });
  }
  // If still over budget, trim oldest messages as a hard fallback.
  while (working.length > 1 && estimateTokens(working, systemPrompt) > maxTokens) {
    working = sanitizeMessagesForApi(working.slice(1));
  }
  return sanitizeMessagesForApi(working);
}

/** OpenRouter-style context_length is in tokens; used when model metadata is known. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128 * 1024;
/** Leave ~70% of the window for new work after a manual compress. */
const MANUAL_COMPRESS_TARGET_FRACTION = 0.3;
const MANUAL_COMPRESS_KEEP_LAST_INITIAL = 12;
const MANUAL_COMPRESS_KEEP_LAST_MIN = 4;
const MANUAL_COMPRESS_MAX_ROUNDS = 16;

/**
 * Token budget for “comfortable headroom” after /compress: a fraction of the model’s
 * reported context window, or the same fraction of a 128K default when unknown.
 */
export function manualCompressTargetMaxTokens(modelContextLength?: number): number {
  const base = modelContextLength ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.floor(base * MANUAL_COMPRESS_TARGET_FRACTION);
}

export type CompressToBudgetResult = {
  messages: Message[];
  changed: boolean;
  tokensBefore: number;
  tokensAfter: number;
  targetMaxTokens: number;
};

/**
 * On-demand compression: summarize older turns (same pipeline as auto compress, including
 * pinned facts) until estimated tokens ≤ targetMaxTokens, tightening keep-recent if needed.
 */
export async function compressConversationToTargetBudget(
  apiKey: string,
  state: Message[],
  systemPrompt: string,
  model: string,
  options: {
    targetMaxTokens: number;
    keepLastInitial?: number;
    minKeepLast?: number;
    modelContextLength?: number;
  }
): Promise<CompressToBudgetResult> {
  const { targetMaxTokens, modelContextLength } = options;
  const keepLastInitial = options.keepLastInitial ?? MANUAL_COMPRESS_KEEP_LAST_INITIAL;
  const minKeepLast = options.minKeepLast ?? MANUAL_COMPRESS_KEEP_LAST_MIN;

  const cleaned = sanitizeMessagesForApi(state);
  const tokensBefore = estimateTokens(cleaned, systemPrompt);
  if (tokensBefore <= targetMaxTokens) {
    return {
      messages: cleaned,
      changed: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      targetMaxTokens,
    };
  }

  let working = cleaned;
  let keepLast = Math.min(keepLastInitial, Math.max(1, working.length - 1));

  for (let round = 0; round < MANUAL_COMPRESS_MAX_ROUNDS; round++) {
    if (estimateTokens(working, systemPrompt) <= targetMaxTokens) {
      break;
    }
    if (working.length <= keepLast) {
      if (working.length > 1) {
        working = sanitizeMessagesForApi(working.slice(1));
        continue;
      }
      break;
    }
    working = await compressState(apiKey, working, systemPrompt, model, {
      keepLast,
      modelContextLength,
    });
    if (estimateTokens(working, systemPrompt) <= targetMaxTokens) {
      break;
    }
    if (keepLast > minKeepLast) {
      keepLast = Math.max(minKeepLast, keepLast - 4);
      continue;
    }
    while (working.length > 1 && estimateTokens(working, systemPrompt) > targetMaxTokens) {
      working = sanitizeMessagesForApi(working.slice(1));
    }
    break;
  }

  working = sanitizeMessagesForApi(working);
  const tokensAfter = estimateTokens(working, systemPrompt);
  return {
    messages: working,
    changed: tokensAfter < tokensBefore,
    tokensBefore,
    tokensAfter,
    targetMaxTokens,
  };
}
