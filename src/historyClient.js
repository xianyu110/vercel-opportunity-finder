import {
  attachHistorySignals,
  compareHostMaps,
  compactHostEntry
} from "../server/history-core.js";

export const LOCAL_HISTORY_KEY = "vercel-opportunity-finder.local-history.v1";

export function readLocalHistory() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeLocalHistory(entries) {
  if (typeof window === "undefined") return;
  const trimmed = (entries || []).slice(0, 40);
  window.localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(trimmed));
}

export function pushLocalHistorySnapshot({ suffix, items, meta }) {
  const hosts = {};
  for (const item of items || []) {
    const entry = compactHostEntry(item);
    if (!entry) continue;
    hosts[entry.host] = entry;
  }

  const entry = {
    id: new Date().toISOString().replace(/[:.]/g, "-"),
    createdAt: new Date().toISOString(),
    suffix,
    hostCount: Object.keys(hosts).length,
    hosts,
    meta: meta || {}
  };

  const next = [entry, ...readLocalHistory().filter((row) => row.id !== entry.id)];
  writeLocalHistory(next);
  return entry;
}

export function getLocalSnapshots({ suffix, limit = 20 } = {}) {
  return readLocalHistory()
    .filter((row) => !suffix || row.suffix === suffix)
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      suffix: row.suffix,
      hostCount: row.hostCount,
      local: true
    }));
}

export function getLocalSnapshot(id) {
  return readLocalHistory().find((row) => row.id === id) || null;
}

/**
 * If server history is empty / first-run noise, enrich items with local day-over-day.
 */
export function enrichWithLocalHistory(items, { suffix } = {}) {
  const snapshots = readLocalHistory().filter((row) => !suffix || row.suffix === suffix);
  // snapshots[0] is the one just written — day-over-day needs a true previous run.
  const previous = snapshots.length >= 2 ? snapshots[1] : null;
  if (!previous?.hosts) {
    return {
      items,
      comparison: compareHostMaps({}, {}),
      previous: null
    };
  }

  const currentHosts = Object.fromEntries(
    (items || [])
      .map((item) => compactHostEntry(item))
      .filter(Boolean)
      .map((entry) => [entry.host, entry])
  );

  const comparison = compareHostMaps(currentHosts, previous.hosts);
  const enriched = attachHistorySignals(items, comparison);

  return {
    items: enriched,
    comparison,
    previous: {
      id: previous.id,
      createdAt: previous.createdAt,
      hostCount: previous.hostCount
    }
  };
}

/**
 * True when server didn't attach meaningful day-over-day history.
 */
export function needsLocalHistoryFallback(items = []) {
  if (!items.length) return true;
  const withHist = items.filter((item) => item.history && item.history.label !== "无历史");
  if (!withHist.length) return true;

  // All "新出现" on a non-empty local history suggests server had no previous snapshot.
  const allNew = withHist.every((item) => item.history?.isNew || item.history?.label === "新出现");
  const localCount = readLocalHistory().length;
  return allNew && localCount >= 1;
}

export function buildRisingExport(rows, { suffix = "vercel.app" } = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const rising = (rows || []).filter(
    (row) =>
      row.history?.label === "上升" ||
      row.history?.isNew ||
      (row.scanMomentum || 0) >= 40 ||
      (row.categoryTags || []).some((tag) => /上升|新出现|热扫/.test(tag))
  );

  const lines = [
    `# 上升机会导出 ${date}`,
    "",
    `- 后缀：${suffix}`,
    `- 数量：${rising.length}`,
    ""
  ];

  rising.forEach((row, index) => {
    lines.push(`## ${index + 1}. ${row.host}`);
    lines.push("");
    lines.push(`- 结论：${row.decision || "观察"}`);
    lines.push(`- 机会分：${row.score}`);
    lines.push(`- 趋势：${row.history?.label || "-"} · rising ${row.history?.risingScore ?? "-"}`);
    lines.push(
      `- 扫描：momentum ${row.scanMomentum || 0} · 7d ${row.scanCount7d || 0} / prev ${row.scanCountPrev7d || 0}`
    );
    lines.push(`- 关键词：${row.keyword || "-"}`);
    lines.push(`- URL：${row.url}`);
    lines.push(`- 来源：${(row.sources || [row.source]).filter(Boolean).join(" + ")}`);
    lines.push("");
  });

  return lines.join("\n");
}
