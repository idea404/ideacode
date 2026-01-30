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
