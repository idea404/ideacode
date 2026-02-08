import { marked } from "marked";
import Table from "cli-table3";
import chalk from "chalk";
import boxen from "boxen";
import { colors, icons, theme, inkColors } from "./theme.js";

const hrLine = () => {
  const cols = process.stdout.columns ?? 80;
  return colors.muted("─".repeat(Math.min(cols, 100)));
};

const codeStyle = (s: string) => chalk.hex(theme.syntax.code)(s);

type AnyToken = {
  type?: string;
  text?: string;
  raw?: string;
  depth?: number;
  ordered?: boolean;
  start?: number;
  items?: AnyToken[];
  tokens?: AnyToken[];
  header?: AnyToken[];
  rows?: AnyToken[][];
  href?: string;
  lang?: string;
  align?: Array<string | null>;
};

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLen(input: string): number {
  return stripAnsi(input).length;
}

function preprocessMarkdown(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/\t/g, "  ");
}

function normalizeTableCellText(input: string): string {
  let s = input.replace(/\s+/g, " ").trim();
  if (!s) return s;
  // Many models emit " / " as pseudo-newlines in tables; promote to bullet lines.
  // Keep URL-like tokens intact by only rewriting slash tokens surrounded by spaces.
  s = s.replace(/\s+\/\s+(?=[^\s])/g, "\n• ");
  s = s.replace(/(^|\n)\s*•\s*•\s*/g, "$1• ");
  if (!s.startsWith("• ") && s.includes("\n• ")) s = "• " + s;
  return s;
}

function splitRenderedLines(rendered: string): string[] {
  return rendered.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
}

function renderInlineTokens(tokens: AnyToken[] | undefined): string {
  if (!tokens || tokens.length === 0) return "";
  return tokens
    .map((token) => {
      const t = token.type ?? "";
      if (t === "text") return token.text ?? "";
      if (t === "escape") return token.text ?? "";
      if (t === "strong") return chalk.bold(renderInlineTokens(token.tokens));
      if (t === "em") return chalk.italic(renderInlineTokens(token.tokens));
      if (t === "codespan") return codeStyle(token.text ?? "");
      if (t === "del") return chalk.strikethrough(renderInlineTokens(token.tokens));
      if (t === "link") {
        const label = renderInlineTokens(token.tokens) || token.text || token.href || "";
        const labelStyled = chalk.hex(theme.syntax.link).underline(label);
        if (!token.href || label === token.href) return labelStyled;
        return `${labelStyled}${colors.mutedDark(` (${token.href})`)}`;
      }
      if (t === "br") return "\n";
      if (t === "html") {
        const raw = token.raw ?? token.text ?? "";
        if (/^<br\s*\/?\s*>$/i.test(raw.trim())) return "\n";
        return raw.replace(/<[^>]+>/g, "");
      }
      return token.text ?? token.raw ?? "";
    })
    .join("");
}

function headingRule(text: string): string {
  const width = Math.min(96, Math.max(24, visibleLen(text) + 8));
  return colors.muted("─".repeat(width));
}

function renderHeading(token: AnyToken): string[] {
  const depth = token.depth ?? 2;
  const headingText = renderInlineTokens(token.tokens) || token.text || "";
  const clean = headingText.trim();
  if (!clean) return [];

  if (depth <= 1) {
    return [chalk.hex(theme.syntax.heading).bold.underline(clean), headingRule(clean), ""];
  }
  if (depth === 2) {
    return [chalk.hex(theme.syntax.heading).bold(clean), headingRule(clean), ""];
  }
  if (depth === 3) {
    return [chalk.hex(theme.syntax.heading).bold(clean), ""];
  }
  return [colors.accentDim(clean), ""];
}

function renderCodeBlock(token: AnyToken): string[] {
  const raw = (token.text ?? "").replace(/\n$/, "");
  const lang = (token.lang ?? "").trim();
  const body = raw || "(empty)";
  const title = lang ? ` ${lang} ` : " code ";
  const boxed = boxen(codeStyle(body), {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
    borderColor: inkColors.mutedDim,
    borderStyle: "round",
    title,
    titleAlignment: "left",
  });
  return splitRenderedLines(boxed).concat("");
}

