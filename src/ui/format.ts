import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import boxen from "boxen";
import { colors, icons, theme, inkColors } from "./theme.js";

const hrLine = () => {
  const cols = process.stdout.columns ?? 80;
  return colors.muted("─".repeat(Math.min(cols, 100)));
};

marked.use(
  markedTerminal(
    {
      code: chalk.hex(theme.syntax.code),
      codespan: chalk.hex(theme.syntax.code),
      blockquote: chalk.hex(theme.colors.muted.main).italic,
      strong: chalk.bold,
      em: chalk.italic,
      heading: chalk.hex(theme.syntax.heading).bold,
      firstHeading: chalk.hex(theme.colors.primary.dim).underline.bold,
      link: chalk.hex(theme.syntax.link),
      href: chalk.hex(theme.syntax.href).underline,
      hr: () => hrLine(),
    },
    { theme: { keyword: chalk.hex(theme.syntax.keyword), string: chalk.hex(theme.syntax.string) } }
  )
);

const codeStyle = (s: string) => chalk.hex(theme.syntax.code)(s);

export function renderMarkdown(text: string): string {
  let out = marked.parse(text, { async: false }) as string;
  out = out.replace(/\`([^`]+)\`/g, (_, code) => codeStyle(code));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, boldText) => chalk.bold(boldText));
  out = out.replace(/(^|\n)\* /g, "$1• ");
  out = out.replace(/(^|\n)([ \t]*[-*_]{3,}[ \t]*)(\n|$)/gm, (_, before, _rule, after) => before + hrLine() + after);
  return out;
}

export function separator(): string {
  const cols = process.stdout.columns ?? 80;
  return colors.muted("─".repeat(Math.min(cols, 100)));
}

export function header(title: string, subtitle: string): string {
  return boxen(
    `${chalk.bold(title)}\n${colors.muted(subtitle)}`,
    {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { bottom: 1 },
      borderColor: inkColors.primary,
      borderStyle: "round",
    }
  );
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
  const text = wrapToWidth((prompt.trim() || "\u00A0"), innerWidth);
  return boxen(text, {
    width: boxWidth,
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { bottom: 0 },
    borderColor: inkColors.primary,
    borderStyle: "round",
  });
}

const TOOL_INDENT = "  ";
const toolSubdued = chalk.hex("#3d3d3d");

export function toolCallBox(toolName: string, argPreview: string, success = true): string {
  const diamondColor = success ? colors.toolSuccess : colors.toolFail;
  const nameColor = success ? colors.toolSuccess : colors.toolFail;
  const argColor = success ? toolSubdued : colors.toolFail;
  const parenColor = chalk.white;
  const name = " " + toolName.charAt(0).toUpperCase() + toolName.slice(1);
  return `${TOOL_INDENT}${diamondColor(icons.tool)}${nameColor(name)}${parenColor("(")}${argColor(argPreview)}${parenColor(")")}`;
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

export function toolResultTokenLine(tokens: number, success = true): string {
  const pipeColor = success ? toolSubdued : colors.toolFail;
  const textColor = success ? toolSubdued : colors.toolFail;
  const tokenStr = `+${formatTokenCount(tokens)} tokens`;
  return `${TOOL_INDENT}${TOOL_INDENT}${pipeColor(icons.pipe + " ")}${textColor(tokenStr)}`;
}

export function agentMessage(text: string): string {
  const rendered = renderMarkdown(text.trim());
  return `${colors.accentPale(icons.agent)} ${rendered}`;
}

export function bashOutputLine(line: string): string {
  return `  ${colors.tool(icons.pipe + " ")}${colors.toolDim(line)}`;
}

export { colors, icons, theme, inkColors };
