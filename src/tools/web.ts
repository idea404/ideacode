import { Buffer } from "node:buffer";
import { getBraveSearchApiKey, getSearxngUrl } from "../config.js";
import type { ToolArgs } from "./types.js";

const MAX_FETCH_CHARS = 40_000;
/** Cap download size before parsing (pdf-parse loads full buffer in memory). */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Cap pages rendered to keep CPU bounded on huge documents. */
const PDF_MAX_PAGES = 120;
const FETCH_TIMEOUT_MS = 20_000;
/** Playwright may need longer for JS-heavy forums and scroll-to-load. */
const PLAYWRIGHT_NAV_TIMEOUT_MS = 35_000;
const PLAYWRIGHT_INITIAL_SETTLE_MS = 600;
const PLAYWRIGHT_SCROLL_STEPS = 12;
const PLAYWRIGHT_SCROLL_PAUSE_MS = 280;
const MAX_SEARCH_RESULTS = 8;
const SEARXNG_TIMEOUT_MS = 20_000;
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

/** Reddit HTML is JS-heavy and often blocks non-browser fetch; public .json for thread URLs works more reliably. */
const BROWSER_LIKE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function isRedditHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "reddit.com" || h.endsWith(".reddit.com");
}

function normalizeRedditThreadUrl(pageUrl: string): URL | null {
  try {
    const u = new URL(pageUrl);
    if (!isRedditHost(u.hostname)) return null;
    const h = u.hostname.toLowerCase();
    if (h === "new.reddit.com" || h === "sh.reddit.com") {
      u.hostname = "www.reddit.com";
    }
    return u;
  } catch {
    return null;
  }
}

/**
 * Map a normal thread URL to Reddit's JSON API (same path + .json).
 * See https://github.com/reddit-archive/reddit/wiki/JSON
 */
function toRedditThreadJsonUrl(pageUrl: string): string | null {
  try {
    const u = normalizeRedditThreadUrl(pageUrl);
    if (!u) return null;
    const path = (u.pathname.replace(/\/$/, "") || "/").split("/").filter(Boolean);
    const rIndex = path.indexOf("r");
    const commentsIndex = path.indexOf("comments");
    if (rIndex < 0 || commentsIndex !== rIndex + 2) return null;
    const postId = path[commentsIndex + 1];
    if (!postId || !/^[a-z0-9]+$/i.test(postId)) return null;
    const basePath = "/" + path.join("/");
    if (basePath.endsWith(".json")) {
      return `${u.origin}${basePath}${u.search}`;
    }
    return `${u.origin}${basePath}.json${u.search}`;
  } catch {
    return null;
  }
}

type RedditListing = { data?: { children?: unknown[] } };

type RedditThing = {
  kind?: string;
  data?: Record<string, unknown>;
};

function redditJsonToThreadText(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const postWrap = raw[0] as RedditListing;
  const postThing = postWrap?.data?.children?.[0] as RedditThing | undefined;
  const pdata = postThing?.data;
  if (!pdata || typeof pdata !== "object") return null;

  const title = String(pdata.title ?? "").trim();
  const selftext = String(pdata.selftext ?? "").trim();
  const author = String(pdata.author ?? "").trim();
  const linkUrl = typeof pdata.url === "string" ? pdata.url.trim() : "";
  const isSelf = pdata.is_self === true;

  const lines: string[] = [];
  if (title) lines.push(`Title: ${title}`);
  if (author) lines.push(`Author: u/${author}`);
  if (selftext && selftext !== "[removed]" && selftext !== "[deleted]") {
    lines.push(selftext);
  } else if (!isSelf && linkUrl) {
    lines.push(`Link: ${linkUrl}`);
  }

  const commentsRoot = (raw[1] as RedditListing | undefined)?.data?.children ?? [];
  const commentLines: string[] = [];
  let n = 0;
  const maxTop = 12;
  const maxDepth = 3;
  const maxComments = 80;

  function walkReplies(thing: unknown, depth: number): void {
    if (n >= maxComments || depth > maxDepth) return;
    const t = thing as RedditThing;
    if (!t || t.kind === "more") return;
    if (t.kind === "t1" && t.data) {
      const body = String(t.data.body ?? "").trim();
      const a = String(t.data.author ?? "").trim();
      if (body && body !== "[removed]" && body !== "[deleted]") {
        n++;
        const indent = "  ".repeat(depth);
        commentLines.push(`${indent}- u/${a}: ${body}`);
      }
      if (depth < maxDepth) {
        const rep = t.data.replies;
        if (rep && typeof rep === "object" && "data" in rep) {
          const children = (rep as RedditListing).data?.children ?? [];
          for (const c of children.slice(0, 12)) {
            walkReplies(c, depth + 1);
          }
        }
      }
    }
  }

  for (const c of commentsRoot.slice(0, maxTop)) {
    walkReplies(c, 0);
  }

  if (commentLines.length > 0) {
    lines.push("");
    lines.push("--- Top comments ---");
    lines.push(...commentLines);
  }

  const out = lines.join("\n").trim();
  return out.length > 0 ? out : null;
}

