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

function normalizeSuffix(value) {
  const suffix = String(value || "vercel.app")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");

  return suffix || "vercel.app";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rootUrlFromHost(value) {
  try {
    const parsed = new URL(normalizeUrl(value));
    return `https://${parsed.hostname.toLowerCase()}/`;
  } catch {
    return "";
  }
}

function extractHostedUrls(values, suffix) {
  const normalizedSuffix = normalizeSuffix(suffix);
  const escapedSuffix = escapeRegExp(normalizedSuffix);
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const pattern = new RegExp(
    `(?:https?:\\/\\/)?(?:\\*\\.)?${label}(?:\\.${label})*\\.${escapedSuffix}`,
    "gi"
  );
  const urls = [];

  for (const value of values.flat()) {
    const text = String(value || "");
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]
        .replace(/[.,;:!?)}\]]+$/g, "")
        .replace(/^(https?:\/\/)\*\./i, "$1")
        .replace(/^\*\./, "");
      const url = rootUrlFromHost(raw);
      const host = safeHost(url);

      if (!host || host === normalizedSuffix || !host.endsWith(`.${normalizedSuffix}`)) {
        continue;
      }

      urls.push(url);
    }
  }

  return [...new Set(urls)];
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
  const { timeoutMs = 15000, ...fetchInit } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchInit,
      signal: fetchInit.signal || controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...(fetchInit.headers || {})
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
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
  const ogUrl = $('meta[property="og:url"]').attr("content") || "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  return {
    title,
    description: String(description).replace(/\s+/g, " ").trim(),
    h1,
    canonical,
    robots,
    ogTitle: String(ogTitle).replace(/\s+/g, " ").trim(),
    ogUrl,
    wordCount: bodyText ? bodyText.split(/\s+/).length : 0
  };
}

function metadataFromInput(input) {
  const item = typeof input === "object" && input ? input : {};

  return {
    stars: Number(item.stars || 0),
    forks: Number(item.forks || 0),
    openIssues: Number(item.openIssues || 0),
    points: Number(item.points || 0),
    comments: Number(item.comments || 0),
    downloadsWeekly: Number(item.downloadsWeekly || 0),
    downloadsMonthly: Number(item.downloadsMonthly || 0),
    packageName: item.packageName || "",
    repoName: item.repoName || "",
    externalUrl: item.externalUrl || ""
  };
}

