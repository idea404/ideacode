import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "./config.js";

const OWN_PACKAGE_JSON = (() => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, "..", "package.json");
})();

export function getVersion(): string {
  try {
    const raw = fs.readFileSync(OWN_PACKAGE_JSON, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseSemver(s: string): number[] {
  const parts = s.replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

const UPDATE_CHECK_FILE = "last-update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function shouldSkipCheck(): boolean {
  try {
    const file = path.join(getConfigDir(), UPDATE_CHECK_FILE);
    const raw = fs.readFileSync(file, "utf-8");
    const data = JSON.parse(raw) as { lastCheck?: number };
    const last = data.lastCheck ?? 0;
    return Date.now() - last < CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

function markCheckDone(): void {
  try {
    const dir = getConfigDir();
    const file = path.join(dir, UPDATE_CHECK_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lastCheck: Date.now() }), "utf-8");
  } catch {
    /* ignore */
  }
}

export async function checkForUpdate(
  currentVersion: string,
  onNewVersion: (latest: string) => void
): Promise<void> {
  if (process.env.IDEACODE_SHOW_UPDATE_NOTICE) {
    onNewVersion(process.env.IDEACODE_SHOW_UPDATE_NOTICE || "99.0.0");
    return;
  }
  if (shouldSkipCheck()) return;
  try {
    const res = await fetch("https://registry.npmjs.org/ideacode/latest", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest || typeof latest !== "string") return;
    markCheckDone();
    if (isNewer(latest, currentVersion)) onNewVersion(latest);
  } catch {
    /* ignore */
  }
}
