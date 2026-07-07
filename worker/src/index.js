import { scoreOpportunity, safeHost } from "../../server/scoring.js";

const COMMON_CRAWL_COLLECTIONS = "https://index.commoncrawl.org/collinfo.json";
const USER_AGENT =
  "VercelOpportunityFinder/0.1 (+cloudflare-worker; contact: local)";
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function normalizeLimit(value, fallback = 80, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function uniqueByHost(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const host = safeHost(item.url);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    deduped.push(item);
  }

  return deduped;
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [first, second] = parts;

  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254" ||
    host === "[::1]" ||
    isPrivateIPv4(host)
  );
}

function validatePublicHttpUrl(value) {
  const normalized = normalizeUrl(value);
  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }

  if (isBlockedHost(parsed.hostname)) {
    throw new Error("Private and localhost URLs are not allowed");
  }

  return parsed.toString();
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return response.json();
}

async function fetchText(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let currentUrl = validatePublicHttpUrl(url);

  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const response = await fetch(currentUrl, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(init.headers || {})
        }
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        currentUrl = validatePublicHttpUrl(new URL(location, currentUrl).toString());
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      const text = contentType.includes("text") || contentType.includes("html")
        ? await response.text()
        : "";

      return {
        status: response.status,
        finalUrl: response.url || currentUrl,
        contentType,
        text: text.slice(0, 350000)
      };
    }

    throw new Error("Too many redirects");
  } finally {
    clearTimeout(timeout);
  }
}

function getAttr(source, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  return source.match(pattern)?.[1] || "";
}

function stripTags(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMeta(html) {
  const source = String(html || "");
  const title = stripTags(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const h1 = stripTags(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const description =
    getAttr(source.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0] || "", "content") ||
    getAttr(source.match(/<meta[^>]+property=["']og:description["'][^>]*>/i)?.[0] || "", "content") ||
    "";
  const canonical = getAttr(source.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0] || "", "href");
  const robots = getAttr(source.match(/<meta[^>]+name=["']robots["'][^>]*>/i)?.[0] || "", "content");
  const ogTitle = getAttr(source.match(/<meta[^>]+property=["']og:title["'][^>]*>/i)?.[0] || "", "content");
  const bodyText = stripTags(source.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || source);

  return {
    title,
    description: String(description).replace(/\s+/g, " ").trim(),
    h1,
    canonical,
    robots,
    ogTitle: String(ogTitle).replace(/\s+/g, " ").trim(),
    wordCount: bodyText ? bodyText.split(/\s+/).length : 0
  };
}

async function analyzeOne(input, source = "Manual") {
  const rawUrl = input.url || input;
  let url;

  try {
    url = validatePublicHttpUrl(rawUrl);
  } catch (error) {
    const fallbackUrl = normalizeUrl(rawUrl);
    const scored = scoreOpportunity({
      url: fallbackUrl,
      source: input.source || source,
      httpStatus: 0
    });

    return {
      url: fallbackUrl,
      source: input.source || source,
      discoveredAt: input.discoveredAt || new Date().toISOString(),
      lastSeen: input.lastSeen || input.timestamp || "",
      ...scored,
      host: safeHost(fallbackUrl),
      httpStatus: 0,
      ok: false,
      error: error.message || "Invalid URL"
    };
  }

  const base = {
    url,
    source: input.source || source,
    discoveredAt: input.discoveredAt || new Date().toISOString(),
    lastSeen: input.lastSeen || input.timestamp || ""
  };

  try {
    const response = await fetchText(url);
    const meta = extractMeta(response.text);
    const scored = scoreOpportunity({
      ...base,
      ...meta,
      httpStatus: response.status,
      url: response.finalUrl || url
    });

    return {
      ...base,
      ...meta,
      ...scored,
      url: response.finalUrl || url,
      host: safeHost(response.finalUrl || url),
      httpStatus: response.status,
      contentType: response.contentType,
      ok: response.status >= 200 && response.status < 400
    };
  } catch (error) {
    const scored = scoreOpportunity({
      ...base,
      httpStatus: 0
    });

    return {
      ...base,
      ...scored,
      host: safeHost(url),
      httpStatus: 0,
      ok: false,
      error: error.message || "Fetch failed"
    };
  }
}

async function discoverCommonCrawl(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 500);
  const suffix = String(requestUrl.searchParams.get("suffix") || "vercel.app").replace(/^\*\./, "");
  const collections = await fetchJson(COMMON_CRAWL_COLLECTIONS);
  const latest = collections?.[0]?.id;

  if (!latest) {
    throw new Error("No Common Crawl collection found");
  }

  const params = new URLSearchParams({
    url: `*.${suffix}/*`,
    output: "json",
    fl: "url,timestamp,mime,status",
    limit: String(Math.max(limit * 4, 100))
  });
  params.append("filter", "status:200");
  params.append("filter", "mime:text/html");

  const indexUrl = `https://index.commoncrawl.org/${latest}-index?${params}`;
  const response = await fetch(indexUrl, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Common Crawl returned HTTP ${response.status}`);
  }

  const lines = (await response.text()).split("\n").filter(Boolean);
  const items = lines
    .map((line) => {
      try {
        const row = JSON.parse(line);
        return {
          url: normalizeUrl(row.url),
          source: "Common Crawl",
          lastSeen: row.timestamp || "",
          mime: row.mime || "",
          httpStatus: Number(row.status || 0)
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return {
    ok: true,
    source: "Common Crawl",
    collection: latest,
    items: uniqueByHost(items).slice(0, limit)
  };
}

async function discoverUrlscan(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 100);
  const suffix = String(requestUrl.searchParams.get("suffix") || "vercel.app").replace(/^\*\./, "");
  const query = `page.domain:${suffix} AND page.status:200`;
  const params = new URLSearchParams({
    q: query,
    size: String(limit)
  });
  const json = await fetchJson(`https://urlscan.io/api/v1/search/?${params}`);
  const items = (json.results || []).map((result) => ({
    url: normalizeUrl(result.page?.url || result.page?.domain || ""),
    source: "URLScan",
    title: result.page?.title || "",
    lastSeen: result.task?.time || result.indexedAt || "",
    httpStatus: result.page?.status || 0
  }));

  return {
    ok: true,
    source: "URLScan",
    items: uniqueByHost(items).slice(0, limit)
  };
}

async function analyzeUrls(request) {
  const body = await request.json().catch(() => ({}));
  const limit = normalizeLimit(body?.limit, 80, 150);
  const urls = Array.isArray(body?.urls) ? body.urls : [];
  const source = body?.source || "Manual";
  const normalized = urls
    .map((item) => (typeof item === "string" ? { url: item } : item))
    .filter((item) => item?.url)
    .slice(0, limit);

  const results = [];
  const concurrency = 6;

  for (let index = 0; index < normalized.length; index += concurrency) {
    const batch = normalized.slice(index, index + concurrency);
    const analyzed = await Promise.all(batch.map((item) => analyzeOne(item, source)));
    results.push(...analyzed);
  }

  return { ok: true, items: results };
}

async function route(request) {
  const requestUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    return jsonResponse({ ok: true, service: "vercel-opportunity-finder-worker" });
  }

  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/discover/commoncrawl") {
      return jsonResponse(await discoverCommonCrawl(requestUrl));
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/discover/urlscan") {
      return jsonResponse(await discoverUrlscan(requestUrl));
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/analyze") {
      return jsonResponse(await analyzeUrls(request));
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message || "Worker error" }, 502);
  }
}

export default {
  fetch: route
};
