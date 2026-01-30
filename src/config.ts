import * as fs from "node:fs";
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

export type StoredConfig = {
  apiKey?: string;
  model?: string;
  braveSearchApiKey?: string;
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

export const config = {
  apiUrl: "https://openrouter.ai/api/v1/messages",
  modelsUrl: "https://openrouter.ai/api/v1/models",
  get apiKey() {
    return getApiKey();
  },
  get model() {
    return getModel();
  },
} as const;
