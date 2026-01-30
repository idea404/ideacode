import * as fs from "node:fs";
import type { ToolArgs } from "./types.js";

const DEFAULT_READ_LIMIT = 500;

export function readFile(args: ToolArgs): string {
  const content = fs.readFileSync(args.path as string, "utf-8");
  const parts = content.split("\n");
  const lines = content.endsWith("\n") ? parts.slice(0, -1) : parts;
  if (lines.length === 0 && content === "") return "";
  const offset = (args.offset as number) ?? 0;
  const requestedLimit = (args.limit as number) ?? lines.length;
  const limit = Math.min(requestedLimit, DEFAULT_READ_LIMIT);
  const selected = lines.slice(offset, offset + limit);
  const total = lines.length;
  const truncated = total > offset + selected.length;
  const suffix = truncated
    ? `\n\n... (${total - offset - selected.length} more line(s). Use offset/limit to read in chunks.)`
    : "";
  return (
    selected.map((line, idx) => `${String(offset + idx + 1).padStart(4)}| ${line}`).join("\n") +
    suffix
  );
}

export function writeFile(args: ToolArgs): string {
  fs.writeFileSync(args.path as string, args.content as string, "utf-8");
  return "ok";
}

export function editFile(args: ToolArgs): string {
  const text = fs.readFileSync(args.path as string, "utf-8");
  const oldStr = args.old as string;
  const newStr = args.new as string;
  if (!text.includes(oldStr)) return "error: old_string not found";
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(oldStr, pos)) !== -1) {
    count++;
    pos += oldStr.length;
  }
  if (!args.all && count > 1) {
    return `error: old_string appears ${count} times, must be unique (use all=true)`;
  }
  const replacement = args.all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
  fs.writeFileSync(args.path as string, replacement, "utf-8");
  return "ok";
}
