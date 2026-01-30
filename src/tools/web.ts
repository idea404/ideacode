import { getBraveSearchApiKey } from "../config.js";
import type { ToolArgs } from "./types.js";

const MAX_FETCH_CHARS = 40_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SEARCH_RESULTS = 8;

type SearchHit = { title: string; url: string; snippet?: string };

function formatSearchResults(hits: SearchHit[]): string {
  const slice = hits.slice(0, MAX_SEARCH_RESULTS);
  return slice
    .map(
      (r, i) =>
        `${i + 1}. ${(r.title ?? "Untitled").replace(/<[^>]+>/g, "")}\n   ${r.url ?? ""}${r.snippet ? "\n   " + String(r.snippet).replace(/<[^>]+>/g, "").slice(0, 300) : ""}`
    )
    .join("\n\n");
}

const PLAYWRIGHT_INSTALL_MSG =
  "Playwright Chromium not installed. Run: npx playwright install chromium (in the project directory). web_fetch uses it only when plain fetch fails (e.g. JS-rendered pages).";

function stripHtmlToText(html: string): string {
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "ideacode-web-fetch/1" },
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

export async function webFetch(args: ToolArgs): Promise<string> {
  const url = (args.url as string)?.trim();
  if (!url) return "error: url is required";
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    return "error: url must be http or https";

  try {
    const res = await fetchWithTimeout(url);
    if (res.ok) {
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (
        ct.includes("text/plain") ||
        ct.includes("text/html") ||
        ct.includes("application/json") ||
        ct.includes("text/")
      ) {
        const raw = await res.text();
        const text =
          ct.includes("text/html") && raw.includes("<")
            ? stripHtmlToText(raw)
            : raw.replace(/\s+/g, " ").trim();
        if (text.length > MAX_FETCH_CHARS) {
          return (
            text.slice(0, MAX_FETCH_CHARS) +
            "\n\n... (truncated, total " +
            text.length +
            " chars)"
          );
        }
        return text || "(no text content)";
      }
    }
  } catch {
    // Fall through to Playwright for JS-rendered or when fetch fails
  }

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: FETCH_TIMEOUT_MS });
      const text = await page.evaluate(() => {
        const body = document.body;
        if (!body) return "";
        const clone = body.cloneNode(true) as HTMLElement;
        for (const el of clone.querySelectorAll("script, style, nav, header, footer, [role='navigation']")) {
          el.remove();
        }
        return (clone.innerText ?? clone.textContent ?? "").replace(/\s+/g, " ").trim();
      });
      if (text.length > MAX_FETCH_CHARS) {
        return (
          text.slice(0, MAX_FETCH_CHARS) +
          "\n\n... (truncated, total " +
          text.length +
          " chars)"
        );
      }
      return text || "(no text content)";
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg =
      err instanceof Error && err.cause instanceof Error ? String(err.cause.message) : "";
    const combined = (msg + " " + causeMsg).toLowerCase();
    const needsPlaywright =
      combined.includes("executable doesn't exist") ||
      combined.includes("browser was not found") ||
      combined.includes("chromium revision is not downloaded") ||
      (combined.includes("playwright") && (combined.includes("install") || combined.includes("not found")));
    if (needsPlaywright) {
      return `error: ${PLAYWRIGHT_INSTALL_MSG}`;
    }
    return `error: ${msg}`;
  }
}

async function braveSearchApi(query: string, apiKey: string): Promise<string> {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
    q: query,
    count: String(MAX_SEARCH_RESULTS),
    country: "us",
    search_lang: "en",
  })}`;
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    return `error: Brave Search API ${res.status}: ${text.slice(0, 200)}`;
  }
  const json = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    message?: string;
  };
  if (json.message) return `error: ${json.message}`;
  const results = json.web?.results ?? [];
  if (results.length === 0) return "No results found.";
  const hits: SearchHit[] = results.map((r) => ({
    title: r.title ?? "Untitled",
    url: r.url ?? "",
    snippet: r.description,
  }));
  return formatSearchResults(hits);
}

export async function webSearch(args: ToolArgs): Promise<string> {
  const query = (args.query as string)?.trim();
  if (!query) return "error: query is required";

  const apiKey = getBraveSearchApiKey();
  if (!apiKey) return "error: Brave Search API key not set. Use /brave or set BRAVE_API_KEY (https://brave.com/search/api).";

  try {
    return await braveSearchApi(query, apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: Brave Search API failed. ${msg}`;
  }
}