function renderTable(token: AnyToken): string[] {
  const headerCells = (token.header ?? []).map((c) => renderInlineTokens(c.tokens) || c.text || "");
  const rows = (token.rows ?? []).map((row) =>
    row.map((c) => normalizeTableCellText(renderInlineTokens(c.tokens) || c.text || ""))
  );
  const colCount = Math.max(headerCells.length, ...rows.map((r) => r.length), 0);
  if (colCount === 0) return [];

  const paddedHeader = [...headerCells];
  while (paddedHeader.length < colCount) paddedHeader.push("");
  const paddedRows = rows.map((r) => {
    const copy = [...r];
    while (copy.length < colCount) copy.push("");
    return copy;
  });

  const maxColsWidth = Math.max(48, (process.stdout.columns ?? 100) - 8);
  const minColWidth = 10;
  const maxColWidth = 40;
  const widths = Array.from({ length: colCount }, (_, i) => {
    const maxLen = Math.max(
      visibleLen(paddedHeader[i] ?? ""),
      ...paddedRows.map((r) => visibleLen(r[i] ?? "")),
      minColWidth
    );
    return Math.min(maxColWidth, maxLen + 2);
  });

  const currentWidth = widths.reduce((a, b) => a + b, 0) + colCount + 1;
  if (currentWidth > maxColsWidth) {
    let excess = currentWidth - maxColsWidth;
    while (excess > 0) {
      let shrunk = false;
      for (let i = 0; i < widths.length && excess > 0; i++) {
        if ((widths[i] ?? minColWidth) > minColWidth) {
          widths[i] = (widths[i] ?? minColWidth) - 1;
          excess--;
          shrunk = true;
        }
      }
      if (!shrunk) break;
    }
  }

  const table = new Table({
    head: paddedHeader.map((h) => chalk.bold(colors.accentPale(h))),
    colWidths: widths,
    wordWrap: true,
    style: { border: [], head: [] },
    chars: {
      top: colors.muted("─"),
      "top-mid": colors.muted("┬"),
      "top-left": colors.muted("┌"),
      "top-right": colors.muted("┐"),
      bottom: colors.muted("─"),
      "bottom-mid": colors.muted("┴"),
      "bottom-left": colors.muted("└"),
      "bottom-right": colors.muted("┘"),
      left: colors.muted("│"),
      "left-mid": colors.muted("├"),
      mid: colors.muted("─"),
      "mid-mid": colors.muted("┼"),
      right: colors.muted("│"),
      "right-mid": colors.muted("┤"),
      middle: colors.muted("│"),
    },
  });

  for (const row of paddedRows) table.push(row);
  return splitRenderedLines(table.toString()).concat("");
}

function renderList(token: AnyToken, indent: number): string[] {
  const out: string[] = [];
  const ordered = !!token.ordered;
  const start = Number(token.start ?? 1) || 1;
  const items = token.items ?? [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] ?? {};
    const marker = ordered ? `${start + i}.` : "•";
    const itemLines = renderBlockTokens(item.tokens ?? [], indent + 2, true);
    const first = (itemLines[0] ?? "").trimStart();
    out.push(`${" ".repeat(indent)}${marker} ${first}`.trimEnd());
    const continuationPrefix = " ".repeat(indent + marker.length + 1);
    for (let j = 1; j < itemLines.length; j++) {
      out.push(`${continuationPrefix}${itemLines[j] ?? ""}`.trimEnd());
    }
  }

  return out;
}

function renderBlockTokens(tokens: AnyToken[], indent = 0, compact = false): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const t = token.type ?? "";
    if (t === "space") {
      if (!compact) out.push("");
      continue;
    }
    if (t === "heading") {
      out.push(...renderHeading(token));
      continue;
    }
    if (t === "paragraph" || t === "text") {
      const line = renderInlineTokens(token.tokens ?? [{ type: "text", text: token.text ?? "" }]);
      if (line.trim()) out.push(`${" ".repeat(indent)}${line}`.trimEnd());
      if (!compact) out.push("");
      continue;
    }
    if (t === "blockquote") {
      const inner = renderBlockTokens(token.tokens ?? [], indent + 2, true);
      for (const line of inner) out.push(`${colors.muted("│")} ${colors.muted(line)}`.trimEnd());
      if (!compact) out.push("");
      continue;
    }
    if (t === "list") {
      out.push(...renderList(token, indent));
      if (!compact) out.push("");
      continue;
    }
    if (t === "code") {
      out.push(...renderCodeBlock(token));
      continue;
    }
    if (t === "table") {
      out.push(...renderTable(token));
      continue;
    }
    if (t === "hr") {
      out.push(hrLine(), "");
      continue;
    }
    const fallback = (token.text ?? token.raw ?? "").trim();
    if (fallback) {
      out.push(`${" ".repeat(indent)}${fallback}`);
      if (!compact) out.push("");
    }
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

