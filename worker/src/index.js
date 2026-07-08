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
  const rawUrl = input.url || input;
  let url;

  try {
    url = validatePublicHttpUrl(rawUrl);
  } catch (error) {
    const fallbackUrl = normalizeUrl(rawUrl);
    const base = {
      url: fallbackUrl,
      source: input.source || source,
      discoveredAt: input.discoveredAt || new Date().toISOString(),
      lastSeen: input.lastSeen || input.timestamp || "",
      ...metadataFromInput(input)
    };
    const scored = scoreOpportunity({
      ...base,
      httpStatus: 0
    });

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
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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

async function discoverGithubRepos(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 100);
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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

  return {
    ok: true,
    source: "GitHub Repos",
    items: uniqueByHost(items).slice(0, limit)
  };
}

async function discoverGithubIssues(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 100);
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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

  return {
    ok: true,
    source: "GitHub Issues",
    items: uniqueByHost(items).slice(0, limit)
  };
}

async function discoverHackerNews(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 100);
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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

  return {
    ok: true,
    source: "Hacker News",
    items: uniqueByHost(items).slice(0, limit)
  };
}

async function discoverNpm(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 100);
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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

  return {
    ok: true,
    source: "npm",
    items: uniqueByHost(items).slice(0, limit)
  };
}

async function discoverGitlab(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 100);
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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

  return {
    ok: true,
    source: "GitLab",
    items: uniqueByHost(items).slice(0, limit)
  };
}

async function discoverInternetArchive(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 100);
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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

  return {
    ok: true,
    source: "Internet Archive",
    items: uniqueByHost(items).slice(0, limit)
  };
}

async function discoverCertificates(requestUrl) {
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"), 80, 100);
  const suffix = normalizeSuffix(requestUrl.searchParams.get("suffix"));
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

  return {
    ok: true,
    source: "crt.sh",
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

    if (request.method === "GET" && requestUrl.pathname === "/api/discover/github-repos") {
      return jsonResponse(await discoverGithubRepos(requestUrl));
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/discover/github-issues") {
      return jsonResponse(await discoverGithubIssues(requestUrl));
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/discover/hackernews") {
      return jsonResponse(await discoverHackerNews(requestUrl));
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/discover/npm") {
      return jsonResponse(await discoverNpm(requestUrl));
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/discover/gitlab") {
      return jsonResponse(await discoverGitlab(requestUrl));
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/discover/internet-archive") {
      return jsonResponse(await discoverInternetArchive(requestUrl));
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/discover/certificates") {
      return jsonResponse(await discoverCertificates(requestUrl));
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
