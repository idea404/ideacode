import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigDir } from "./config.js";

export type Message = { role: string; content: unknown };

function hashCwd(cwd: string): string {
  return crypto.createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 16);
}

export function getConversationPath(cwd: string): string {
  const dir = path.join(getConfigDir(), "conversations");
  return path.join(dir, `${hashCwd(cwd)}.json`);
}

export function loadConversation(cwd: string): Message[] {
  const filePath = getConversationPath(cwd);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data as Message[];
  } catch {
    return [];
  }
}

export function saveConversation(cwd: string, messages: Message[]): void {
  const filePath = getConversationPath(cwd);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(messages), "utf-8");
}