async function analyzeOne(input, source = "Manual") {
  const url = normalizeUrl(input.url || input);
  const base = {
    url,
    originalUrl: normalizeUrl(input.originalUrl || input.url || input),
    source: input.source || source,
    discoveredAt: input.discoveredAt || new Date().toISOString(),
    lastSeen: input.lastSeen || input.timestamp || "",
    ...metadataFromInput(input)
  };

  try {
    const response = await fetchText(url);
    const meta = extractMeta(response.text);
    const scored = scoreOpportunity({
      ...base,
      ...meta,
      httpStatus: response.status,
      originalUrl: base.originalUrl,
      url: response.finalUrl || url
    });

    return {
      ...base,
      ...meta,
      ...scored,
      url: response.finalUrl || url,
      originalUrl: base.originalUrl,
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
    const suffix = normalizeSuffix(req.query.suffix);
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
    const suffix = normalizeSuffix(req.query.suffix);
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

app.get("/api/discover/github-repos", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 100);
    const suffix = normalizeSuffix(req.query.suffix);
    const params = new URLSearchParams({
      q: suffix,
      per_page: String(limit)
    });
    const json = await fetchJson(`https://api.github.com/search/repositories?${params}`, {
      headers: {
        accept: "application/vnd.github+json"
      }
    });
    const items = (json.items || []).flatMap((repo) =>
      extractHostedUrls(
        [
          repo.homepage,
          repo.description,
          repo.name,
          repo.full_name,
          repo.html_url
        ],
        suffix
      ).map((url) => ({
        url,
        source: "GitHub Repos",
        title: repo.full_name || repo.name || "",
        lastSeen: repo.pushed_at || repo.updated_at || "",
        stars: repo.stargazers_count || 0,
        forks: repo.forks_count || 0,
        openIssues: repo.open_issues_count || 0,
        repoName: repo.full_name || repo.name || "",
        externalUrl: repo.html_url || ""
      }))
    );

    res.json({
      ok: true,
      source: "GitHub Repos",
      items: uniqueByHost(items).slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/discover/github-issues", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 100);
    const suffix = normalizeSuffix(req.query.suffix);
    const params = new URLSearchParams({
      q: `${suffix} in:title,body`,
      per_page: String(limit)
    });
    const json = await fetchJson(`https://api.github.com/search/issues?${params}`, {
      headers: {
        accept: "application/vnd.github+json"
      }
    });
    const items = (json.items || []).flatMap((issue) =>
      extractHostedUrls([issue.title, issue.body, issue.html_url], suffix).map((url) => ({
        url,
        source: "GitHub Issues",
        title: issue.title || "",
        lastSeen: issue.updated_at || issue.created_at || "",
        comments: issue.comments || 0,
        externalUrl: issue.html_url || ""
      }))
    );

    res.json({
      ok: true,
      source: "GitHub Issues",
      items: uniqueByHost(items).slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/discover/hackernews", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 100);
    const suffix = normalizeSuffix(req.query.suffix);
    const params = new URLSearchParams({
      query: suffix,
      tags: "story",
      hitsPerPage: String(limit)
    });
    const json = await fetchJson(`https://hn.algolia.com/api/v1/search?${params}`);
    const items = (json.hits || []).flatMap((hit) =>
      extractHostedUrls([hit.url, hit.title, hit.story_text], suffix).map((url) => ({
        url,
        source: "Hacker News",
        title: hit.title || "",
        lastSeen: hit.created_at || hit.updated_at || "",
        points: hit.points || 0,
        comments: hit.num_comments || 0,
        externalUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`
      }))
    );

    res.json({
      ok: true,
      source: "Hacker News",
      items: uniqueByHost(items).slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/discover/npm", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 100);
    const suffix = normalizeSuffix(req.query.suffix);
    const params = new URLSearchParams({
      text: suffix,
      size: String(limit)
    });
    const json = await fetchJson(`https://registry.npmjs.org/-/v1/search?${params}`);
    const items = (json.objects || []).flatMap((entry) => {
      const pkg = entry.package || {};
      const links = pkg.links || {};

      return extractHostedUrls(
        [
          pkg.name,
          pkg.description,
          pkg.keywords?.join(" "),
          links.homepage,
          links.repository,
          links.bugs,
          links.npm
        ],
        suffix
      ).map((url) => ({
        url,
        source: "npm",
        title: pkg.name || "",
        lastSeen: pkg.date || entry.updated || "",
        downloadsWeekly: entry.downloads?.weekly || 0,
        downloadsMonthly: entry.downloads?.monthly || 0,
        packageName: pkg.name || "",
        externalUrl: links.npm || ""
      }));
    });

    res.json({
      ok: true,
      source: "npm",
      items: uniqueByHost(items).slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/discover/gitlab", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 100);
    const suffix = normalizeSuffix(req.query.suffix);
    const params = new URLSearchParams({
      search: suffix,
      per_page: String(limit),
      order_by: "last_activity_at",
      sort: "desc"
    });
    const json = await fetchJson(`https://gitlab.com/api/v4/projects?${params}`);
    const items = (json || []).flatMap((project) =>
      extractHostedUrls(
        [
          project.description,
          project.name,
          project.name_with_namespace,
          project.web_url,
          project.readme_url,
          project.topics?.join(" ")
        ],
        suffix
      ).map((url) => ({
        url,
        source: "GitLab",
        title: project.name_with_namespace || project.name || "",
        lastSeen: project.last_activity_at || project.created_at || "",
        stars: project.star_count || 0,
        forks: project.forks_count || 0,
        repoName: project.path_with_namespace || project.name_with_namespace || project.name || "",
        externalUrl: project.web_url || ""
      }))
    );

    res.json({
      ok: true,
      source: "GitLab",
      items: uniqueByHost(items).slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/discover/internet-archive", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 100);
    const suffix = normalizeSuffix(req.query.suffix);
    const params = new URLSearchParams({
      url: `*.${suffix}/*`,
      output: "json",
      fl: "original,timestamp,statuscode,mimetype",
      limit: String(Math.max(limit * 4, 100)),
      collapse: "urlkey"
    });
    params.append("filter", "statuscode:200");
    params.append("filter", "mimetype:text/html");

    const json = await fetchJson(`https://web.archive.org/cdx?${params}`, { timeoutMs: 20000 });
    const rows = Array.isArray(json) ? json.slice(1) : [];
    const items = rows.map((row) => ({
      url: normalizeUrl(row?.[0] || ""),
      source: "Internet Archive",
      lastSeen: row?.[1] || "",
      mime: row?.[3] || "",
      httpStatus: Number(row?.[2] || 0)
    }));

    res.json({
      ok: true,
      source: "Internet Archive",
      items: uniqueByHost(items).slice(0, limit)
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/discover/certificates", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 80, 100);
    const suffix = normalizeSuffix(req.query.suffix);
    const params = new URLSearchParams({
      q: `%.${suffix}`,
      output: "json",
      deduplicate: "Y"
    });
    const json = await fetchJson(`https://crt.sh/?${params}`, { timeoutMs: 20000 });
    const items = (json || []).flatMap((cert) =>
      extractHostedUrls([cert.name_value, cert.common_name], suffix).map((url) => ({
        url,
        source: "crt.sh",
        title: cert.common_name || "",
        lastSeen: cert.entry_timestamp || cert.not_before || ""
      }))
    );

    res.json({
      ok: true,
      source: "crt.sh",
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