async function fetchWithTimeoutAndUa(url: string, userAgent: string): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json,text/plain,*/*",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(t);
  }
}

function redditJsonFetchCandidates(pageUrl: string): string[] {
  const primary = toRedditThreadJsonUrl(pageUrl);
  if (!primary) return [];
  const urls = [primary];
  try {
    const u = new URL(primary);
    if (u.hostname === "www.reddit.com") {
      u.hostname = "old.reddit.com";
      urls.push(u.href);
    }
  } catch {
    /* ignore */
  }
  return urls;
}

/** Try Reddit thread JSON API before normal HTML fetch (avoids empty/blocked HTML). */
async function tryRedditThreadJsonFetch(pageUrl: string): Promise<string | null> {
  const candidates = redditJsonFetchCandidates(pageUrl);
  if (candidates.length === 0) return null;
  for (const jsonUrl of candidates) {
    try {
      const res = await fetchWithTimeoutAndUa(jsonUrl, BROWSER_LIKE_UA);
      if (!res.ok) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(await res.text());
      } catch {
        continue;
      }
      const text = redditJsonToThreadText(raw);
      if (text && text.trim().length >= 12) return text;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

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

/**
 * Plain fetch + htmlToText often captures only the first forum post; use Playwright for fuller threads.
 */
function shouldAugmentForumWithPlaywright(urlStr: string, extractedText: string): boolean {
  if (extractedText.length >= 12_000) return false;
  try {
    const u = new URL(urlStr);
    const p = u.pathname;
    const looksThread =
      /\/threads\//i.test(p) ||
      /\/topic\//i.test(p) ||
      /^\/t\/[^/]+/i.test(p) ||
      /\/discussion(s)?\//i.test(p);
    return looksThread;
  } catch {
    return false;
  }
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

/** old.reddit.com renders more HTML server-side; new Reddit often yields empty text in headless mode. */
function playwrightTargetUrl(pageUrl: string): string {
  const nu = normalizeRedditThreadUrl(pageUrl);
  if (!nu) return pageUrl;
  const h = nu.hostname.toLowerCase();
  if (h === "www.reddit.com" || h === "reddit.com") {
    nu.hostname = "old.reddit.com";
    return nu.href;
  }
  return pageUrl;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs in the browser (Playwright). Kept as a string so `tsx`/esbuild does not inject
 * helpers like `__name` into `page.evaluate` callbacks (breaks at runtime).
 */
const PLAYWRIGHT_EXTRACT_TEXT_EXPR = `(() => {
  var stripNoise = function (el) {
    var clone = el.cloneNode(true);
    clone
      .querySelectorAll(
        "script, style, nav, header, footer, aside, form, noscript, svg, iframe, .js-noSelect, .shareButtons"
      )
      .forEach(function (rm) {
        rm.remove();
      });
    var s = clone.innerText || clone.textContent || "";
    return s
      .replace(/[ \\t]+/g, " ")
      .replace(/ *\\n */g, "\\n")
      .replace(/\\n{3,}/g, "\\n\\n")
      .trim();
  };
  var joinPosts = function (nodes, label) {
    var chunks = [];
    var n = 0;
    for (var i = 0; i < nodes.length; i++) {
      var t = stripNoise(nodes[i]);
      if (t.length > 20) {
        n++;
        chunks.push(label + " " + n + "\\n" + t);
      }
    }
    return chunks.length > 0 ? chunks.join("\\n\\n---\\n\\n") : "";
  };
  var xf = document.querySelectorAll(".message--post .message-body .bbWrapper");
  if (xf.length > 0) {
    var ox = joinPosts(xf, "Post");
    if (ox.length > 80) return ox;
  }
  var discourse = document.querySelectorAll(".topic-post .cooked, .post.regular .cooked");
  if (discourse.length > 0) {
    var od = joinPosts(discourse, "Post");
    if (od.length > 80) return od;
  }
  var phpbb = document.querySelectorAll("div.postbody div.content, .post .postbody");
  if (phpbb.length >= 1) {
    var op = joinPosts(phpbb, "Post");
    if (op.length > 80) return op;
  }
  var root =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body;
  if (!root) return "";
  var c = root.cloneNode(true);
  c.querySelectorAll("script, style, nav, header, footer, aside, form, noscript, svg").forEach(function (e) {
    e.remove();
  });
  var out = c.innerText || c.textContent || "";
  return out
    .replace(/[ \\t]+/g, " ")
    .replace(/ *\\n */g, "\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
})()`;

async function fetchWithPlaywright(url: string): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PLAYWRIGHT_NAV_TIMEOUT_MS });
    await sleepMs(PLAYWRIGHT_INITIAL_SETTLE_MS);
    for (let i = 0; i < PLAYWRIGHT_SCROLL_STEPS; i++) {
      await page.mouse.wheel(0, Math.max(500, (await page.viewportSize())?.height ?? 800));
      await sleepMs(PLAYWRIGHT_SCROLL_PAUSE_MS);
    }

    const text = (await page.evaluate(PLAYWRIGHT_EXTRACT_TEXT_EXPR)) as string;
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

  const redditText = await tryRedditThreadJsonFetch(url);
  if (redditText) {
    const clipped = clipOutput(redditText);
    setCachedFetch(url, clipped);
    return clipped;
  }

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
        } else if (ct.includes("html") && shouldAugmentForumWithPlaywright(url, normalized)) {
          needsBrowserFallback = true;
          fallbackReason = "forum thread (full page render)";
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
    const browserText = await fetchWithPlaywright(playwrightTargetUrl(url));
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

function searxngSearchEndpoint(baseUrl: string): string {
  let s = baseUrl.trim().replace(/\/+$/, "");
  if (s.toLowerCase().endsWith("/search")) {
    s = s.slice(0, -"/search".length).replace(/\/+$/, "");
  }
  const withSlash = s.endsWith("/") ? s : `${s}/`;
  return new URL("search", withSlash).href;
}

const SEARXNG_403_HINT =
  " For self-hosted instances: in settings.yml set server.limiter: false or allow your client IP; ensure JSON is not blocked. Public instances often return 403/captcha for API-style requests — use your own Docker instance or Brave fallback.";

async function searxngSearch(query: string, baseUrl: string): Promise<string> {
  const endpoint = searxngSearchEndpoint(baseUrl);
  const url = `${endpoint}?${new URLSearchParams({
    q: query,
    format: "json",
    categories: "general",
  })}`;
  const refererRoot = baseUrl.trim().replace(/\/+$/, "") + "/";
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_LIKE_UA,
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: refererRoot,
      },
      signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: SearXNG request failed (${msg}). Is the instance running and JSON format enabled?`;
  }
  if (!res.ok) {
    const text = await res.text();
    const hint = res.status === 403 || res.status === 429 ? SEARXNG_403_HINT : "";
    return `error: SearXNG ${res.status}: ${text.slice(0, 200)}${hint}`;
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return "error: SearXNG returned invalid JSON. Check format=json is allowed on your instance.";
  }
  const results = (json as { results?: Array<{ title?: string; url?: string; content?: string }> })
    ?.results;
  if (!Array.isArray(results) || results.length === 0) return "No results found.";
  const hits: SearchHit[] = results.map((r) => ({
    title: r.title ?? "Untitled",
    url: r.url ?? "",
    snippet: r.content,
  }));
  return formatSearchResults(hits);
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

  let searxErr: string | undefined;
  const searxBase = getSearxngUrl();
  if (searxBase) {
    const out = await searxngSearch(query, searxBase);
    if (!out.startsWith("error:")) return out;
    searxErr = out;
  }

  const apiKey = getBraveSearchApiKey();
  if (apiKey) {
    try {
      return await braveSearchApi(query, apiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (searxErr) return `${searxErr}\nBrave fallback failed: ${msg}`;
      return `error: Brave Search API failed. ${msg}`;
    }
  }

  if (searxErr) return searxErr;
  return "error: Web search not configured. Set SEARXNG_URL or /searxng (SearXNG, preferred), or BRAVE_API_KEY / /brave.";
}
