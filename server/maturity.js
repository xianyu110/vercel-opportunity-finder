/**
 * Product maturity signals from page HTML / meta.
 * Mature operated products (blogs, multi-tools, long SEO pages) should be demoted
 * as copy targets even if demand is real.
 */

const MATURE_PATH_RE =
  /\/(blog|blogs|docs|documentation|tools|pricing|about|faq|features|changelog|privacy|terms|compare|alternatives)(\/|"|'|\?|#|$)/i;

const MATURE_TEXT_RE =
  /\b(frequently asked questions|faq|how to use|step-by-step|vs\.|versus|comparison|privacy policy|terms of service|our latest blogs?|read article|new tool)\b/i;

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Extract maturity-related features from HTML string (cheerio-free for worker reuse).
 */
export function extractMaturityFromHtml(html, { wordCount = 0 } = {}) {
  const source = String(html || "");
  const lower = source.toLowerCase();

  const hrefs = Array.from(source.matchAll(/href=["']([^"']+)["']/gi)).map((m) => m[1] || "");
  const internalHrefs = hrefs.filter(
    (href) => href.startsWith("/") || href.includes("vercel.app") || href.startsWith("#")
  );

  const blogLinks = hrefs.filter((href) => /\/blogs?(\/|$)/i.test(href)).length;
  const toolLinks = hrefs.filter((href) => /\/tools?(\/|$)/i.test(href)).length;
  const docLinks = hrefs.filter((href) => /\/(docs?|documentation)(\/|$)/i.test(href)).length;
  const maturePathHits = hrefs.filter((href) => MATURE_PATH_RE.test(href)).length;

  const h2Count = (source.match(/<h2\b/gi) || []).length;
  const h3Count = (source.match(/<h3\b/gi) || []).length;
  const faqHits =
    (lower.match(/faq|frequently asked/g) || []).length +
    (source.match(/itemtype=["'][^"']*FAQPage/gi) || []).length;
  const hasComparisonTable =
    /<table[\s\S]{0,400}(vs\.|versus|youtube native|feature)/i.test(source) ||
    /class=["'][^"']*comparison/i.test(source);
  const hasStructuredData = /application\/ld\+json/i.test(source);
  const hasNewsletterOrForm = /<(form|input)[^>]*(email|newsletter|subscribe)/i.test(source);
  const matureCopyHits = MATURE_TEXT_RE.test(source) ? 1 : 0;

  const estimatedWordCount =
    wordCount ||
    source
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean).length;

  return {
    blogLinks,
    toolLinks,
    docLinks,
    maturePathHits,
    internalLinkCount: internalHrefs.length,
    h2Count,
    h3Count,
    faqHits,
    hasComparisonTable,
    hasStructuredData,
    hasNewsletterOrForm,
    matureCopyHits,
    wordCount: estimatedWordCount
  };
}

/**
 * 0-100 maturity: higher = more like an operated product, less like a forkable shell.
 */
export function computeMaturityScore(features = {}) {
  const wordCount = Number(features.wordCount || 0);
  const blogLinks = Number(features.blogLinks || 0);
  const toolLinks = Number(features.toolLinks || 0);
  const docLinks = Number(features.docLinks || 0);
  const maturePathHits = Number(features.maturePathHits || 0);
  const h2Count = Number(features.h2Count || 0);
  const faqHits = Number(features.faqHits || 0);
  const internalLinkCount = Number(features.internalLinkCount || 0);

  let score =
    Math.min(28, Math.floor(wordCount / 120)) +
    Math.min(20, blogLinks * 6) +
    Math.min(16, toolLinks * 5) +
    Math.min(10, docLinks * 4) +
    Math.min(14, maturePathHits * 3) +
    Math.min(12, h2Count * 2) +
    Math.min(12, faqHits * 4) +
    Math.min(10, Math.floor(internalLinkCount / 8)) +
    (features.hasComparisonTable ? 10 : 0) +
    (features.hasStructuredData ? 6 : 0) +
    (features.hasNewsletterOrForm ? 4 : 0) +
    (features.matureCopyHits ? 6 : 0);

  // Thin default apps stay immature.
  if (wordCount > 0 && wordCount < 180 && blogLinks === 0 && toolLinks === 0) {
    score = Math.min(score, 22);
  }

  return clamp(score);
}

export function maturityLabel(score) {
  if (score >= 75) return "已成型";
  if (score >= 55) return "较成熟";
  if (score >= 35) return "半成品";
  return "早期/壳";
}

/**
 * Winability: can a latecomer still win?
 * High when SEO gap exists, product is immature, competition is low.
 */
export function computeWinability({
  seoGap = 0,
  maturity = 0,
  competition = 50,
  demand = 50,
  risk = 0
} = {}) {
  const raw =
    seoGap * 0.28 +
    (100 - maturity) * 0.32 +
    (100 - competition) * 0.3 +
    Math.min(demand, 80) * 0.1 -
    risk * 0.15;
  return clamp(Math.round(raw));
}
