const WEAK_WORDS = [
  "untitled",
  "vite",
  "react app",
  "next app",
  "create next app",
  "vercel app",
  "document"
];

const DEMAND_WORDS = [
  "generator",
  "converter",
  "calculator",
  "tracker",
  "search",
  "helper",
  "tool",
  "maker",
  "download",
  "viewer",
  "ai",
  "anime",
  "movie",
  "youtube",
  "minecraft",
  "pdf",
  "image",
  "resume",
  "invoice",
  "template",
  "color",
  "quiz",
  "game",
  "guess",
  "editor",
  "compress",
  "remove background",
  "ocr",
  "prompt",
  "chat",
  "translator",
  "summarizer"
];

const TOOL_WORDS = [
  "generator",
  "converter",
  "calculator",
  "tracker",
  "search",
  "helper",
  "tool",
  "maker",
  "viewer",
  "planner",
  "checker",
  "analyzer",
  "counter",
  "length",
  "timer",
  "download",
  "template",
  "editor",
  "compress",
  "crop",
  "remover",
  "ocr",
  "prompt",
  "translator",
  "summarizer",
  "color",
  "tone",
  "matcher"
];

const COMMERCIAL_WORDS = [
  "invoice",
  "resume",
  "pdf",
  "image",
  "youtube",
  "calculator",
  "template",
  "length",
  "timer",
  "booking",
  "shipping",
  "crm",
  "seo",
  "ai",
  "design",
  "video",
  "chart",
  "analytics",
  "pricing",
  "pro",
  "premium",
  "subscription",
  "saas"
];

const BRAND_RISK_WORDS = [
  "amazon",
  "netflix",
  "facebook",
  "instagram",
  "paypal",
  "fedex",
  "booking.com",
  "airbnb",
  "santander",
  "moonpay",
  "exodus",
  "crypto wallet"
];

const ADULT_WORDS = ["rule34", "porn", "xxx", "adult", "nsfw", "hentai"];
const LOGIN_WORDS = ["login", "signin", "sign in", "signup", "account blocked", "password"];
const PORTFOLIO_WORDS = ["portfolio", "resume", "personal website", "developer portfolio"];
const GAME_WORDS = [
  "game",
  "anime",
  "minecraft",
  "dle",
  "movie",
  "quiz",
  "guess",
  "toon",
  "cartoon",
  "color",
  "memory",
  "puzzle"
];

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function includesAny(text, words) {
  const haystack = String(text || "").toLowerCase();
  return words.some((word) => haystack.includes(word));
}

