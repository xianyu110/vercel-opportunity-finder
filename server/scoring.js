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
  "template"
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
  "template"
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
  "analytics"
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
const GAME_WORDS = ["game", "anime", "minecraft", "dle", "movie", "quiz"];

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
  const toolMatches = matchedWords(text, TOOL_WORDS);
  const commercialMatches = matchedWords(text, COMMERCIAL_WORDS);
  const brandMatches = matchedWords(text, BRAND_RISK_WORDS);
  const adultMatches = matchedWords(text, ADULT_WORDS);
  const loginMatches = matchedWords(text, LOGIN_WORDS);
  const hasOwnDomain = !host.endsWith(".vercel.app");
  const isReachable = site.httpStatus >= 200 && site.httpStatus < 300;
  const hasSeoBasics = hasText(site.title) && hasText(site.description) && hasText(site.h1);
  const externalSignalScore = engagementScore(site);

  const demandScore = clamp(
    24 +
      (toolMatches.length ? 32 : 0) +
      (commercialMatches.length ? 18 : 0) +
      (hasText(site.description) ? 8 : 0) +
      (site.wordCount > 800 ? 8 : 0) +
      (includesAny(text, GAME_WORDS) ? 6 : 0) +
      Math.round(externalSignalScore * 0.35)
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
      (includesAny(text, ["clone", "blocked"]) ? 18 : 0) +
      (site.robots?.toLowerCase().includes("noindex") ? 16 : 0)
  );

  let score = Math.round(
    demandScore * 0.3 +
      seoWeaknessScore * 0.2 +
      replicabilityScore * 0.25 +
      commercialScore * 0.15 +
      externalSignalScore * 0.1 +
      (100 - riskScore) * 0.1
  );

  if (site.source === "Common Crawl") {
    score += 4;
    signals.push("Common Crawl 收录");
  }

  if (site.source === "URLScan") {
    score += 3;
    signals.push("近期开源扫描");
  }

  if (site.source === "Manual") {
    score += 2;
    signals.push("手动导入");
  }

  if (site.source === "GitHub Repos") {
    signals.push("GitHub 仓库提及");
  }

  if (site.source === "GitHub Issues") {
    signals.push("GitHub 讨论提及");
  }

  if (site.source === "Hacker News") {
    signals.push("Hacker News 提及");
  }

  if (site.source === "npm") {
    signals.push("npm 包生态提及");
  }

  if (site.source === "GitLab") {
    signals.push("GitLab 项目提及");
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
    riskScore >= 45 || normalizedScore < 45
      ? "放弃"
      : normalizedScore >= 72 && riskScore < 35 && demandScore >= 55
        ? "值得"
        : "观察";

  const worthReason =
    seoWeaknessScore >= 20
      ? "需求信号和 SEO 缺口同时存在，适合做更完整的自有域名版本。"
      : "需求信号和可复制性较强，适合继续验证搜索量和差异化空间。";
  const fitReason =
    decision === "值得"
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
    scoreBreakdown: {
      demand: { score: demandScore, label: scoreLabel(demandScore) },
      seoGap: { score: seoWeaknessScore, label: scoreLabel(seoWeaknessScore) },
      replicability: { score: replicabilityScore, label: scoreLabel(replicabilityScore) },
      commercial: { score: commercialScore, label: scoreLabel(commercialScore) },
      external: { score: externalSignalScore, label: scoreLabel(externalSignalScore) },
      risk: { score: riskScore, label: riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low" }
    }
  };
}
