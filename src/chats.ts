import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigDir, getActiveChatId, saveActiveChatId } from "./config.js";

export type ChatMessage = { role: string; content: unknown };

export const CHAT_FORMAT_VERSION = 1 as const;

export type ChatRecord = {
  v: typeof CHAT_FORMAT_VERSION;
  id: string;
  title: string;
  /** When true, auto-title from first message is disabled. */
  titleManuallySet: boolean;
  updatedAt: string;
  /** Optional workspace hint (e.g. where the chat was started); tools still use process cwd. */
  defaultCwd?: string;
  messages: ChatMessage[];
};

export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

const LEGACY_HASH_FILE = /^[a-f0-9]{16}\.json$/i;

function chatsDirectory(): string {
  return path.join(getConfigDir(), "conversations", "chats");
}

function chatFilePath(id: string): string {
  return path.join(chatsDirectory(), `${id}.json`);
}

function defaultNewChatTitle(): string {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const year = d.getFullYear();
  return `New chat · ${month} ${day}, ${year}`;
}

function messageContentToPlainSnippet(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && typeof (item as { content?: unknown }).content === "string") {
        parts.push(String((item as { content: string }).content));
      }
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/** First user-visible string from messages (for auto-title). */
export function firstUserTextSnippet(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const s = messageContentToPlainSnippet(m.content);
    if (s) return s.length > 56 ? s.slice(0, 53).trimEnd() + "…" : s;
  }
  return "";
}

function parseChatRecord(raw: unknown): ChatRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== CHAT_FORMAT_VERSION || typeof o.id !== "string") return null;
  if (typeof o.title !== "string") return null;
  if (typeof o.titleManuallySet !== "boolean") return null;
  if (typeof o.updatedAt !== "string") return null;
  if (!Array.isArray(o.messages)) return null;
  return {
    v: CHAT_FORMAT_VERSION,
    id: o.id,
    title: o.title,
    titleManuallySet: o.titleManuallySet,
    updatedAt: o.updatedAt,
    defaultCwd: typeof o.defaultCwd === "string" ? o.defaultCwd : undefined,
    messages: o.messages as ChatMessage[],
  };
}

/** Legacy flat file: raw JSON array of messages only. */
function tryParseLegacyMessages(raw: string): ChatMessage[] | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return null;
    return data as ChatMessage[];
  } catch {
    return null;
  }
}

