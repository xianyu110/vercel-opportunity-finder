import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as cheerio from "cheerio";
import { scoreOpportunity, safeHost } from "./scoring.js";
import {
  mergeCandidatesByHost,
  selectAnalysisBatch
} from "./candidates.js";
import {
  saveSnapshot,
  listSnapshots,
  getSnapshot,
  compareLatest,
  getRisingHosts,
  attachHistorySignals
} from "./history.js";
import {
  aggregateUrlscanMomentum,
  enrichItemsWithMomentum
} from "./momentum.js";
import { enrichItemsWithCompetition } from "./competition.js";
import { extractMaturityFromHtml } from "./maturity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4174);
const COMMON_CRAWL_COLLECTIONS = "https://index.commoncrawl.org/collinfo.json";
const USER_AGENT =
  "VercelOpportunityFinder/0.3 (+local research tool; contact: local)";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

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
  return mergeCandidatesByHost(items);
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
  const host = String(hostname || "").toLowerCase();
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

function githubHeaders() {
  return {
    accept: "application/vnd.github+json",
    ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {})
  };
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
  const timeout = setTimeout(() => controller.abort(), 8000);
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
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const maturityFeatures = extractMaturityFromHtml(html, { wordCount });

  return {
    title,
    description: String(description).replace(/\s+/g, " ").trim(),
    h1,
    canonical,
    robots,
    ogTitle: String(ogTitle).replace(/\s+/g, " ").trim(),
    ogUrl,
    wordCount,
    ...maturityFeatures
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
    externalUrl: item.externalUrl || "",
    redditScore: Number(item.redditScore || 0),
    redditComments: Number(item.redditComments || 0),
    stackOverflowAnswers: Number(item.stackOverflowAnswers || 0),
    scanCount7d: Number(item.scanCount7d || 0),
    scanCountPrev7d: Number(item.scanCountPrev7d || 0),
    scanCount30d: Number(item.scanCount30d || 0),
    scanMomentum: Number(item.scanMomentum || 0),
    history: item.history || null,
    competitionScore: Number(item.competitionScore || 0),
    competitorCount: Number(item.competitorCount || 0),
    competitionLabel: item.competitionLabel || "",
    maturityScore: Number(item.maturityScore || 0),
    blogLinks: Number(item.blogLinks || 0),
    toolLinks: Number(item.toolLinks || 0),
    faqHits: Number(item.faqHits || 0),
    h2Count: Number(item.h2Count || 0)
  };
}

function rescoreItem(item) {
  const scored = scoreOpportunity(item);
  return {
    ...item,
    ...scored,
    host: item.host || safeHost(item.url)
  };
}

