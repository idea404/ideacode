import { callSummarize } from "./api.js";

export type Message = { role: string; content: unknown };
const MAX_PINNED_FACTS = 28;
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
  options: { keepLast: number }
): Promise<Message[]> {
  const { keepLast } = options;
  if (state.length <= keepLast) return state;
  const toSummarize = state.slice(0, state.length - keepLast);
  const recent = state.slice(-keepLast);
  const summary = await callSummarize(apiKey, toSummarize, model);
  const pinnedFacts = extractPinnedFacts(toSummarize);
  const summaryMessage: Message = {
    role: "assistant",
    content: buildSummaryEnvelope(summary, pinnedFacts),
  };
  return [summaryMessage, ...recent];
}

export async function ensureUnderBudget(
  apiKey: string,
  state: Message[],
  systemPrompt: string,
  model: string,
  options: { maxTokens: number; keepLast: number }
): Promise<Message[]> {
  const { maxTokens, keepLast } = options;
  if (estimateTokens(state, systemPrompt) <= maxTokens) return state;
  let working = state;
  if (working.length > keepLast) {
    working = await compressState(apiKey, working, systemPrompt, model, { keepLast });
  }
  // If still over budget, trim oldest messages as a hard fallback.
  while (working.length > 1 && estimateTokens(working, systemPrompt) > maxTokens) {
    working = working.slice(1);
  }
  return working;
}