export function loadChatRecord(id: string): ChatRecord | null {
  const filePath = chatFilePath(id);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const rec = parseChatRecord(parsed);
    if (rec) return rec;
    const legacy = tryParseLegacyMessages(raw);
    if (legacy) {
      const stat = fs.statSync(filePath);
      return {
        v: CHAT_FORMAT_VERSION,
        id,
        title: "Recovered chat",
        titleManuallySet: true,
        updatedAt: stat.mtime.toISOString(),
        messages: legacy,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Move `conversations/<16-hex>.json` into `conversations/chats/<uuid>.json`. */
export function migrateLegacyChats(): void {
  const convDir = path.join(getConfigDir(), "conversations");
  if (!fs.existsSync(convDir)) return;
  fs.mkdirSync(chatsDirectory(), { recursive: true });
  for (const name of fs.readdirSync(convDir)) {
    if (!LEGACY_HASH_FILE.test(name)) continue;
    const legacyPath = path.join(convDir, name);
    if (!fs.statSync(legacyPath).isFile()) continue;
    const hash = path.basename(name, ".json");
    try {
      const raw = fs.readFileSync(legacyPath, "utf-8");
      const legacy = tryParseLegacyMessages(raw);
      if (!legacy) continue;
      const stat = fs.statSync(legacyPath);
      const id = crypto.randomUUID();
      const record: ChatRecord = {
        v: CHAT_FORMAT_VERSION,
        id,
        title: `Imported · ${hash}`,
        titleManuallySet: true,
        updatedAt: stat.mtime.toISOString(),
        messages: legacy,
      };
      fs.writeFileSync(chatFilePath(id), JSON.stringify(record), "utf-8");
      fs.unlinkSync(legacyPath);
    } catch {
      // Skip broken files.
    }
  }
}

export function listChatSummaries(): ChatSummary[] {
  fs.mkdirSync(chatsDirectory(), { recursive: true });
  const out: ChatSummary[] = [];
  if (!fs.existsSync(chatsDirectory())) return out;
  for (const name of fs.readdirSync(chatsDirectory())) {
    if (!name.endsWith(".json")) continue;
    const id = path.basename(name, ".json");
    const rec = loadChatRecord(id);
    if (!rec) continue;
    out.push({ id: rec.id, title: rec.title, updatedAt: rec.updatedAt });
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

function nextTitleForSave(prev: ChatRecord, messages: ChatMessage[]): { title: string; titleManuallySet: boolean } {
  if (prev.titleManuallySet) {
    return { title: prev.title, titleManuallySet: true };
  }
  // Cleared transcript: keep title (and auto flag) so the chat name stays recognizable.
  if (messages.length === 0) {
    return { title: prev.title, titleManuallySet: prev.titleManuallySet };
  }
  const snippet = firstUserTextSnippet(messages);
  if (snippet) return { title: snippet, titleManuallySet: false };
  return { title: prev.title || defaultNewChatTitle(), titleManuallySet: false };
}

export function saveChatRecord(record: ChatRecord): void {
  fs.mkdirSync(chatsDirectory(), { recursive: true });
  const pathStr = chatFilePath(record.id);
  fs.writeFileSync(pathStr, JSON.stringify(record), "utf-8");
}

/** Merge messages + bump updatedAt + auto-title rules. */
export function saveChatMessages(
  id: string,
  messages: ChatMessage[],
  prev: ChatRecord | null,
  cwdForDefault?: string
): ChatRecord {
  const base =
    prev ??
    ({
      v: CHAT_FORMAT_VERSION,
      id,
      title: defaultNewChatTitle(),
      titleManuallySet: false,
      updatedAt: new Date().toISOString(),
      defaultCwd: cwdForDefault,
      messages: [],
    } as ChatRecord);
  const { title, titleManuallySet } = nextTitleForSave(base, messages);
  const record: ChatRecord = {
    ...base,
    id,
    messages,
    title,
    titleManuallySet,
    updatedAt: new Date().toISOString(),
    defaultCwd: base.defaultCwd ?? cwdForDefault,
  };
  saveChatRecord(record);
  return record;
}

export function createNewChat(cwd: string): ChatRecord {
  const id = crypto.randomUUID();
  const record: ChatRecord = {
    v: CHAT_FORMAT_VERSION,
    id,
    title: defaultNewChatTitle(),
    titleManuallySet: false,
    updatedAt: new Date().toISOString(),
    defaultCwd: cwd,
    messages: [],
  };
  saveChatRecord(record);
  saveActiveChatId(id);
  return record;
}

export function deleteChatFile(id: string): void {
  try {
    fs.unlinkSync(chatFilePath(id));
  } catch {
    // ignore
  }
}

/**
 * Ensure at least one chat exists; return id to load.
 * Persists active id when falling back to most recent.
 */
export function resolveActiveChatIdOnStartup(cwd: string): { id: string; record: ChatRecord } {
  migrateLegacyChats();
  fs.mkdirSync(chatsDirectory(), { recursive: true });

  const configured = getActiveChatId();
  if (configured) {
    const rec = loadChatRecord(configured);
    if (rec) return { id: rec.id, record: rec };
  }

  const summaries = listChatSummaries();
  if (summaries.length > 0) {
    const top = summaries[0]!;
    const rec = loadChatRecord(top.id);
    if (rec) {
      saveActiveChatId(rec.id);
      return { id: rec.id, record: rec };
    }
  }

  const created = createNewChat(cwd);
  return { id: created.id, record: created };
}

export function formatChatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  let diff = Date.now() - t;
  if (diff < 0) diff = 0;
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
