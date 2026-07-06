import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as cheerio from "cheerio";
import { scoreOpportunity, safeHost } from "./scoring.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4174);
const COMMON_CRAWL_COLLECTIONS = "https://index.commoncrawl.org/collinfo.json";
const USER_AGENT =
  "VercelOpportunityFinder/0.1 (+local research tool; contact: local)";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(init.headers || {})
      }
    });

    const contentType = response.headers.get("content-type") || "";
    const text = contentType.includes("text") || contentType.includes("html")
      ? await response.text()
      : "";

    return {
      status: response.status,
      finalUrl: response.url,
      contentType,
      text: text.slice(0, 350000)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractMeta(html) {
  const $ = cheerio.load(html || "");
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const description =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const robots = $('meta[name="robots"]').attr("content") || "";
  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

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
  const url = normalizeUrl(input.url || input);
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "vercel-opportunity-finder" });
});

app.get("/api/discover/commoncrawl", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 500);
    const suffix = String(req.query.suffix || "vercel.app").replace(/^\*\./, "");
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

    res.json({
      ok: true,
      source: "Common Crawl",
      collection: latest,
      items: uniqueByHost(items).slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/discover/urlscan", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 100);
    const suffix = String(req.query.suffix || "vercel.app").replace(/^\*\./, "");
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

    res.json({
      ok: true,
      source: "URLScan",
      items: uniqueByHost(items).slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const limit = normalizeLimit(req.body?.limit, 80, 150);
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const source = req.body?.source || "Manual";
    const normalized = urls
      .map((item) => (typeof item === "string" ? { url: item } : item))
      .filter((item) => item?.url)
      .slice(0, limit);

    const results = [];
    const concurrency = 10;

    for (let index = 0; index < normalized.length; index += concurrency) {
      const batch = normalized.slice(index, index + concurrency);
      const analyzed = await Promise.all(batch.map((item) => analyzeOne(item, source)));
      results.push(...analyzed);
    }

    res.json({ ok: true, items: results });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

if (process.env.NODE_ENV === "production") {
  const distPath = path.join(__dirname, "..", "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Vercel Opportunity Finder API running at http://127.0.0.1:${PORT}`);
});
