/**
 * Competition / SERP density estimation.
 * Uses keyword heuristics + best-effort DuckDuckGo HTML search.
 * Not perfect Google volume data — enough to demote red-ocean tools like
 * "youtube playlist length calculator".
 */

const USER_AGENT =
  "VercelOpportunityFinder/0.4 (+competition; research tool)";

const HIGH_COMPETITION_PHRASES = [
  "youtube playlist",
  "playlist length",
  "playlist duration",
  "playlist calculator",
  "word counter",
  "character counter",
  "password generator",
  "qr code",
  "pdf converter",
  "image compressor",
  "image to pdf",
  "json formatter",
  "base64",
  "lorem ipsum",
  "color picker",
  "color converter",
  "markdown editor",
  "pomodoro",
  "todo list",
  "resume builder",
  "invoice generator",
  "ai chat",
  "chatgpt",
  "remove background",
  "bg remover",
  "text to speech",
  "speech to text",
  "unit converter",
  "age calculator",
  "bmi calculator",
  "loan calculator",
  "mortgage calculator",
  "tip calculator",
  "timezone converter",
  "uuid generator",
  "hash generator",
  "regex tester",
  "cron generator",
  "meta tag",
  "og image",
  "favicon generator"
];

const MEDIUM_COMPETITION_PHRASES = [
  "calculator",
  "converter",
  "generator",
  "tracker",
  "checker",
  "analyzer",
  "formatter",
  "compressor",
  "downloader",
  "summarizer",
  "translator",
  "youtube",
  "instagram",
  "tiktok",
  "pdf",
  "image",
  "video",
  "audio",
  "seo",
  "keyword"
];

