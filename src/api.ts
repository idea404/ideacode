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

export async function fetchModels(apiKey: string): Promise<OpenRouterModel[]> {
  const res = await fetch(config.modelsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as ModelsResponse;
  return json.data ?? [];
}

export async function callApi(
  apiKey: string,
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  model: string
): Promise<{ content?: ContentBlock[] }> {
  const body = {
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages,
    tools: makeSchema(),
  };
  const res = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
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
  const res = await fetch(config.chatCompletionsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
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

const SUMMARIZE_SYSTEM =
  "You are a summarizer. Summarize the following conversation between user and assistant, including any tool use and results. Preserve the user's goal, key decisions, and important facts. Output only the summary, no preamble.";

export async function callSummarize(
  apiKey: string,
  messages: Array<{ role: string; content: unknown }>,
  model: string
): Promise<string> {
  const body = {
    model,
    max_tokens: 4096,
    system: SUMMARIZE_SYSTEM,
    messages,
  };
  const res = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Summarize API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content?: ContentBlock[] };
  const blocks = data.content ?? [];
  const textBlock = blocks.find((b) => b.type === "text" && b.text);
  return (textBlock?.text ?? "").trim();
}
