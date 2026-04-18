/**
 * Single source of truth for slash commands.
 * Used by the REPL for slash suggestions, command palette, and processInput dispatch.
 */

export type Command = {
  cmd: string;
  desc: string;
  aliases?: string[];
};

export const COMMANDS: Command[] = [
  { cmd: "/chats", desc: "Pick saved chat", aliases: ["/chat"] },
  { cmd: "/new", desc: "Start new chat", aliases: ["/new-session"] },
  {
    cmd: "/fork",
    desc: "Duplicate this chat (optional: /fork title)",
    aliases: ["/duplicate"],
  },
  { cmd: "/rename", desc: "Rename this chat (optional: /rename title)" },
  { cmd: "/delete", desc: "Delete this chat" },
  { cmd: "/models", desc: "Switch model", aliases: ["/model"] },
  { cmd: "/providers", desc: "List OpenAI-compatible providers" },
  {
    cmd: "/new-provider",
    desc: "Add OpenAI-compatible API URL (vLLM, Ollama, etc.)",
    aliases: ["/add-provider", "/openai-provider"],
  },
  { cmd: "/remove-provider", desc: "Remove a custom OpenAI-compatible provider" },
  { cmd: "/searxng", desc: "Set SearXNG base URL (web search, preferred)", aliases: ["/searx"] },
  { cmd: "/brave", desc: "Set Brave Search API key (web search fallback)", aliases: ["/brave-key"] },
  { cmd: "/help", desc: "Show help", aliases: ["/?"] },
  { cmd: "/palette", desc: "Command palette", aliases: ["/p"] },
  { cmd: "/clear", desc: "Clear conversation", aliases: ["/c"] },
  {
    cmd: "/compress",
    desc: "Summarize older turns to fit ~30% of model context (for smaller models)",
  },
  { cmd: "/status", desc: "Show chat, model, cwd, and message count" },
  { cmd: "/q", desc: "Quit", aliases: ["/exit", "/quit", "exit"] },
];

const aliasToCanonical = new Map<string, string>();
for (const c of COMMANDS) {
  aliasToCanonical.set(c.cmd.toLowerCase(), c.cmd);
  for (const a of c.aliases ?? []) {
    aliasToCanonical.set(a.toLowerCase().trim(), c.cmd);
  }
}

export function resolveCommand(input: string): string | null {
  const key = input.trim().toLowerCase();
  if (!key) return null;
  return aliasToCanonical.get(key) ?? null;
}

/** Exact command match, or first token (e.g. `/rename My title` → canonical `/rename`, rest `My title`). */
export function resolveSlashCommand(input: string): { canonical: string | null; rest: string } {
  const trimmed = input.trim();
  if (!trimmed) return { canonical: null, rest: "" };
  const exact = resolveCommand(trimmed);
  if (exact) return { canonical: exact, rest: "" };
  const sp = trimmed.search(/\s/);
  if (sp <= 0) return { canonical: null, rest: "" };
  const head = trimmed.slice(0, sp).trim().toLowerCase();
  const tail = trimmed.slice(sp).trim();
  const canon = aliasToCanonical.get(head);
  if (canon) return { canonical: canon, rest: tail };
  return { canonical: null, rest: "" };
}

export function matchCommand(filter: string, c: Command): boolean {
  const f = filter.toLowerCase().trim();
  if (!f) return true;
  const search = [c.cmd, c.desc, ...(c.aliases ?? [])].join(" ").toLowerCase();
  if (search.includes(f)) return true;
  const compact = f.replace(/\s+/g, "");
  if (!compact) return true;
  const cmdCompact = c.cmd.replace(/\s+/g, "");
  const descCompact = c.desc.replace(/\s+/g, "");
  const aliasCompact = (c.aliases ?? []).map((a) => a.replace(/\s+/g, ""));
  return (
    cmdCompact.includes(compact) ||
    descCompact.includes(compact) ||
    aliasCompact.some((a) => a.includes(compact))
  );
}
