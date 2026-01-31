import { callSummarize } from "./api.js";

export type Message = { role: string; content: unknown };

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
  const summaryMessage: Message = {
    role: "user",
    content: `Previous context:\n${summary}`,
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
  if (state.length <= keepLast) {
    let trimmed = state;
    while (trimmed.length > 1 && estimateTokens(trimmed, systemPrompt) > maxTokens) {
      trimmed = trimmed.slice(1);
    }
    return trimmed;
  }
  return compressState(apiKey, state, systemPrompt, model, { keepLast });
}
