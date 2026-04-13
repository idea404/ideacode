import { Buffer } from "node:buffer";
import { getBraveSearchApiKey } from "../config.js";
import type { ToolArgs } from "./types.js";

const MAX_FETCH_CHARS = 40_000;
/** Cap download size before parsing (pdf-parse loads full buffer in memory). */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Cap pages rendered to keep CPU bounded on huge documents. */
const PDF_MAX_PAGES = 120;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SEARCH_RESULTS = 8;
const FETCH_CACHE_TTL_MS = 5 * 60_000;

type SearchHit = { title: string; url: string; snippet?: string };
type FetchCacheEntry = { cachedAt: number; value: string };

const fetchCache = new Map<string, FetchCacheEntry>();

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
  "Playwright Chromium not installed. Run: npx playwright install chromium (in the project directory). web_fetch uses it only when plain fetch cannot reliably extract content.";

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const n = Number.parseInt(dec, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    });
}

function pickMainHtml(html: string): string {
  const article = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i)?.[0];
  if (article) return article;
  const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0];
  if (main) return main;
  return html;
}

function htmlToText(html: string): string {
  const focused = pickMainHtml(html);
  let s = focused
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, "")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");

  s = decodeHtmlEntities(s);
  s = s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

function isLikelyBlockedOrThin(text: string): boolean {
  const lowered = text.toLowerCase();
  const blockedSignals = [
    "enable javascript",
    "verify you are human",
    "captcha",
    "cloudflare",
    "access denied",
    "unusual traffic",
    "robot",
    "bot detection",
    "request blocked",
    "forbidden",
  ];
  if (blockedSignals.some((s) => lowered.includes(s))) return true;
  return text.length < 280;
}

function clipOutput(text: string): string {
  if (text.length <= MAX_FETCH_CHARS) return text;
  return text.slice(0, MAX_FETCH_CHARS) + `\n\n... (truncated, total ${text.length} chars)`;
}

function getCachedFetch(url: string): string | null {
  const hit = fetchCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > FETCH_CACHE_TTL_MS) {
    fetchCache.delete(url);
    return null;
  }
  return hit.value;
}

function setCachedFetch(url: string, value: string): void {
  fetchCache.set(url, { cachedAt: Date.now(), value });
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "ideacode-web-fetch/2",
        Accept: "text/html,application/json,text/plain,application/pdf,*/*",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(t);
  }
}

