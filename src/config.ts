import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "ideacode")
  : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ideacode")
    : path.join(os.homedir(), ".config", "ideacode");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** User-defined OpenAI-compatible API (vLLM, Ollama OpenAI surface, etc.). */
export type OpenAiCompatProvider = {
  id: string;
  /** Short stable label for model ids: `oaic:<slug>/<model>`. */
  slug: string;
  name: string;
  /** Normalized base including `/v1` (no trailing slash). */
  baseUrl: string;
  apiKey?: string;
};

/** URL-safe slug from display name (may be further uniquified with allocateProviderSlug). */
export function slugifyProviderLabel(name: string): string {
  let s = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s) s = "provider";
  return s.slice(0, 48);
}

/** Next unused slug: `base`, or `base-<idprefix>`, etc. */
export function allocateProviderSlug(name: string, id: string, taken: Set<string>): string {
  const base = slugifyProviderLabel(name);
  let candidate = base;
  if (!taken.has(candidate)) return candidate;
  const short = id.replace(/-/g, "").slice(0, 8);
  candidate = `${base}-${short}`;
  let n = 0;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}-${short}${n}`;
  }
  return candidate;
}

export type StoredConfig = {
  apiKey?: string;
  model?: string;
  braveSearchApiKey?: string;
  /** Base URL of a SearXNG instance (e.g. http://127.0.0.1:8080). Env SEARXNG_URL overrides when set. */
  searxngUrl?: string;
  /** Persisted active chat id (conversations/chats/<id>.json). */
  activeChatId?: string;
  /** Extra LLM backends that speak OpenAI `/v1/chat/completions` + `/v1/models`. */
  openAiCompatProviders?: OpenAiCompatProvider[];
};

function loadConfigFile(): StoredConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as StoredConfig;
  } catch {
    return {};
  }
}

function saveConfigFile(config: StoredConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function getApiKey(): string | undefined {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv?.trim()) return fromEnv.trim();
  return loadConfigFile().apiKey;
}

export function getModel(): string {
  const fromEnv = process.env.MODEL;
  if (fromEnv?.trim()) return fromEnv.trim();
  const fromFile = loadConfigFile().model;
  if (fromFile?.trim()) return fromFile.trim();
  return "anthropic/claude-sonnet-4";
}

export function getBraveSearchApiKey(): string | undefined {
  const fromEnv =
    process.env.BRAVE_API_KEY?.trim() ?? process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return loadConfigFile().braveSearchApiKey?.trim();
}

export function saveBraveSearchApiKey(key: string): void {
  const config = loadConfigFile();
  config.braveSearchApiKey = key || undefined;
  saveConfigFile(config);
}

/** File-only value (for UI); effective URL may come from SEARXNG_URL. */
export function getStoredSearxngUrl(): string | undefined {
  return loadConfigFile().searxngUrl?.trim();
}

/**
 * SearXNG instance base URL (no trailing slash). SEARXNG_URL env wins over config file.
 */
export function getSearxngUrl(): string | undefined {
  const fromEnv = process.env.SEARXNG_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const fromFile = loadConfigFile().searxngUrl?.trim();
  return fromFile ? fromFile.replace(/\/$/, "") : undefined;
}

export function saveSearxngUrl(url: string): void {
  const config = loadConfigFile();
  const t = url.trim();
  config.searxngUrl = t ? t.replace(/\/$/, "") : undefined;
  saveConfigFile(config);
}

/** True when web_search can run (SearXNG and/or Brave is configured). */
export function isWebSearchConfigured(): boolean {
  return !!(getSearxngUrl() || getBraveSearchApiKey());
}

export function saveApiKey(apiKey: string): void {
  const config = loadConfigFile();
  config.apiKey = apiKey;
  saveConfigFile(config);
}

export function saveModel(model: string): void {
  const config = loadConfigFile();
  config.model = model;
  saveConfigFile(config);
}

export function getActiveChatId(): string | undefined {
  const id = loadConfigFile().activeChatId?.trim();
  return id || undefined;
}

export function saveActiveChatId(chatId: string): void {
  const config = loadConfigFile();
  config.activeChatId = chatId || undefined;
  saveConfigFile(config);
}

type RawOpenAiCompatRow = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  slug?: string;
};

export function getOpenAiCompatProviders(): OpenAiCompatProvider[] {
  const raw = loadConfigFile().openAiCompatProviders;
  if (!Array.isArray(raw)) return [];
  const valid: RawOpenAiCompatRow[] = [];
  for (const p of raw) {
    if (
      p &&
      typeof p === "object" &&
      typeof (p as RawOpenAiCompatRow).id === "string" &&
      typeof (p as RawOpenAiCompatRow).baseUrl === "string" &&
      typeof (p as RawOpenAiCompatRow).name === "string"
    ) {
      valid.push(p as RawOpenAiCompatRow);
    }
  }
  const taken = new Set<string>();
  const out: OpenAiCompatProvider[] = [];
  let migrated = false;
  for (const p of valid) {
    const fromFile = typeof p.slug === "string" ? p.slug.trim() : "";
    let slug = fromFile;
    if (slug && !taken.has(slug)) {
      taken.add(slug);
    } else {
      if (fromFile) migrated = true;
      slug = allocateProviderSlug(p.name, p.id, taken);
      taken.add(slug);
      if (fromFile !== slug) migrated = true;
    }
    if (!fromFile) migrated = true;
    out.push({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      slug,
    });
  }
  if (migrated) saveOpenAiCompatProviders(out);
  return out;
}

export function saveOpenAiCompatProviders(list: OpenAiCompatProvider[]): void {
  const config = loadConfigFile();
  config.openAiCompatProviders = list.length > 0 ? list : undefined;
  saveConfigFile(config);
}

export function upsertOpenAiCompatProvider(entry: {
  name: string;
  baseUrl: string;
  apiKey?: string;
}): OpenAiCompatProvider {
  const id = crypto.randomUUID();
  const list = getOpenAiCompatProviders();
  const taken = new Set(list.map((p) => p.slug));
  const slug = allocateProviderSlug(entry.name.trim(), id, taken);
  const row: OpenAiCompatProvider = {
    id,
    slug,
    name: entry.name.trim(),
    baseUrl: entry.baseUrl.trim(),
    apiKey: entry.apiKey?.trim() || undefined,
  };
  list.push(row);
  saveOpenAiCompatProviders(list);
  return row;
}

export function removeOpenAiCompatProvider(id: string): void {
  saveOpenAiCompatProviders(getOpenAiCompatProviders().filter((p) => p.id !== id));
}

export const config = {
  apiUrl: "https://openrouter.ai/api/v1/messages",
  chatCompletionsUrl: "https://openrouter.ai/api/v1/chat/completions",
  modelsUrl: "https://openrouter.ai/api/v1/models",
  keyInfoUrl: "https://openrouter.ai/api/v1/key",
  /** Account credits (may require a management key; 403 with normal keys is OK). */
  creditsUrl: "https://openrouter.ai/api/v1/credits",
  get apiKey() {
    return getApiKey();
  },
  get model() {
    return getModel();
  },
} as const;