async function analyzeOne(input, source = "Manual") {
  const rawUrl = input.url || input;
  let url;

  try {
    url = validatePublicHttpUrl(rawUrl);
  } catch (error) {
    const fallbackUrl = normalizeUrl(rawUrl);
    const base = {
      url: fallbackUrl,
      originalUrl: fallbackUrl,
      source: input.source || source,
      sources: input.sources || (input.source ? [input.source] : [source]),
      discoveredAt: input.discoveredAt || new Date().toISOString(),
      lastSeen: input.lastSeen || input.timestamp || "",
      priorityScore: input.priorityScore || 0,
      ...metadataFromInput(input)
    };
    const scored = scoreOpportunity({ ...base, httpStatus: 0 });
    return {
      ...base,
      ...scored,
      host: safeHost(fallbackUrl),
      httpStatus: 0,
      ok: false,
      error: error.message || "Invalid URL"
    };
  }

  const base = {
    url,
    originalUrl: normalizeUrl(input.originalUrl || rawUrl),
    source: input.source || source,
    sources: input.sources || (input.source ? [input.source] : [source]),
    discoveredAt: input.discoveredAt || new Date().toISOString(),
    lastSeen: input.lastSeen || input.timestamp || "",
    priorityScore: input.priorityScore || 0,
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

const DISCOVER_HANDLERS = {
  commoncrawl: async ({ suffix, limit }) => {
    const collections = await fetchJson(COMMON_CRAWL_COLLECTIONS);
    const latest = collections?.[0]?.id;
    if (!latest) throw new Error("No Common Crawl collection found");

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
    if (!response.ok) throw new Error(`Common Crawl returned HTTP ${response.status}`);

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
  },
  urlscan: async ({ suffix, limit }) => {
    // Pull a wider window so we can approximate 7d vs prev-7d scan density.
    const params = new URLSearchParams({
      q: `page.domain:${suffix} AND page.status:200`,
      size: String(Math.min(100, Math.max(limit * 2, 40)))
    });
    const json = await fetchJson(`https://urlscan.io/api/v1/search/?${params}`);
    const aggregated = aggregateUrlscanMomentum(json.results || []);
    const items = aggregated
      .filter((item) => item.host.endsWith(`.${suffix}`) || item.host === suffix)
      .map((item) => ({
        ...item,
        url: normalizeUrl(item.url),
        source: "URLScan"
      }));
    return {
      ok: true,
      source: "URLScan",
      items: uniqueByHost(items)
        .sort((a, b) => (b.scanMomentum || 0) - (a.scanMomentum || 0))
        .slice(0, limit)
    };
  },
  reddit: async ({ suffix, limit }) => {
    const params = new URLSearchParams({
      q: suffix,
      sort: "new",
      limit: String(Math.min(100, Math.max(limit, 25))),
      t: "month",
      type: "link,self"
    });
    const json = await fetchJson(`https://www.reddit.com/search.json?${params}`, {
      timeoutMs: 15000
    });
    const posts = json?.data?.children || [];
    const items = posts.flatMap((entry) => {
      const post = entry.data || {};
      return extractHostedUrls(
        [post.url, post.selftext, post.title, post.permalink],
        suffix
      ).map((url) => ({
        url,
        source: "Reddit",
        title: post.title || "",
        lastSeen: post.created_utc
          ? new Date(post.created_utc * 1000).toISOString()
          : "",
        redditScore: post.score || 0,
        redditComments: post.num_comments || 0,
        points: post.score || 0,
        comments: post.num_comments || 0,
        externalUrl: post.permalink ? `https://www.reddit.com${post.permalink}` : ""
      }));
    });
    return { ok: true, source: "Reddit", items: uniqueByHost(items).slice(0, limit) };
  },
  producthunt: async ({ suffix, limit }) => {
    // Best-effort: Product Hunt public Algolia index (search-only). May break if keys rotate.
    const endpoint =
      "https://0h4smabbsg-dsn.algolia.net/1/indexes/Post_production/query";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-algolia-application-id": "0H4SMABBSG",
        "x-algolia-api-key": "9670d2d619b9d07859448d7628eea5f3",
        "user-agent": USER_AGENT
      },
      body: JSON.stringify({
        query: suffix,
        hitsPerPage: Math.min(50, Math.max(limit, 20))
      })
    });
    if (!response.ok) {
      throw new Error(`Product Hunt search HTTP ${response.status}`);
    }
    const json = await response.json();
    const items = (json.hits || []).flatMap((hit) =>
      extractHostedUrls(
        [
          hit.name,
          hit.tagline,
          hit.description,
          hit.url,
          hit.website,
          hit.product_links?.map((link) => link.url).join(" ")
        ],
        suffix
      ).map((url) => ({
        url,
        source: "Product Hunt",
        title: hit.name || hit.tagline || "",
        lastSeen: hit.created_at || hit.featured_at || "",
        points: hit.votes_count || hit.points || 0,
        comments: hit.comments_count || 0,
        externalUrl: hit.slug ? `https://www.producthunt.com/posts/${hit.slug}` : ""
      }))
    );
    return {
      ok: true,
      source: "Product Hunt",
      items: uniqueByHost(items).slice(0, limit)
    };
  },
  stackoverflow: async ({ suffix, limit }) => {
    const params = new URLSearchParams({
      order: "desc",
      sort: "activity",
      q: suffix,
      site: "stackoverflow",
      pagesize: String(Math.min(50, Math.max(limit, 20))),
      filter: "withbody"
    });
    const json = await fetchJson(
      `https://api.stackexchange.com/2.3/search/advanced?${params}`,
      { timeoutMs: 15000 }
    );
    const items = (json.items || []).flatMap((post) =>
      extractHostedUrls([post.title, post.body, post.link], suffix).map((url) => ({
        url,
        source: "Stack Overflow",
        title: post.title || "",
        lastSeen: post.last_activity_date
          ? new Date(post.last_activity_date * 1000).toISOString()
          : "",
        stackOverflowAnswers: post.answer_count || 0,
        points: post.score || 0,
        comments: post.answer_count || 0,
        externalUrl: post.link || ""
      }))
    );
    return {
      ok: true,
      source: "Stack Overflow",
      items: uniqueByHost(items).slice(0, limit)
    };
  },
  bluesky: async ({ suffix, limit }) => {
    const params = new URLSearchParams({
      q: suffix,
      limit: String(Math.min(100, Math.max(limit, 25)))
    });
    const json = await fetchJson(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?${params}`,
      { timeoutMs: 15000 }
    );
    const items = (json.posts || []).flatMap((post) => {
      const record = post.record || {};
      const author = post.author?.handle || "";
      const text = record.text || "";
      const embedUris = [];
      const external = post.embed?.external || post.embed?.record?.embed?.external;
      if (external?.uri) embedUris.push(external.uri);
      if (Array.isArray(record.facets)) {
        for (const facet of record.facets) {
          for (const feature of facet.features || []) {
            if (feature.uri) embedUris.push(feature.uri);
          }
        }
      }

      return extractHostedUrls([text, ...embedUris, author], suffix).map((url) => ({
        url,
        source: "Bluesky",
        title: text.slice(0, 120) || author,
        lastSeen: record.createdAt || post.indexedAt || "",
        points: post.likeCount || 0,
        comments: post.replyCount || 0,
        externalUrl: post.uri
          ? `https://bsky.app/profile/${author}/post/${String(post.uri).split("/").pop()}`
          : ""
      }));
    });
    return {
      ok: true,
      source: "Bluesky",
      items: uniqueByHost(items).slice(0, limit)
    };
  },
  "github-repos": async ({ suffix, limit }) => {
    const params = new URLSearchParams({
      q: suffix,
      per_page: String(Math.min(limit, 100))
    });
    const json = await fetchJson(`https://api.github.com/search/repositories?${params}`, {
      headers: githubHeaders()
    });
    const items = (json.items || []).flatMap((repo) =>
      extractHostedUrls(
        [repo.homepage, repo.description, repo.name, repo.full_name, repo.html_url],
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
    return { ok: true, source: "GitHub Repos", items: uniqueByHost(items).slice(0, limit) };
  },
  "github-issues": async ({ suffix, limit }) => {
    const params = new URLSearchParams({
      q: `${suffix} in:title,body`,
      per_page: String(Math.min(limit, 100))
    });
    const json = await fetchJson(`https://api.github.com/search/issues?${params}`, {
      headers: githubHeaders()
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
    return { ok: true, source: "GitHub Issues", items: uniqueByHost(items).slice(0, limit) };
  },
  hackernews: async ({ suffix, limit }) => {
    const params = new URLSearchParams({
      query: suffix,
      tags: "story",
      hitsPerPage: String(Math.min(limit, 100))
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
    return { ok: true, source: "Hacker News", items: uniqueByHost(items).slice(0, limit) };
  },
  npm: async ({ suffix, limit }) => {
    const params = new URLSearchParams({
      text: suffix,
      size: String(Math.min(limit, 100))
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
    return { ok: true, source: "npm", items: uniqueByHost(items).slice(0, limit) };
  },
  gitlab: async ({ suffix, limit }) => {
    const params = new URLSearchParams({
      search: suffix,
      per_page: String(Math.min(limit, 100)),
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
    return { ok: true, source: "GitLab", items: uniqueByHost(items).slice(0, limit) };
  },
  "internet-archive": async ({ suffix, limit }) => {
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
    return { ok: true, source: "Internet Archive", items: uniqueByHost(items).slice(0, limit) };
  },
  certificates: async ({ suffix, limit }) => {
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
    return { ok: true, source: "crt.sh", items: uniqueByHost(items).slice(0, limit) };
  }
};


function mountDiscoverGet(pathKey, handlerKey) {
  app.get(`/api/discover/${pathKey}`, async (req, res) => {
    try {
      const limit = normalizeLimit(req.query.limit, 80, handlerKey === "commoncrawl" ? 500 : 100);
      const suffix = normalizeSuffix(req.query.suffix);
      const payload = await DISCOVER_HANDLERS[handlerKey]({ suffix, limit });
      res.json(payload);
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });
}

const DISCOVER_GET_ROUTES = [
  ["commoncrawl", "commoncrawl"],
  ["urlscan", "urlscan"],
  ["github-repos", "github-repos"],
  ["github-issues", "github-issues"],
  ["hackernews", "hackernews"],
  ["npm", "npm"],
  ["gitlab", "gitlab"],
  ["reddit", "reddit"],
  ["producthunt", "producthunt"],
  ["stackoverflow", "stackoverflow"],
  ["bluesky", "bluesky"],
  ["internet-archive", "internet-archive"],
  ["certificates", "certificates"]
];

for (const [pathKey, handlerKey] of DISCOVER_GET_ROUTES) {
  mountDiscoverGet(pathKey, handlerKey);
}

app.post("/api/discover", async (req, res) => {
  try {
    const suffix = normalizeSuffix(req.body?.suffix || "vercel.app");
    const limit = normalizeLimit(req.body?.limit, 40, 150);
    const sources = Array.isArray(req.body?.sources) ? req.body.sources : Object.keys(DISCOVER_HANDLERS);
    const selected = sources
      .map((key) => String(key || "").trim())
      .filter((key) => DISCOVER_HANDLERS[key]);

    if (!selected.length) {
      return res.status(400).json({ ok: false, error: "No valid sources selected" });
    }

    const settled = await Promise.allSettled(
      selected.map(async (key) => {
        const result = await DISCOVER_HANDLERS[key]({ suffix, limit });
        return { key, ...result };
      })
    );

    const items = [];
    const sourceResults = [];
    const errors = [];

    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        const payload = entry.value;
        items.push(...(payload.items || []));
        sourceResults.push({
          key: payload.key,
          source: payload.source,
          ok: true,
          count: (payload.items || []).length
        });
      } else {
        errors.push(entry.reason?.message || "Discovery failed");
      }
    }

    const merged = uniqueByHost(items);

    res.json({
      ok: true,
      suffix,
      items: merged,
      total: merged.length,
      sources: sourceResults,
      errors
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const limit = normalizeLimit(req.body?.limit, 30, 150);
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const source = req.body?.source || "Manual";
    const mode = req.body?.mode === "random" ? "random" : "smart";
    const enrichMomentum = req.body?.enrichMomentum !== false;
    const enrichCompetition = req.body?.enrichCompetition !== false;
    const saveHistory = req.body?.saveHistory !== false;
    const suffix = normalizeSuffix(req.body?.suffix || "vercel.app");
    const excludedHosts = new Set(
      (Array.isArray(req.body?.excludedHosts) ? req.body.excludedHosts : []).map(String)
    );

    const normalized = mergeCandidatesByHost(
      urls
        .map((item) => (typeof item === "string" ? { url: item, source } : item))
        .filter((item) => item?.url)
    );

    const targets = selectAnalysisBatch(normalized, {
      count: limit,
      excludedHosts,
      mode
    });

    const results = [];
    const concurrency = 12;

    for (let index = 0; index < targets.length; index += concurrency) {
      const batch = targets.slice(index, index + concurrency);
      const analyzed = await Promise.all(batch.map((item) => analyzeOne(item, source)));
      results.push(...analyzed);
    }

    // URLScan per-host momentum (7d vs prev 7d) as rising-traffic proxy
    let withMomentum = await enrichItemsWithMomentum(results, {
      enabled: enrichMomentum,
      concurrency: 4
    });
    withMomentum = withMomentum.map(rescoreItem);

    // SERP / keyword competition density (demote red oceans)
    withMomentum = await enrichItemsWithCompetition(withMomentum, {
      enabled: enrichCompetition,
      concurrency: 3
    });
    withMomentum = withMomentum.map(rescoreItem);

    // Day-over-day vs previous snapshot
    let historyMeta = null;
    let comparison = null;
    try {
      const compared = await compareLatest({ suffix, items: withMomentum });
      comparison = compared.comparison;
      withMomentum = attachHistorySignals(withMomentum, comparison).map(rescoreItem);
      historyMeta = {
        previous: compared.previous,
        summary: comparison?.summary || null
      };
    } catch {
      // history is optional
    }

    let snapshot = null;
    if (saveHistory && withMomentum.length) {
      try {
        snapshot = await saveSnapshot({
          suffix,
          items: withMomentum,
          meta: {
            mode,
            poolSize: normalized.length,
            enrichMomentum,
            enrichCompetition
          }
        });
      } catch {
        // ignore persistence failures
      }
    }

    res.json({
      ok: true,
      mode,
      selected: targets.length,
      poolSize: normalized.length,
      items: withMomentum,
      snapshot: snapshot
        ? { id: snapshot.id, createdAt: snapshot.createdAt, hostCount: snapshot.hostCount }
        : null,
      history: historyMeta,
      rising: (comparison?.rising || []).slice(0, 20)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 20, 100);
    const suffix = req.query.suffix ? normalizeSuffix(req.query.suffix) : undefined;
    const snapshots = await listSnapshots({ limit, suffix });
    res.json({ ok: true, snapshots });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/history/rising", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 30, 100);
    const suffix = req.query.suffix ? normalizeSuffix(req.query.suffix) : undefined;
    const payload = await getRisingHosts({ suffix, limit });
    res.json({ ok: true, ...payload });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/history/compare", async (req, res) => {
  try {
    const suffix = req.query.suffix ? normalizeSuffix(req.query.suffix) : undefined;
    const snapshotId = req.query.snapshotId || undefined;
    const payload = await compareLatest({ suffix, snapshotId });
    res.json(payload);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/history/:id", async (req, res) => {
  try {
    const snapshot = await getSnapshot(req.params.id);
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message || "Snapshot not found" });
  }
});

app.post("/api/history/save", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const suffix = normalizeSuffix(req.body?.suffix || "vercel.app");
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "items required" });
    }
    const snapshot = await saveSnapshot({
      suffix,
      items,
      meta: req.body?.meta || {}
    });
    const compared = await compareLatest({ snapshotId: snapshot.id, suffix });
    res.json({
      ok: true,
      snapshot: {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        hostCount: snapshot.hostCount
      },
      comparison: compared.comparison,
      previous: compared.previous
    });
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
