import { safeHost } from "./scoring.js";

const HOST_DEMAND_WORDS = [
  "generator",
  "converter",
  "calculator",
  "tracker",
  "maker",
  "tool",
  "helper",
  "viewer",
  "checker",
  "analyzer",
  "counter",
  "timer",
  "length",
  "template",
  "invoice",
  "resume",
  "pdf",
  "image",
  "color",
  "tone",
  "quiz",
  "game",
  "dle",
  "guess",
  "ai",
  "seo",
  "chart",
  "video",
  "youtube",
  "download",
  "search",
  "planner",
  "editor",
  "compress",
  "crop",
  "remove",
  "bg",
  "ocr",
  "prompt",
  "chat"
];

function metricValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function parseLastSeen(value) {
  if (!value) return 0;

  const text = String(value).trim();
  if (/^\d{14}$/.test(text)) {
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6)) - 1;
    const day = Number(text.slice(6, 8));
    const hour = Number(text.slice(8, 10));
    const minute = Number(text.slice(10, 12));
    const second = Number(text.slice(12, 14));
    return Date.UTC(year, month, day, hour, minute, second);
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function hostDemandHits(host) {
  const slug = String(host || "")
    .toLowerCase()
    .replace(/\.vercel\.app$/, "")
    .replace(/[-_.]+/g, " ");
  return HOST_DEMAND_WORDS.filter((word) => slug.includes(word));
}

function pickNewer(left, right) {
  return parseLastSeen(right) > parseLastSeen(left) ? right : left;
}

/**
 * Merge discovery items by host, combining sources and max engagement metrics.
 */
export function mergeCandidatesByHost(items) {
  const map = new Map();

  for (const item of items) {
    if (!item?.url) continue;
    const host = safeHost(item.url);
    if (!host) continue;

    const existing = map.get(host);
    if (!existing) {
      const sources = item.sources
        ? [...item.sources]
        : item.source
          ? [item.source]
          : [];

      map.set(host, {
        ...item,
        host,
        sources: Array.from(new Set(sources.filter(Boolean))),
        source: sources[0] || item.source || "Discovery"
      });
      continue;
    }

    const nextSources = new Set([
      ...(existing.sources || []),
      ...(item.sources || []),
      item.source
    ].filter(Boolean));

    map.set(host, {
      ...existing,
      ...item,
      url: existing.url || item.url,
      originalUrl: existing.originalUrl || item.originalUrl || existing.url || item.url,
      host,
      source: existing.source || item.source || "Discovery",
      sources: Array.from(nextSources),
      title: existing.title || item.title || "",
      lastSeen: pickNewer(existing.lastSeen, item.lastSeen),
      stars: Math.max(metricValue(existing.stars), metricValue(item.stars)),
      forks: Math.max(metricValue(existing.forks), metricValue(item.forks)),
      openIssues: Math.max(metricValue(existing.openIssues), metricValue(item.openIssues)),
      points: Math.max(metricValue(existing.points), metricValue(item.points)),
      comments: Math.max(metricValue(existing.comments), metricValue(item.comments)),
      downloadsWeekly: Math.max(
        metricValue(existing.downloadsWeekly),
        metricValue(item.downloadsWeekly)
      ),
      downloadsMonthly: Math.max(
        metricValue(existing.downloadsMonthly),
        metricValue(item.downloadsMonthly)
      ),
      packageName: existing.packageName || item.packageName || "",
      repoName: existing.repoName || item.repoName || "",
      externalUrl: existing.externalUrl || item.externalUrl || ""
    });
  }

  return Array.from(map.values());
}

/**
 * Lightweight pre-score used to decide which candidates deserve full HTML analysis.
 * Higher = analyze first. Avoids wasting crawls on random dead portfolio shells.
 */
export function estimateCandidatePriority(item) {
  const host = item.host || safeHost(item.url);
  const demandHits = hostDemandHits(host);
  const sourceCount = Math.max(
    1,
    (item.sources || []).length || (item.source ? 1 : 0)
  );
  const lastSeenMs = parseLastSeen(item.lastSeen || item.discoveredAt);
  const ageDays = lastSeenMs
    ? Math.max(0, (Date.now() - lastSeenMs) / (1000 * 60 * 60 * 24))
    : 365;

  const recencyBoost =
    ageDays <= 7 ? 28 : ageDays <= 30 ? 18 : ageDays <= 90 ? 10 : ageDays <= 365 ? 4 : 0;

  const engagement =
    Math.min(30, Math.log10(metricValue(item.stars) + 1) * 12) +
    Math.min(18, Math.log10(metricValue(item.points) + 1) * 10) +
    Math.min(16, Math.log10(metricValue(item.downloadsWeekly) + 1) * 7) +
    Math.min(10, Math.log10(metricValue(item.comments) + 1) * 5) +
    Math.min(8, Math.log10(metricValue(item.forks) + 1) * 4);

  const multiSourceBoost = Math.min(24, (sourceCount - 1) * 10);
  const demandBoost = Math.min(30, demandHits.length * 10);
  const manualBoost = (item.sources || []).includes("Manual") || item.source === "Manual" ? 8 : 0;
  const momentumBoost = Math.min(
    28,
    metricValue(item.scanMomentum) * 0.35 + metricValue(item.scanCount7d) * 3
  );
  const historyBoost = Math.min(16, metricValue(item.history?.risingScore) * 0.2);

  // Soft penalty for obvious adult/login host patterns before full analyze.
  const hostText = String(host || "").toLowerCase();
  const riskPenalty =
    (/(rule34|porn|xxx|nsfw|hentai)/.test(hostText) ? 40 : 0) +
    (/(login|signin|wallet|moonpay|exodus)/.test(hostText) ? 20 : 0);

  return Math.round(
    12 +
      demandBoost +
      multiSourceBoost +
      recencyBoost +
      engagement +
      momentumBoost +
      historyBoost +
      manualBoost -
      riskPenalty
  );
}

function shuffleInPlace(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }
  return items;
}

/**
 * Select a batch for full analysis.
 * mode = "smart" (default): prioritize by signals, with light exploration.
 * mode = "random": pure shuffle (legacy behavior).
 */
export function selectAnalysisBatch(
  candidates,
  {
    count = 30,
    excludedHosts = new Set(),
    mode = "smart"
  } = {}
) {
  const limit = Math.max(1, Math.min(count, candidates.length || 1));
  const preferred = candidates.filter((item) => {
    const host = item.host || safeHost(item.url);
    return host && !excludedHosts.has(host);
  });
  const pool = preferred.length ? preferred : candidates;

  if (!pool.length) return [];

  if (mode === "random") {
    return shuffleInPlace([...pool]).slice(0, limit);
  }

  const ranked = pool
    .map((item) => ({
      item,
      priority: estimateCandidatePriority(item),
      jitter: Math.random() * 8
    }))
    .sort((a, b) => b.priority + b.jitter - (a.priority + a.jitter));

  // Keep ~80% high-signal picks and ~20% exploration so we don't overfit.
  const exploitCount = Math.max(1, Math.ceil(limit * 0.8));
  const exploreCount = Math.max(0, limit - exploitCount);
  const exploit = ranked.slice(0, exploitCount).map((entry) => entry.item);
  const explorePool = ranked.slice(exploitCount).map((entry) => entry.item);
  const explore = shuffleInPlace([...explorePool]).slice(0, exploreCount);

  return [...exploit, ...explore].map((item) => ({
    ...item,
    priorityScore: estimateCandidatePriority(item)
  }));
}