function matchedWords(text, words) {
  const haystack = String(text || "").toLowerCase();
  return words.filter((word) => haystack.includes(word));
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function scoreLabel(score) {
  if (score >= 75) return "strong";
  if (score >= 45) return "medium";
  return "weak";
}

function metricValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizedBrand(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainBrand(hostname) {
  const parts = String(hostname || "").replace(/^www\./, "").split(".").filter(Boolean);
  if (!parts.length) return "";
  if (hostname.endsWith(".vercel.app")) {
    return normalizedBrand(parts.slice(0, -2).join(""));
  }
  return normalizedBrand(parts.length >= 2 ? parts[parts.length - 2] : parts[0]);
}

function engagementScore({ stars, forks, openIssues, points, comments, downloadsWeekly }) {
  return Math.round(
    clamp(
      Math.min(24, Math.log10(metricValue(stars) + 1) * 12) +
        Math.min(10, Math.log10(metricValue(forks) + 1) * 8) +
        Math.min(8, Math.log10(metricValue(openIssues) + 1) * 5) +
        Math.min(24, Math.log10(metricValue(points) + 1) * 12) +
        Math.min(10, Math.log10(metricValue(comments) + 1) * 7) +
        Math.min(28, Math.log10(metricValue(downloadsWeekly) + 1) * 9)
    )
  );
}

function parseTimestamp(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (/^\d{14}$/.test(text)) {
    return Date.UTC(
      Number(text.slice(0, 4)),
      Number(text.slice(4, 6)) - 1,
      Number(text.slice(6, 8)),
      Number(text.slice(8, 10)),
      Number(text.slice(10, 12)),
      Number(text.slice(12, 14))
    );
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function recencyScore(site) {
  const ts = parseTimestamp(site.lastSeen || site.discoveredAt);
  if (!ts) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (ageDays <= 3) return 28;
  if (ageDays <= 7) return 22;
  if (ageDays <= 30) return 14;
  if (ageDays <= 90) return 8;
  if (ageDays <= 365) return 3;
  return 0;
}

function sourceCount(site) {
  if (Array.isArray(site.sources) && site.sources.length) {
    return new Set(site.sources.filter(Boolean)).size;
  }
  return site.source ? 1 : 0;
}

function officialProductHost({ originalUrl, url, canonical, ogUrl }) {
  const originalHost = hostnameFromUrl(originalUrl || url);
  if (!originalHost.endsWith(".vercel.app")) return "";

  const originalBrand = domainBrand(originalHost);
  if (!originalBrand) return "";

  const candidateHosts = [url, canonical, ogUrl]
    .map((value) => hostnameFromUrl(value))
    .filter((host) => host && !host.endsWith(".vercel.app"));

  return candidateHosts.find((host) => domainBrand(host) === originalBrand) || "";
}

export function inferKeyword({ url, title, description, h1 }) {
  const host = safeHost(url);
  const slug = host.replace(/\.vercel\.app$/, "").replace(/[-_]+/g, " ");
  const titleText = [h1, title, slug].find(hasText) || slug;
  return titleText
    .replace(/\s*[|·-]\s*(vercel|home|app).*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url || "").replace(/^https?:\/\//, "").split("/")[0];
  }
}

export function scoreOpportunity(site) {
  const signals = [];
  const weaknesses = [];
  const riskFlags = [];
  const categoryTags = [];

  const host = safeHost(site.url);
  const text = `${site.title || ""} ${site.description || ""} ${site.h1 || ""} ${host}`;
  const demandMatches = matchedWords(text, DEMAND_WORDS);
  const toolMatches = matchedWords(text, TOOL_WORDS);
  const commercialMatches = matchedWords(text, COMMERCIAL_WORDS);
  const brandMatches = matchedWords(text, BRAND_RISK_WORDS);
  const adultMatches = matchedWords(text, ADULT_WORDS);
  const loginMatches = matchedWords(text, LOGIN_WORDS);
  const hasOwnDomain = !host.endsWith(".vercel.app");
  const isReachable = site.httpStatus >= 200 && site.httpStatus < 400;
  const hasSeoBasics = hasText(site.title) && hasText(site.description) && hasText(site.h1);
  const externalSignalScore = engagementScore(site);
  const freshnessScore = recencyScore(site);
  const sourcesHit = sourceCount(site);
  const officialHost = officialProductHost(site);
  const hasOfficialProduct = Boolean(officialHost);

  const demandScore = clamp(
    24 +
      (toolMatches.length ? 28 : 0) +
      (demandMatches.length ? 10 : 0) +
      (commercialMatches.length ? 14 : 0) +
      (hasText(site.description) ? 8 : 0) +
      (site.wordCount > 800 ? 8 : 0) +
      (includesAny(text, GAME_WORDS) ? 8 : 0) +
      Math.round(externalSignalScore * 0.3) +
      Math.round(freshnessScore * 0.25) +
      Math.min(12, Math.max(0, sourcesHit - 1) * 6)
  );

  const seoWeaknessScore = clamp(
    (!hasText(site.title) ? 24 : 0) +
      (!hasText(site.description) ? 24 : 0) +
      (!hasText(site.h1) ? 16 : 0) +
      (!site.canonical ? 16 : 0) +
      (includesAny(text, WEAK_WORDS) ? 20 : 0)
  );

  const replicabilityScore = clamp(
    28 +
      (toolMatches.length ? 28 : 0) +
      (!hasOwnDomain ? 18 : 0) +
      (hasSeoBasics ? 8 : 0) +
      (site.wordCount < 2500 ? 10 : 0) -
      (brandMatches.length ? 30 : 0) -
      (loginMatches.length ? 18 : 0)
  );

  const commercialScore = clamp(
    18 +
      commercialMatches.length * 14 +
      (toolMatches.length ? 16 : 0) +
      (includesAny(text, ["free", "online", "template", "generator"]) ? 12 : 0) -
      (adultMatches.length ? 20 : 0) +
      Math.round(externalSignalScore * 0.18)
  );

  const riskScore = clamp(
    brandMatches.length * 28 +
      adultMatches.length * 30 +
      loginMatches.length * 18 +
      (hasOfficialProduct ? 45 : 0) +
      (includesAny(text, ["clone", "blocked"]) ? 18 : 0) +
      (site.robots?.toLowerCase().includes("noindex") ? 16 : 0)
  );

  let score = Math.round(
    demandScore * 0.28 +
      seoWeaknessScore * 0.18 +
      replicabilityScore * 0.22 +
      commercialScore * 0.14 +
      externalSignalScore * 0.1 +
      freshnessScore * 0.08 +
      (100 - riskScore) * 0.1
  );

  const sourceLabels = Array.isArray(site.sources) && site.sources.length
    ? site.sources
    : site.source
      ? [site.source]
      : [];

  if (sourceLabels.includes("Common Crawl")) {
    score += 4;
    signals.push("Common Crawl 收录");
  }

  if (sourceLabels.includes("URLScan")) {
    score += 3;
    signals.push("近期公开扫描");
  }

  if (sourceLabels.includes("Manual")) {
    score += 2;
    signals.push("手动导入");
  }

  if (sourceLabels.includes("GitHub Repos")) signals.push("GitHub 仓库提及");
  if (sourceLabels.includes("GitHub Issues")) signals.push("GitHub 讨论提及");
  if (sourceLabels.includes("Hacker News")) signals.push("Hacker News 提及");
  if (sourceLabels.includes("npm")) signals.push("npm 包生态提及");
  if (sourceLabels.includes("GitLab")) signals.push("GitLab 项目提及");
  if (sourceLabels.includes("Internet Archive")) signals.push("历史快照收录");
  if (sourceLabels.includes("crt.sh")) signals.push("证书透明日志");

  if (sourcesHit >= 2) {
    score += Math.min(10, (sourcesHit - 1) * 4);
    signals.push(`多源命中 x${sourcesHit}`);
    categoryTags.push("多源交叉");
  }

  if (freshnessScore >= 18) {
    score += 5;
    signals.push("近 7 日活跃信号");
    categoryTags.push("上升/新鲜");
  } else if (freshnessScore >= 10) {
    score += 2;
    signals.push("近 30 日活跃信号");
  }

  if (site.stars > 0) signals.push(`stars ${site.stars}`);
  if (site.points > 0) signals.push(`HN points ${site.points}`);
  if (site.downloadsWeekly > 0) signals.push(`npm weekly downloads ${site.downloadsWeekly}`);
  if (site.comments > 0) signals.push(`讨论评论 ${site.comments}`);

  if (isReachable) {
    score += 4;
    signals.push("首页可访问");
  } else if (site.httpStatus) {
    score -= 18;
    weaknesses.push(`HTTP ${site.httpStatus}`);
  } else if (site.error) {
    score -= 12;
    weaknesses.push("抓取失败");
  }

  if (!hasText(site.title)) weaknesses.push("缺少 title");
  if (!hasText(site.description)) weaknesses.push("缺少 meta description");
  if (!hasText(site.h1)) weaknesses.push("缺少 H1");
  if (!site.canonical) weaknesses.push("缺少 canonical");
  if (includesAny(text, WEAK_WORDS)) weaknesses.push("疑似默认模板文案");

  if (toolMatches.length) {
    signals.push("工具/需求类词");
    categoryTags.push("工具站");
  }

  if (commercialMatches.length) {
    signals.push("商业化关键词");
    categoryTags.push("可变现需求");
  }

  if (includesAny(text, GAME_WORDS)) {
    categoryTags.push("娱乐/游戏");
  }

  if (includesAny(text, PORTFOLIO_WORDS)) {
    categoryTags.push("作品集");
  }

  if (brandMatches.length) {
    score -= 30;
    riskFlags.push(`品牌/仿站风险：${brandMatches.slice(0, 2).join(", ")}`);
  }

  if (adultMatches.length) {
    score -= 35;
    riskFlags.push("成人内容风险");
  }

  if (loginMatches.length) {
    score -= 18;
    riskFlags.push("登录/账号页，需求不可直接复用");
  }

  if (hasOfficialProduct) {
    score -= 42;
    riskFlags.push(`已有正式产品：${officialHost}`);
    weaknesses.push("Vercel 子域疑似正式产品别名");
    categoryTags.push("已有正式产品");
  }

  if (!hasOwnDomain) {
    weaknesses.push("未绑定自有域名");
  } else {
    signals.push("已跳转到自有域名");
    categoryTags.push("已绑定域名");
  }

  if (site.robots?.toLowerCase().includes("noindex")) {
    score -= 16;
    weaknesses.push("noindex");
  }

  const normalizedScore = clamp(score);
  const decision =
    hasOfficialProduct || riskScore >= 45 || normalizedScore < 45
      ? "放弃"
      : normalizedScore >= 72 && riskScore < 35 && demandScore >= 55
        ? "值得"
        : "观察";

  const worthReason =
    seoWeaknessScore >= 20
      ? "需求信号和 SEO 缺口同时存在，适合做更完整的自有域名版本。"
      : "需求信号和可复制性较强，适合继续验证搜索量和差异化空间。";
  const fitReason =
    hasOfficialProduct
      ? "该 Vercel 子域已指向同品牌正式产品或自有域名，不适合作为复刻机会。"
      : decision === "值得"
      ? worthReason
      : decision === "观察"
        ? "存在可验证线索，但需要先确认搜索量、合规风险或页面质量。"
        : "风险、可复制性或需求信号不足，不建议优先投入。";

  return {
    score: normalizedScore,
    keyword: inferKeyword(site),
    signals,
    weaknesses,
    riskFlags,
    categoryTags: Array.from(new Set(categoryTags)),
    decision,
    fitReason,
    sources: sourceLabels,
    sourceCount: sourcesHit,
    scoreBreakdown: {
      demand: { score: demandScore, label: scoreLabel(demandScore) },
      seoGap: { score: seoWeaknessScore, label: scoreLabel(seoWeaknessScore) },
      replicability: { score: replicabilityScore, label: scoreLabel(replicabilityScore) },
      commercial: { score: commercialScore, label: scoreLabel(commercialScore) },
      external: { score: externalSignalScore, label: scoreLabel(externalSignalScore) },
      freshness: { score: freshnessScore, label: scoreLabel(freshnessScore) },
      risk: { score: riskScore, label: riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low" }
    }
  };
}
