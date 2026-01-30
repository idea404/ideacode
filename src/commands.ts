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
  { cmd: "/models", desc: "Switch model", aliases: ["/model"] },
  { cmd: "/brave", desc: "Set Brave Search API key", aliases: ["/brave-key"] },
  { cmd: "/help", desc: "Show help", aliases: ["/?"] },
  { cmd: "/palette", desc: "Command palette", aliases: ["/p"] },
  { cmd: "/clear", desc: "Clear conversation", aliases: ["/c"]  },
  { cmd: "/status", desc: "Show session info" },
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
