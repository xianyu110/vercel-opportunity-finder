import { safeHost } from "./scoring.js";

/**
 * Build rising / day-over-day deltas between two host maps.
 * Pure — safe for Cloudflare Worker.
 */
export function compareHostMaps(currentHosts = {}, previousHosts = {}) {
  const rising = [];
  const declined = [];
  const newcomers = [];
  const stable = [];

  for (const [host, current] of Object.entries(currentHosts)) {
    const prev = previousHosts[host];
    if (!prev) {
      const entry = {
        host,
        isNew: true,
        scoreDelta: current.score || 0,
        sourceDelta: current.sourceCount || (current.sources || []).length || 0,
        scanDelta: Number(current.scanCount7d || 0),
        previousScore: null,
        currentScore: current.score || 0,
        risingScore: Math.min(
          100,
          40 +
            Math.round((current.score || 0) * 0.35) +
            Math.min(20, Number(current.scanCount7d || 0) * 3)
        ),
        label: "新出现"
      };
      newcomers.push(entry);
      rising.push(entry);
      continue;
    }

    const scoreDelta = (current.score || 0) - (prev.score || 0);
    const sourceDelta =
      (current.sourceCount || (current.sources || []).length || 0) -
      (prev.sourceCount || (prev.sources || []).length || 0);
    const scanDelta =
      Number(current.scanCount7d || 0) - Number(prev.scanCount7d || 0);

    const risingScore = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          scoreDelta * 2.2 +
            sourceDelta * 12 +
            Math.min(30, scanDelta * 4) +
            (scanDelta > 0 && scoreDelta >= 0 ? 8 : 0)
        )
      )
    );

    const entry = {
      host,
      isNew: false,
      scoreDelta,
      sourceDelta,
      scanDelta,
      previousScore: prev.score || 0,
      currentScore: current.score || 0,
      risingScore,
      label:
        risingScore >= 35
          ? "上升"
          : scoreDelta <= -8 || scanDelta <= -3
            ? "回落"
            : "持平"
    };

    if (entry.label === "上升") rising.push(entry);
    else if (entry.label === "回落") declined.push(entry);
    else stable.push(entry);
  }

  rising.sort((a, b) => b.risingScore - a.risingScore);
  declined.sort((a, b) => a.scoreDelta - b.scoreDelta);
  newcomers.sort((a, b) => b.currentScore - a.currentScore);

  return {
    rising,
    declined,
    newcomers,
    stable,
    summary: {
      currentHosts: Object.keys(currentHosts).length,
      previousHosts: Object.keys(previousHosts).length,
      risingCount: rising.length,
      newCount: newcomers.length,
      declinedCount: declined.length
    }
  };
}

export function attachHistorySignals(items, comparison) {
  const byHost = new Map();
  for (const bucket of ["rising", "declined", "newcomers", "stable"]) {
    for (const entry of comparison[bucket] || []) {
      byHost.set(entry.host, entry);
    }
  }

  return items.map((item) => {
    const host = item.host || safeHost(item.url);
    const hist = byHost.get(host);
    if (!hist) {
      return {
        ...item,
        history: {
          isNew: true,
          scoreDelta: null,
          risingScore: 0,
          label: "无历史"
        }
      };
    }

    const nextTags = new Set(item.categoryTags || []);
    if (hist.label === "上升" || hist.isNew) nextTags.add("上升中");
    if (hist.isNew) nextTags.add("新出现");

    return {
      ...item,
      history: hist,
      categoryTags: Array.from(nextTags),
      score: Math.min(
        100,
        Math.round(
          (item.score || 0) +
            (hist.risingScore >= 40 ? Math.min(8, hist.risingScore * 0.08) : 0)
        )
      )
    };
  });
}

export function compactHostEntry(item) {
  const host = item.host || safeHost(item.url);
  if (!host) return null;

  return {
    host,
    url: item.url || `https://${host}/`,
    score: Number(item.score || 0),
    decision: item.decision || "观察",
    keyword: item.keyword || "",
    title: item.title || item.ogTitle || "",
    sources: Array.isArray(item.sources)
      ? item.sources
      : item.source
        ? [item.source]
        : [],
    sourceCount: Number(item.sourceCount || (item.sources || []).length || 0),
    scanCount7d: Number(item.scanCount7d || 0),
    scanCountPrev7d: Number(item.scanCountPrev7d || 0),
    scanMomentum: Number(item.scanMomentum || 0),
    lastSeen: item.lastSeen || "",
    stars: Number(item.stars || 0),
    points: Number(item.points || 0),
    downloadsWeekly: Number(item.downloadsWeekly || 0),
    ok: Boolean(item.ok),
    categoryTags: item.categoryTags || [],
    riskFlags: item.riskFlags || []
  };
}
