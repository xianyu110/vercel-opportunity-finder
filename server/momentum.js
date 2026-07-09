/**
 * URLScan-based momentum / rising traffic proxy signals.
 * Not real analytics traffic — public scan frequency as a weak proxy.
 */

const USER_AGENT =
  "VercelOpportunityFinder/0.3 (+momentum; contact: local)";

function parseTime(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isNaN(ts) ? 0 : ts;
}

function hostFromResult(result) {
  const domain = result?.page?.domain || result?.task?.domain || "";
  if (domain) return String(domain).toLowerCase().replace(/^www\./, "");
  try {
    return new URL(result?.page?.url || "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Aggregate URLScan search results into per-host momentum buckets.
 */
export function aggregateUrlscanMomentum(results = [], { now = Date.now() } = {}) {
  const dayMs = 24 * 60 * 60 * 1000;
  const map = new Map();

  for (const result of results) {
    const host = hostFromResult(result);
    if (!host) continue;

    const time = parseTime(result.task?.time || result.indexedAt);
    const entry = map.get(host) || {
      host,
      url: `https://${host}/`,
      source: "URLScan",
      title: result.page?.title || "",
      lastSeen: result.task?.time || result.indexedAt || "",
      httpStatus: result.page?.status || 0,
      scanCount: 0,
      scanCount7d: 0,
      scanCountPrev7d: 0,
      scanCount30d: 0,
      recentScans: []
    };

    entry.scanCount += 1;
    if (time) {
      const age = now - time;
      if (age <= 7 * dayMs) entry.scanCount7d += 1;
      else if (age <= 14 * dayMs) entry.scanCountPrev7d += 1;
      if (age <= 30 * dayMs) entry.scanCount30d += 1;

      if (!entry.lastSeen || time > parseTime(entry.lastSeen)) {
        entry.lastSeen = result.task?.time || result.indexedAt || entry.lastSeen;
        entry.title = result.page?.title || entry.title;
      }
    }

    map.set(host, entry);
  }

  for (const entry of map.values()) {
    entry.scanMomentum = computeScanMomentum(entry);
  }

  return Array.from(map.values());
}

export function computeScanMomentum({
  scanCount7d = 0,
  scanCountPrev7d = 0,
  scanCount30d = 0
} = {}) {
  const delta = scanCount7d - scanCountPrev7d;
  const ratio =
    scanCountPrev7d > 0 ? scanCount7d / scanCountPrev7d : scanCount7d > 0 ? 3 : 0;

  // 0-100 proxy score for "rising scan attention"
  return Math.round(
    Math.max(
      0,
      Math.min(
        100,
        scanCount7d * 8 +
          Math.max(0, delta) * 10 +
          Math.min(24, Math.log10(scanCount30d + 1) * 16) +
          (ratio >= 2 ? 16 : ratio >= 1.3 ? 8 : 0) +
          (scanCount7d >= 3 && delta > 0 ? 10 : 0)
      )
    )
  );
}

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json"
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

/**
 * Fetch public URLScan records for a single host and compute 7d vs prev 7d counts.
 */
export async function fetchHostUrlscanMomentum(host, { size = 50 } = {}) {
  const clean = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!clean) {
    return {
      scanCount7d: 0,
      scanCountPrev7d: 0,
      scanCount30d: 0,
      scanMomentum: 0
    };
  }

  const params = new URLSearchParams({
    q: `domain:${clean}`,
    size: String(Math.min(100, Math.max(10, size)))
  });

  try {
    const json = await fetchJson(`https://urlscan.io/api/v1/search/?${params}`);
    const [aggregated] = aggregateUrlscanMomentum(json.results || []);
    if (!aggregated) {
      return {
        scanCount7d: 0,
        scanCountPrev7d: 0,
        scanCount30d: 0,
        scanMomentum: 0
      };
    }
    return {
      scanCount7d: aggregated.scanCount7d,
      scanCountPrev7d: aggregated.scanCountPrev7d,
      scanCount30d: aggregated.scanCount30d,
      scanMomentum: aggregated.scanMomentum,
      lastSeen: aggregated.lastSeen
    };
  } catch {
    return {
      scanCount7d: 0,
      scanCountPrev7d: 0,
      scanCount30d: 0,
      scanMomentum: 0
    };
  }
}

/**
 * Enrich analyzed items with URLScan momentum (rate-limited concurrency).
 */
export async function enrichItemsWithMomentum(items, { concurrency = 4, enabled = true } = {}) {
  if (!enabled || !items?.length) return items || [];

  const results = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const enriched = await Promise.all(
      batch.map(async (item) => {
        const host = item.host || hostFromResult({ page: { url: item.url } });
        if (!host || item.scanMomentum > 0) return item;

        const momentum = await fetchHostUrlscanMomentum(host);
        const categoryTags = new Set(item.categoryTags || []);
        if (momentum.scanMomentum >= 40) categoryTags.add("扫描上升");
        if (momentum.scanCount7d >= 3) categoryTags.add("近7日热扫");

        return {
          ...item,
          ...momentum,
          lastSeen: item.lastSeen || momentum.lastSeen || "",
          categoryTags: Array.from(categoryTags)
        };
      })
    );
    results.push(...enriched);
  }

  return results;
}