function isPdfPathname(urlStr: string): boolean {
  try {
    return /\.pdf(?:$|[?#])/i.test(new URL(urlStr).pathname);
  } catch {
    return false;
  }
}

function looksLikePdfBuffer(buf: Buffer): boolean {
  if (buf.length < 5) return false;
  return buf.subarray(0, 5).toString("ascii") === "%PDF-";
}

function shouldTreatResponseAsPdfAttempt(ct: string, urlStr: string): boolean {
  const c = ct.toLowerCase();
  if (c.includes("application/pdf") || c.includes("application/x-pdf") || c.includes("application/acrobat")) {
    return true;
  }
  if (isPdfPathname(urlStr)) return true;
  if (c.includes("application/octet-stream") || c.includes("binary/octet-stream")) return true;
  return false;
}

async function extractTextFromPdfBuffer(buf: Buffer): Promise<{ text: string; pageNote: string }> {
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(buf, { max: PDF_MAX_PAGES });
  const raw = String(result.text ?? "")
    .replace(/\u0000/g, "")
    .trim();
  let pageNote = "";
  if (result.numpages > result.numrender) {
    pageNote = `\n\n... (PDF has ${result.numpages} pages; extracted text from the first ${result.numrender} pages.)`;
  }
  return { text: raw, pageNote };
}

async function fetchWithPlaywright(url: string): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: FETCH_TIMEOUT_MS });
    const text = await page.evaluate(() => {
      const root =
        document.querySelector("article") ??
        document.querySelector("main") ??
        document.querySelector("[role='main']") ??
        document.body;
      if (!root) return "";
      const clone = root.cloneNode(true) as HTMLElement;
      for (const el of clone.querySelectorAll("script, style, nav, header, footer, aside, form, noscript, svg")) {
        el.remove();
      }
      return (clone.innerText ?? clone.textContent ?? "")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    });
    return text || "(no text content)";
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function webFetch(args: ToolArgs): Promise<string> {
  const url = (args.url as string)?.trim();
  if (!url) return "error: url is required";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "error: url must be http or https";
  }

  const cached = getCachedFetch(url);
  if (cached) return cached;

  let needsBrowserFallback = false;
  let fallbackReason = "";

  try {
    const res = await fetchWithTimeout(url);
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();

    if (res.ok) {
      if (ct.includes("application/json")) {
        const raw = await res.text();
        const clipped = clipOutput(raw.trim() || "(no text content)");
        setCachedFetch(url, clipped);
        return clipped;
      }

      if (shouldTreatResponseAsPdfAttempt(ct, url)) {
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length > MAX_PDF_BYTES) {
          return `error: PDF too large (${buf.length} bytes; max ${MAX_PDF_BYTES} bytes)`;
        }
        if (!looksLikePdfBuffer(buf)) {
          const head = buf
            .subarray(0, Math.min(120, buf.length))
            .toString("utf8")
            .replace(/\s+/g, " ")
            .trim();
          if (isPdfPathname(url) || ct.toLowerCase().includes("pdf")) {
            return `error: expected a PDF, but the body does not start with %PDF- (preview: ${head.slice(0, 96)}…)`;
          }
          return `error: binary response is not a PDF (starts with: ${head.slice(0, 96)}…)`;
        }
        try {
          const { text, pageNote } = await extractTextFromPdfBuffer(buf);
          const combined = (text || "") + pageNote;
          if (!combined.trim()) {
            return "error: PDF has no extractable text (may be image-only, empty, or password-protected)";
          }
          const clipped = clipOutput(combined.trim());
          setCachedFetch(url, clipped);
          return clipped;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `error: PDF parse failed: ${msg}`;
        }
      }

      if (ct.includes("text/plain") || ct.includes("text/") || ct.includes("application/xml") || ct.includes("application/xhtml")) {
        const raw = await res.text();
        const normalized = ct.includes("html") ? htmlToText(raw) : raw.replace(/\s+/g, " ").trim();
        if (!normalized) {
          needsBrowserFallback = true;
          fallbackReason = "empty fetch result";
        } else if (ct.includes("html") && isLikelyBlockedOrThin(normalized)) {
          needsBrowserFallback = true;
          fallbackReason = "thin or blocked html content";
        } else {
          const clipped = clipOutput(normalized);
          setCachedFetch(url, clipped);
          return clipped;
        }
      } else {
        return `error: unsupported content-type: ${ct || "unknown"}`;
      }
    } else {
      const bodyPreview = (await res.text()).slice(0, 220);
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        needsBrowserFallback = true;
        fallbackReason = `http ${res.status}`;
      } else {
        return `error: HTTP ${res.status}${bodyPreview ? `: ${bodyPreview}` : ""}`;
      }
    }
  } catch {
    needsBrowserFallback = true;
    fallbackReason = "fetch failed";
  }

  if (!needsBrowserFallback) return "error: unable to fetch content";

  try {
    const browserText = await fetchWithPlaywright(url);
    const clipped = clipOutput(browserText);
    setCachedFetch(url, clipped);
    return clipped;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg = err instanceof Error && err.cause instanceof Error ? String(err.cause.message) : "";
    const combined = (msg + " " + causeMsg).toLowerCase();
    const needsPlaywrightInstall =
      combined.includes("executable doesn't exist") ||
      combined.includes("browser was not found") ||
      combined.includes("chromium revision is not downloaded") ||
      (combined.includes("playwright") && (combined.includes("install") || combined.includes("not found")));

    if (needsPlaywrightInstall) return `error: ${PLAYWRIGHT_INSTALL_MSG}`;

    return `error: web_fetch failed after ${fallbackReason || "fallback"}. ${msg}`;
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
