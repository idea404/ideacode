import chalk from "chalk";

export interface ThemeConfig {
  name: string;
  description: string;
  colors: {
    primary: { main: string; dim: string; bright: string; pale: string };
    success: { main: string; dim: string };
    warning: { main: string; dim: string };
    error: { main: string; dim: string };
    muted: { main: string; dim: string; dark: string };
    background: { dark: string; darker: string };
    text: { primary: string; secondary: string; disabled: string };
  };
  ui: {
    borderColor: string;
    selectionColor: string;
    highlightColor: string;
    promptColor: string;
    pathColor: string;
  };
  syntax: {
    keyword: string;
    string: string;
    code: string;
    heading: string;
    link: string;
    href: string;
  };
  icons: {
    prompt: string;
    agent: string;
    tool: string;
    success: string;
    error: string;
    clear: string;
    pipe: string;
    branch: string;
    leaf: string;
    selected: string;
    unselected: string;
  };
}

const ICONS = {
  prompt: "▸",
  agent: ">",
  tool: "◆",
  success: "✓",
  error: "✗",
  clear: "◎",
  pipe: "│",
  branch: "├",
  leaf: "└",
  selected: "›",
  unselected: " ",
} as const;

const THEME_DARK: ThemeConfig = {
  name: "matcha-dark",
  description: "Matcha green theme for dark terminals",
  colors: {
    primary: { main: "#7F9A65", dim: "#5F7E4A", bright: "#9CB482", pale: "#B8C9A9" },
    success: { main: "#86efac", dim: "#4ade80" },
    warning: { main: "#fde047", dim: "#fbbf24" },
    error: { main: "#f87171", dim: "#dc2626" },
    muted: { main: "#8a9a7a", dim: "#6a7a5a", dark: "#4a5a3a" },
    background: { dark: "#1a1a1a", darker: "#0f0f0f" },
    text: { primary: "#e2e8f0", secondary: "#98a08f", disabled: "#6f7867" },
  },
  ui: {
    borderColor: "#7F9A65",
    selectionColor: "#7F9A65",
    highlightColor: "#9CB482",
    promptColor: "#7F9A65",
    pathColor: "#7F9A65",
  },
  syntax: {
    keyword: "#9CB482",
    string: "#86efac",
    code: "#a8b896",
    heading: "#9CB482",
    link: "#7F9A65",
    href: "#5F7E4A",
  },
  icons: { ...ICONS },
};

const THEME_LIGHT: ThemeConfig = {
  name: "matcha-light",
  description: "Matcha green theme for light terminals",
  colors: {
    primary: { main: "#5a7247", dim: "#4a6238", bright: "#6b8f52", pale: "#7a9a5a" },
    success: { main: "#16a34a", dim: "#15803d" },
    warning: { main: "#ca8a04", dim: "#a16207" },
    error: { main: "#dc2626", dim: "#b91c1c" },
    muted: { main: "#6b7a5a", dim: "#5a6a4a", dark: "#4a5a3a" },
    background: { dark: "#f1f5f9", darker: "#e2e8f0" },
    text: { primary: "#1e293b", secondary: "#5f6758", disabled: "#778070" },
  },
  ui: {
    borderColor: "#5a7247",
    selectionColor: "#5a7247",
    highlightColor: "#6b8f52",
    promptColor: "#5a7247",
    pathColor: "#5a7247",
  },
  syntax: {
    keyword: "#4d7c2c",
    string: "#15803d",
    code: "#475569",
    heading: "#4d7c2c",
    link: "#5a7247",
    href: "#4a6238",
  },
  icons: { ...ICONS },
};

function isDarkMode(): boolean {
  const colorFgBg = process.env.COLORFGBG;
  if (!colorFgBg) return true;
  const parts = colorFgBg.split(";");
  const bg = parts[1]?.trim();
  if (bg === "default" || !bg) return true;
  const n = parseInt(bg, 10);
  if (Number.isNaN(n)) return true;
  return n <= 7;
}

const theme: ThemeConfig = isDarkMode() ? THEME_DARK : THEME_LIGHT;

export { theme };

export const colors = {
  accent: chalk.hex(theme.colors.primary.main),
  accentBright: chalk.hex(theme.colors.primary.bright),
  accentPale: chalk.hex(theme.colors.primary.pale),
  accentDim: chalk.hex(theme.colors.primary.dim).dim,
  success: chalk.hex(theme.colors.success.main),
  warn: chalk.hex(theme.colors.warning.main),
  error: chalk.hex(theme.colors.error.main),
  muted: chalk.hex(theme.colors.muted.main),
  tool: chalk.hex(theme.colors.muted.dim),
  toolDim: chalk.hex(theme.colors.muted.dark).dim,
  toolSuccess: chalk.hex("#6b8f71"),
  toolFail: chalk.hex("#b85c5c"),
  dim: chalk.hex(theme.colors.text.disabled).dim,
  bold: chalk.bold,
  italic: chalk.italic,
  gray: chalk.hex(theme.colors.text.secondary),
  mutedDark: chalk.hex(theme.colors.muted.dark),
} as const;

export const inkColors = {
  primary: theme.colors.primary.main,
  primaryDim: theme.colors.primary.dim,
  primaryBright: theme.colors.primary.bright,
  primaryPale: theme.colors.primary.pale,
  success: theme.colors.success.main,
  successDim: theme.colors.success.dim,
  warning: theme.colors.warning.main,
  error: theme.colors.error.main,
  errorDim: theme.colors.error.dim,
  muted: theme.colors.muted.main,
  mutedDim: theme.colors.muted.dim,
  mutedDark: theme.colors.muted.dark,
  border: theme.ui.borderColor,
  selection: theme.ui.selectionColor,
  highlight: theme.ui.highlightColor,
  prompt: theme.ui.promptColor,
  path: theme.ui.pathColor,
  textPrimary: theme.colors.text.primary,
  textSecondary: theme.colors.text.secondary,
  textDisabled: theme.colors.text.disabled,
} as const;

export const icons = theme.icons;