const TOOLISH_TITLE_RE =
  /\b(calculator|converter|generator|tracker|checker|analyzer|tool|online|free|length|duration|counter|maker|editor|compressor|formatter)\b/i;

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function normalizeKeyword(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Fast offline heuristic — always available.
 */
export function heuristicCompetition(keyword, { title = "", description = "" } = {}) {
  const key = normalizeKeyword(keyword);
  const blob = `${key} ${title} ${description}`.toLowerCase();
  let score = 18;
  const matched = [];

  for (const phrase of HIGH_COMPETITION_PHRASES) {
    if (blob.includes(phrase)) {
      score += 18;
      matched.push(phrase);
    }
  }
  for (const phrase of MEDIUM_COMPETITION_PHRASES) {
    if (blob.includes(phrase)) {
      score += 4;
      matched.push(phrase);
    }
  }

  // Generic multi-word English tool queries are usually competitive.
  const words = key.split(" ").filter(Boolean);
  if (words.length >= 3 && TOOLISH_TITLE_RE.test(key)) score += 12;
  if (words.length >= 4 && TOOLISH_TITLE_RE.test(key)) score += 8;
  if (/\b(youtube|google|instagram|tiktok|facebook|twitter|x\.com)\b/.test(blob)) {
    score += 10;
  }

  return {
    competitionScore: clamp(score),
    matchedPhrases: Array.from(new Set(matched)).slice(0, 6),
    method: "heuristic"
  };
}

function stripTags(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const blocks = String(html || "").split(/class="result__/i).slice(1);

  for (const block of blocks.slice(0, 12)) {
    const href =
      block.match(/class="result__a"[^>]*href="([^"]+)"/i)?.[1] ||
      block.match(/uddg=([^&"]+)/i)?.[1] ||
      "";
    const title = stripTags(block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "");
    const snippet = stripTags(
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
        block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//i)?.[1] ||
        ""
    );

    let url = href;
    try {
      url = decodeURIComponent(href);
    } catch {
      // keep raw
    }
    if (url.includes("uddg=")) {
      try {
        url = decodeURIComponent(url.split("uddg=")[1].split("&")[0]);
      } catch {
        // ignore
      }
    }

    if (!title && !url) continue;
    results.push({ title, snippet, url });
  }

  // Fallback: looser title extraction
  if (!results.length) {
    const links = String(html || "").matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
    for (const match of links) {
      results.push({
        url: match[1],
        title: stripTags(match[2]),
        snippet: ""
      });
      if (results.length >= 10) break;
    }
  }

  return results;
}

function isSimilarToolResult(result, keyword) {
  const text = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`.toLowerCase();
  const key = normalizeKeyword(keyword);
  const keyBits = key.split(" ").filter((w) => w.length > 2);
  const keyHits = keyBits.filter((bit) => text.includes(bit)).length;
  const toolish = TOOLISH_TITLE_RE.test(text);
  return toolish && keyHits >= Math.min(2, keyBits.length);
}

async function fetchDuckDuckGo(keyword) {
  const q = encodeURIComponent(keyword);
  const url = `https://html.duckduckgo.com/html/?q=${q}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (!response.ok) {
      throw new Error(`DuckDuckGo HTTP ${response.status}`);
    }
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Estimate SERP competition for a keyword.
 */
export async function estimateKeywordCompetition(keyword, context = {}) {
  const key = normalizeKeyword(keyword || context.title || context.host || "");
  const heuristic = heuristicCompetition(key, context);

  if (!key || key.length < 3) {
    return {
      competitionScore: 30,
      competitorCount: 0,
      similarTools: [],
      matchedPhrases: heuristic.matchedPhrases,
      method: "heuristic",
      label: "unknown"
    };
  }

  let serpResults = [];
  let method = "heuristic";

  try {
    const html = await fetchDuckDuckGo(key);
    serpResults = parseDuckDuckGoResults(html);
    if (serpResults.length) method = "duckduckgo+heuristic";
  } catch {
    // keep heuristic only
  }

  const similar = serpResults.filter((row) => isSimilarToolResult(row, key));
  const competitorCount = similar.length;
  const serpBoost =
    competitorCount >= 6
      ? 36
      : competitorCount >= 4
        ? 28
        : competitorCount >= 2
          ? 16
          : competitorCount === 1
            ? 8
            : 0;

  // Big-site occupancy (weak signal)
  const bigSites = serpResults.filter((row) =>
    /\b(wikipedia|github\.com|chrome\.google|microsoft|adobe|canva|notion|zapier)\b/i.test(
      row.url || ""
    )
  ).length;

  const competitionScore = clamp(
    heuristic.competitionScore * 0.55 + serpBoost + Math.min(12, bigSites * 4) + 10
  );

  return {
    competitionScore,
    competitorCount,
    similarTools: similar.slice(0, 6).map((row) => ({
      title: row.title,
      url: row.url
    })),
    matchedPhrases: heuristic.matchedPhrases,
    method,
    label:
      competitionScore >= 75 ? "红海" : competitionScore >= 50 ? "拥挤" : competitionScore >= 30 ? "一般" : "蓝海"
  };
}

/**
 * Batch enrich items with competition estimates (rate-limited).
 */
export async function enrichItemsWithCompetition(items, { enabled = true, concurrency = 3 } = {}) {
  if (!enabled || !items?.length) return items || [];

  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const enriched = await Promise.all(
      batch.map(async (item) => {
        const keyword = item.keyword || item.title || item.host || "";
        try {
          const competition = await estimateKeywordCompetition(keyword, {
            title: item.title,
            description: item.description,
            host: item.host
          });
          return {
            ...item,
            competitionScore: competition.competitionScore,
            competitorCount: competition.competitorCount,
            competitionLabel: competition.label,
            competitionMethod: competition.method,
            similarTools: competition.similarTools,
            competitionPhrases: competition.matchedPhrases
          };
        } catch {
          const fallback = heuristicCompetition(keyword, item);
          return {
            ...item,
            competitionScore: fallback.competitionScore,
            competitorCount: 0,
            competitionLabel:
              fallback.competitionScore >= 75
                ? "红海"
                : fallback.competitionScore >= 50
                  ? "拥挤"
                  : "一般",
            competitionMethod: "heuristic",
            similarTools: [],
            competitionPhrases: fallback.matchedPhrases
          };
        }
      })
    );
    results.push(...enriched);
  }
  return results;
}