export function renderMarkdown(text: string): string {
  const normalized = preprocessMarkdown(text);
  const tokens = marked.lexer(normalized, { gfm: true, breaks: true }) as AnyToken[];
  const lines = renderBlockTokens(tokens, 0, false)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd();
  return lines;
}

export function separator(): string {
  const cols = process.stdout.columns ?? 80;
  return colors.muted("─".repeat(Math.min(cols, 100)));
}

export function header(title: string, subtitle: string): string {
  return boxen(`${chalk.bold(title)}\n${colors.muted(subtitle)}`, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { bottom: 1 },
    borderColor: inkColors.primary,
    borderStyle: "round",
  });
}

function wrapToWidth(text: string, width: number): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      lines.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > 0) {
      if (rest.length <= width) {
        lines.push(rest);
        break;
      }
      const chunk = rest.slice(0, width);
      const lastSpace = chunk.lastIndexOf(" ");
      const breakAt = lastSpace > width >> 1 ? lastSpace : width;
      lines.push(rest.slice(0, breakAt).trimEnd());
      rest = rest.slice(breakAt).trimStart();
    }
  }
  return lines.join("\n");
}

export function userPromptBox(prompt: string): string {
  const cols = process.stdout.columns ?? 80;
  const boxWidth = Math.max(20, cols - 4);
  const innerWidth = boxWidth - 2 - 2;
  const text = wrapToWidth(prompt.trim() || "\u00A0", innerWidth);
  return boxen(text, {
    width: boxWidth,
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { bottom: 0 },
    borderColor: inkColors.primary,
    borderStyle: "round",
  });
}

const TOOL_INDENT = "  ";
const toolSubdued = chalk.gray;

export function toolCallBox(
  toolName: string,
  argPreview: string,
  success = true,
  extraIndent = 0
): string {
  const indent = TOOL_INDENT + "  ".repeat(Math.max(0, extraIndent));
  const diamondColor = success ? colors.toolSuccess : colors.toolFail;
  const nameColor = diamondColor;
  const argColor = success ? toolSubdued : colors.toolFail;
  const parenColor = colors.mutedDark;
  const name = " " + toolName.trim().toLowerCase();
  return `${indent}${diamondColor(icons.tool)}${nameColor(name)}${parenColor("(")}${argColor(argPreview)}${parenColor(")")}`;
}

export function toolResultLine(preview: string, success = true): string {
  const pipeColor = success ? toolSubdued : colors.toolFail;
  const textColor = success ? toolSubdued : colors.toolFail;
  return `${TOOL_INDENT}${TOOL_INDENT}${pipeColor(icons.pipe + " ")}${textColor(preview)}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export function toolResultTokenLine(tokens: number, success = true, extraIndent = 0): string {
  const indent = TOOL_INDENT + "  ".repeat(Math.max(0, extraIndent));
  const pipeColor = success ? toolSubdued : colors.toolFail;
  const textColor = toolSubdued;
  const tokenStr = `+${formatTokenCount(tokens)} tokens`;
  return `${indent}${TOOL_INDENT}${pipeColor(icons.pipe + " ")}${textColor(tokenStr)}`;
}

export function agentMessage(text: string): string {
  const rendered = renderMarkdown(text.trim());
  return `${colors.accentPale(icons.agent)} ${rendered}`;
}

export function bashOutputLine(line: string): string {
  return `  ${colors.tool(icons.pipe + " ")}${colors.toolDim(line)}`;
}

export { colors, icons, theme, inkColors };
