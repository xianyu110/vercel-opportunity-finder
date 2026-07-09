import {
  computeMaturityScore,
  maturityLabel,
  computeWinability
} from "./maturity.js";
import { heuristicCompetition } from "./competition.js";

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

function engagementScore({
  stars,
  forks,
  openIssues,
  points,
  comments,
  downloadsWeekly,
  redditScore,
  redditComments,
  stackOverflowAnswers
}) {
  return Math.round(
    clamp(
      Math.min(24, Math.log10(metricValue(stars) + 1) * 12) +
        Math.min(10, Math.log10(metricValue(forks) + 1) * 8) +
        Math.min(8, Math.log10(metricValue(openIssues) + 1) * 5) +
        Math.min(24, Math.log10(metricValue(points) + 1) * 12) +
        Math.min(10, Math.log10(metricValue(comments) + 1) * 7) +
        Math.min(28, Math.log10(metricValue(downloadsWeekly) + 1) * 9) +
        Math.min(14, Math.log10(metricValue(redditScore) + 1) * 7) +
        Math.min(8, Math.log10(metricValue(redditComments) + 1) * 4) +
        Math.min(8, Math.log10(metricValue(stackOverflowAnswers) + 1) * 4)
    )
  );
}

function momentumScore(site) {
  const scanMomentum = metricValue(site.scanMomentum);
  if (scanMomentum > 0) return clamp(scanMomentum);

  const scan7 = metricValue(site.scanCount7d);
  const scanPrev = metricValue(site.scanCountPrev7d);
  const delta = scan7 - scanPrev;
  return clamp(
    scan7 * 8 +
      Math.max(0, delta) * 10 +
      (scanPrev > 0 && scan7 / scanPrev >= 1.5 ? 12 : 0)
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
  const scanMomentumScore = momentumScore(site);
  const sourcesHit = sourceCount(site);
  const officialHost = officialProductHost(site);
  const hasOfficialProduct = Boolean(officialHost);
  const historyRising = metricValue(site.history?.risingScore);
  const isHistoryNew = Boolean(site.history?.isNew);

  // Demand should not reward long marketing pages as if they were "better opportunities".
  const demandScore = clamp(
    24 +
      (toolMatches.length ? 28 : 0) +
      (demandMatches.length ? 10 : 0) +
      (commercialMatches.length ? 12 : 0) +
      (hasText(site.description) ? 6 : 0) +
      (site.wordCount > 400 && site.wordCount < 2500 ? 6 : 0) +
      (includesAny(text, GAME_WORDS) ? 8 : 0) +
      Math.round(externalSignalScore * 0.28) +
      Math.round(freshnessScore * 0.2) +
      Math.round(scanMomentumScore * 0.15) +
      Math.min(12, Math.max(0, sourcesHit - 1) * 6)
  );

  const seoWeaknessScore = clamp(
    (!hasText(site.title) ? 24 : 0) +
      (!hasText(site.description) ? 24 : 0) +
      (!hasText(site.h1) ? 16 : 0) +
      (!site.canonical ? 16 : 0) +
      (includesAny(text, WEAK_WORDS) ? 20 : 0)
  );

  const maturityScore = clamp(
    metricValue(site.maturityScore) ||
      computeMaturityScore({
        wordCount: site.wordCount,
        blogLinks: site.blogLinks,
        toolLinks: site.toolLinks,
        docLinks: site.docLinks,
        maturePathHits: site.maturePathHits,
        internalLinkCount: site.internalLinkCount,
        h2Count: site.h2Count,
        h3Count: site.h3Count,
        faqHits: site.faqHits,
        hasComparisonTable: site.hasComparisonTable,
        hasStructuredData: site.hasStructuredData,
        hasNewsletterOrForm: site.hasNewsletterOrForm,
        matureCopyHits: site.matureCopyHits
      })
  );

  const competitionScore = clamp(
    metricValue(site.competitionScore) ||
      heuristicCompetition(site.keyword || site.title || host, {
        title: site.title,
        description: site.description
      }).competitionScore
  );

  // Late-mover friendliness: simple shell + SEO gap + not own-domain locked.
  const replicabilityScore = clamp(
    28 +
      (toolMatches.length ? 22 : 0) +
      (!hasOwnDomain ? 16 : 0) +
      (hasSeoBasics ? 6 : 0) +
      (site.wordCount > 0 && site.wordCount < 1800 ? 14 : 0) +
      Math.round((100 - maturityScore) * 0.18) -
      (brandMatches.length ? 30 : 0) -
      (loginMatches.length ? 18 : 0) -
      (maturityScore >= 70 ? 18 : 0)
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
      (site.robots?.toLowerCase().includes("noindex") ? 16 : 0) +
      // Red ocean + mature product is a business risk, not just a copy risk.
      (maturityScore >= 75 && competitionScore >= 65 ? 18 : 0)
  );

  const winabilityScore = computeWinability({
    seoGap: seoWeaknessScore,
    maturity: maturityScore,
    competition: competitionScore,
    demand: demandScore,
    risk: riskScore
  });

  // Opportunity score: demand still matters, but winability/competition/maturity decide actionability.
  let score = Math.round(
    demandScore * 0.2 +
      seoWeaknessScore * 0.12 +
      replicabilityScore * 0.14 +
      commercialScore * 0.08 +
      externalSignalScore * 0.07 +
      freshnessScore * 0.05 +
      scanMomentumScore * 0.07 +
      winabilityScore * 0.18 +
      (100 - competitionScore) * 0.09 +
      (100 - maturityScore) * 0.08 +
      (100 - riskScore) * 0.07
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

  if (scanMomentumScore >= 40) {
    score += 6;
    signals.push(`URLScan 扫描动量 ${scanMomentumScore}`);
    categoryTags.push("扫描上升");
  } else if (scanMomentumScore >= 20) {
    score += 3;
    signals.push(`URLScan 扫描动量 ${scanMomentumScore}`);
  }

  if (metricValue(site.scanCount7d) > 0) {
    signals.push(`近7日扫描 ${site.scanCount7d}`);
  }
  if (metricValue(site.scanCountPrev7d) > 0 && metricValue(site.scanCount7d) > metricValue(site.scanCountPrev7d)) {
    signals.push(
      `扫描环比 +${metricValue(site.scanCount7d) - metricValue(site.scanCountPrev7d)}`
    );
  }

  if (historyRising >= 35) {
    score += Math.min(8, Math.round(historyRising * 0.08));
    signals.push(`历史日环比上升 ${historyRising}`);
    categoryTags.push("上升中");
  }
  if (isHistoryNew && site.history?.label === "新出现") {
    score += 3;
    categoryTags.push("新出现");
  }

  if (site.stars > 0) signals.push(`stars ${site.stars}`);
  if (site.points > 0) signals.push(`HN points ${site.points}`);
  if (site.downloadsWeekly > 0) signals.push(`npm weekly downloads ${site.downloadsWeekly}`);
  if (site.comments > 0) signals.push(`讨论评论 ${site.comments}`);
  if (site.redditScore > 0) signals.push(`reddit score ${site.redditScore}`);
  if (site.stackOverflowAnswers > 0) signals.push(`SO answers ${site.stackOverflowAnswers}`);

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

  if (maturityScore >= 75) {
    score -= 16;
    weaknesses.push("页面成熟度高（博客/多工具/长内容），不宜正面复刻");
    categoryTags.push("已成型产品");
    signals.push(`成熟度 ${maturityScore}（${maturityLabel(maturityScore)}）`);
  } else if (maturityScore >= 55) {
    score -= 8;
    categoryTags.push("较成熟");
    signals.push(`成熟度 ${maturityScore}（${maturityLabel(maturityScore)}）`);
  } else if (maturityScore > 0) {
    signals.push(`成熟度 ${maturityScore}（${maturityLabel(maturityScore)}）`);
    if (maturityScore < 35) categoryTags.push("早期壳站");
  }

  if (competitionScore >= 75) {
    score -= 18;
    weaknesses.push("关键词竞争偏红海，后发难突围");
    categoryTags.push("红海词");
    signals.push(
      `竞争 ${competitionScore}${site.competitionLabel ? `/${site.competitionLabel}` : ""}` +
        (site.competitorCount ? ` · 同类约 ${site.competitorCount}` : "")
    );
  } else if (competitionScore >= 50) {
    score -= 8;
    categoryTags.push("竞争拥挤");
    signals.push(
      `竞争 ${competitionScore}${site.competitionLabel ? `/${site.competitionLabel}` : ""}`
    );
  } else if (competitionScore > 0) {
    signals.push(
      `竞争 ${competitionScore}${site.competitionLabel ? `/${site.competitionLabel}` : "偏蓝海"}`
    );
    if (competitionScore < 35) categoryTags.push("竞争较弱");
  }

  if (winabilityScore >= 65) {
    score += 6;
    signals.push(`可赢性 ${winabilityScore}`);
    categoryTags.push("可切入");
  } else if (winabilityScore < 40) {
    score -= 8;
    weaknesses.push("可赢性偏低（成熟/红海/缺口不足）");
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

  // Decision gates: demand alone is not enough — need room to win.
  const redOceanMature = competitionScore >= 70 && maturityScore >= 60;
  const hardPass =
    hasOfficialProduct ||
    riskScore >= 50 ||
    adultMatches.length > 0 ||
    (redOceanMature && winabilityScore < 45);

  let decision;
  if (hardPass || normalizedScore < 42) {
    decision = "放弃";
  } else if (
    normalizedScore >= 70 &&
    riskScore < 35 &&
    demandScore >= 50 &&
    winabilityScore >= 58 &&
    competitionScore < 70 &&
    maturityScore < 70
  ) {
    decision = "值得";
  } else {
    decision = "观察";
  }

  // Soft floors for false "值得"
  if (decision === "值得" && (maturityScore >= 72 || competitionScore >= 78)) {
    decision = "观察";
  }
  // Empty/default shells are research leads, not ready opportunities.
  if (
    decision === "值得" &&
    (includesAny(text, WEAK_WORDS) || (!hasText(site.title) && !hasText(site.description)))
  ) {
    decision = "观察";
  }

  let fitReason;
  if (hasOfficialProduct) {
    fitReason = "该 Vercel 子域已指向同品牌正式产品或自有域名，不适合作为复刻机会。";
  } else if (redOceanMature) {
    fitReason =
      "需求可能真实，但竞品密度高且页面已成型（博客/多工具/长内容）。适合借鉴需求做垂直切口，不建议正面复刻。";
  } else if (decision === "值得") {
    fitReason =
      winabilityScore >= 65 && seoWeaknessScore >= 15
        ? "需求成立，且竞品/成熟度尚未封死窗口，SEO 与产品都有改进空间。"
        : "需求与可赢性尚可，适合做差异化版本并继续验证搜索量。";
  } else if (decision === "观察") {
    fitReason =
      competitionScore >= 60
        ? "有需求线索，但竞争偏拥挤，需先确认差异化切口（人群/语言/形态）再投入。"
        : maturityScore >= 55
          ? "站点已有一定完成度，需确认是否还能明显做得更好，避免同质化。"
          : "存在可验证线索，但需要先确认搜索量、合规风险或页面质量。";
  } else {
    fitReason = "风险过高、红海已成型，或需求/可赢性不足，不建议优先投入。";
  }

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
    scanCount7d: metricValue(site.scanCount7d),
    scanCountPrev7d: metricValue(site.scanCountPrev7d),
    scanMomentum: scanMomentumScore,
    maturityScore,
    maturityLabel: maturityLabel(maturityScore),
    competitionScore,
    competitionLabel: site.competitionLabel ||
      (competitionScore >= 75 ? "红海" : competitionScore >= 50 ? "拥挤" : competitionScore >= 30 ? "一般" : "蓝海"),
    competitorCount: metricValue(site.competitorCount),
    winabilityScore,
    scoreBreakdown: {
      demand: { score: demandScore, label: scoreLabel(demandScore) },
      seoGap: { score: seoWeaknessScore, label: scoreLabel(seoWeaknessScore) },
      replicability: { score: replicabilityScore, label: scoreLabel(replicabilityScore) },
      commercial: { score: commercialScore, label: scoreLabel(commercialScore) },
      external: { score: externalSignalScore, label: scoreLabel(externalSignalScore) },
      freshness: { score: freshnessScore, label: scoreLabel(freshnessScore) },
      momentum: { score: scanMomentumScore, label: scoreLabel(scanMomentumScore) },
      maturity: { score: maturityScore, label: maturityLabel(maturityScore) },
      competition: {
        score: competitionScore,
        label:
          competitionScore >= 75
            ? "红海"
            : competitionScore >= 50
              ? "拥挤"
              : competitionScore >= 30
                ? "一般"
                : "蓝海"
      },
      winability: { score: winabilityScore, label: scoreLabel(winabilityScore) },
      risk: { score: riskScore, label: riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low" }
    }
  };
}
