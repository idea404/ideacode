import * as fs from "node:fs";
import * as path from "node:path";
import { globSync } from "glob";
import type { ToolArgs } from "./types.js";

function toGlobIgnore(line: string): string {
  const s = line.replace(/^\//, "").replace(/\/$/, "");
  if (!s) return "";
  if (s.includes("*") || s.startsWith("!")) return s;
  if (s.includes("/") || s.endsWith(".env") || /\.\w+$/.test(s)) return `**/${s}`;
  return `**/${s}/**`;
}

function getIgnorePatterns(): string[] {
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  try {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const patterns = content
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map(toGlobIgnore)
      .filter(Boolean);
    return patterns.length > 0 ? patterns : ["**/node_modules/**", "**/dist/**"];
  } catch {
    return ["**/node_modules/**", "**/dist/**"];
  }
}

export function globFiles(args: ToolArgs): string {
  const base = (args.path as string) ?? ".";
  const pat = args.pat as string;
  const pattern = path.join(base, pat).replace(/\/\/+/g, "/");
  const isProjectRoot = base === "." || base === "";
  const opts: { nodir: true; ignore?: string[] } = { nodir: true };
  if (isProjectRoot) opts.ignore = getIgnorePatterns();
  const files = globSync(pattern, opts);
  const withMtime = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m);
  return withMtime.map(({ f }) => f).join("\n") || "none";
}

const DEFAULT_GREP_LIMIT = 50;
const MAX_GREP_LIMIT = 100;
const MAX_GREP_CHARS = 16_000;

export function grepFiles(args: ToolArgs): string {
  const base = (args.path as string) ?? ".";
  const pat = new RegExp(args.pat as string);
  const limit = Math.min(
    MAX_GREP_LIMIT,
    Math.max(1, (args.limit as number) ?? DEFAULT_GREP_LIMIT)
  );
  const isProjectRoot = base === "." || base === "";
  const grepOpts: { nodir: true; ignore?: string[] } = { nodir: true };
  if (isProjectRoot) grepOpts.ignore = getIgnorePatterns();
  const allFiles = globSync(
    path.join(base, "**/*").replace(/\/\/+/g, "/"),
    grepOpts
  );
  const hits: string[] = [];
  for (const filepath of allFiles) {
    try {
      const content = fs.readFileSync(filepath, "utf-8");
      const lines = content.split(/\n/);
      for (let i = 0; i < lines.length; i++) {
        if (pat.test(lines[i])) hits.push(`${filepath}:${i + 1}:${lines[i].replace(/\r$/, "")}`);
      }
    } catch {
      /* skip */
    }
    if (hits.length >= limit) break;
  }
  const sliced = hits.slice(0, limit);
  let out = sliced.join("\n") || "none";
  if (out.length > MAX_GREP_CHARS) {
    let acc = 0;
    let i = 0;
    for (; i < sliced.length; i++) {
      const line = sliced[i]!;
      if (acc + line.length + 1 > MAX_GREP_CHARS) break;
      acc += line.length + 1;
    }
    out = sliced.slice(0, i).join("\n");
    const dropped = sliced.length - i;
    out += `\n\n... (truncated: ${dropped} more matches, total ${hits.length} hit(s). Use a more specific pattern or path to reduce output.)`;
  }
  return out;
}
