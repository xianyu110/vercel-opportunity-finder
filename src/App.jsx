import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownUp,
  Binary,
  Bookmark,
  ChevronRight,
  Download,
  Filter,
  Github,
  Globe2,
  History,
  Loader2,
  MessageCircle,
  Play,
  Radar,
  Search,
  ShieldAlert,
  Sparkles,
  Star,
  Terminal,
  TrendingUp,
  Zap
} from "lucide-react";
import {
  analyzeUrls,
  discoverAll,
  listHistory,
  getHistoryRising,
  getHistorySnapshot
} from "./api";
import {
  pushLocalHistorySnapshot,
  getLocalSnapshots,
  getLocalSnapshot,
  enrichWithLocalHistory,
  needsLocalHistoryFallback,
  buildRisingExport
} from "./historyClient";

const SOURCES = [
  { key: "commoncrawl", apiKey: "commoncrawl", label: "Common Crawl", hint: "公开网页索引", defaultOn: true },
  { key: "urlscan", apiKey: "urlscan", label: "URLScan", hint: "扫描动量/上升代理", defaultOn: true },
  { key: "githubRepos", apiKey: "github-repos", label: "GitHub Repos", hint: "仓库描述/主页", defaultOn: true },
  { key: "githubIssues", apiKey: "github-issues", label: "GitHub Issues", hint: "Issue 讨论", defaultOn: true },
  { key: "hackernews", apiKey: "hackernews", label: "Hacker News", hint: "HN 提交", defaultOn: true },
  { key: "npm", apiKey: "npm", label: "npm", hint: "包描述/主页", defaultOn: true },
  { key: "gitlab", apiKey: "gitlab", label: "GitLab", hint: "公开项目", defaultOn: true },
  { key: "reddit", apiKey: "reddit", label: "Reddit", hint: "公开讨论链接", defaultOn: true },
  { key: "bluesky", apiKey: "bluesky", label: "Bluesky", hint: "公开帖子搜索", defaultOn: true },
  { key: "producthunt", apiKey: "producthunt", label: "Product Hunt", hint: "PH 公开搜索", defaultOn: false },
  { key: "stackoverflow", apiKey: "stackoverflow", label: "Stack Overflow", hint: "问答提及", defaultOn: false },
  { key: "internetArchive", apiKey: "internet-archive", label: "Internet Archive", hint: "历史网页快照", defaultOn: false },
  { key: "certificates", apiKey: "certificates", label: "crt.sh", hint: "证书日志，量大偏旧", defaultOn: false }
];

const DEFAULT_MANUAL = [
  "toon-tone.vercel.app",
  "gridmaker.vercel.app",
  "ytp-length.vercel.app"
].join("\n");
const STORAGE_KEY = "vercel-opportunity-finder.watchlist.v1";
const STAGES = ["待验证", "验证中", "可开工", "放弃"];

function formatDate(value) {
  if (!value) return "-";
  if (/^\d{14}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function scoreClass(score) {
  if (score >= 78) return "score score-hot";
  if (score >= 58) return "score score-mid";
  return "score";
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url || "").replace(/^https?:\/\//, "").split("/")[0];
  }
}

function normalizeManualUrls(value) {
  return value
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatSources(row) {
  if (Array.isArray(row?.sources) && row.sources.length) {
    return row.sources.join(" + ");
  }
  return row?.source || "-";
}

function readWatchlist() {
  if (typeof window === "undefined") return {};

  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeWatchlist(next) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function defaultWatchEntry(row) {
  return {
    saved: true,
    stage: row?.decision === "放弃" ? "放弃" : "待验证",
    note: "",
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function withWatch(row, watchlist) {
  const entry = watchlist[row.host];
  return entry ? { ...row, watch: entry } : row;
}

function buildResearchLinks(site) {
  const keyword = site?.keyword || site?.title || site?.host || "";
  const encodedKeyword = encodeURIComponent(keyword);
  const exactKeyword = encodeURIComponent(`"${keyword}"`);
  const host = site?.host || hostFromUrl(site?.url || "");
  const encodedHost = encodeURIComponent(host);

  return [
    {
      key: "google",
      label: "Google",
      title: "查 SERP",
      href: `https://www.google.com/search?q=${encodedKeyword}`
    },
    {
      key: "trends",
      label: "Trends",
      title: "看趋势",
      href: `https://trends.google.com/trends/explore?q=${encodedKeyword}`
    },
    {
      key: "github",
      label: "GitHub",
      title: "找同类项目",
      href: `https://github.com/search?q=${exactKeyword}%20OR%20${encodedHost}&type=repositories`
    },
    {
      key: "reddit",
      label: "Reddit",
      title: "看讨论",
      href: `https://www.google.com/search?q=site%3Areddit.com%20${encodedKeyword}`
    },
    {
      key: "ph",
      label: "PH",
      title: "查 Product Hunt",
      href: `https://www.google.com/search?q=site%3Aproducthunt.com%2Fposts%20${encodedKeyword}`
    }
  ];
}

function buildExternalSignals(site) {
  const signals = [];
  if (site?.stars > 0) signals.push(`stars ${site.stars}`);
  if (site?.forks > 0) signals.push(`forks ${site.forks}`);
  if (site?.openIssues > 0) signals.push(`issues ${site.openIssues}`);
  if (site?.points > 0) signals.push(`HN points ${site.points}`);
  if (site?.comments > 0) signals.push(`comments ${site.comments}`);
  if (site?.downloadsWeekly > 0) signals.push(`weekly downloads ${site.downloadsWeekly}`);
  if (site?.downloadsMonthly > 0) signals.push(`monthly downloads ${site.downloadsMonthly}`);
  if (site?.repoName) signals.push(site.repoName);
  if (site?.packageName) signals.push(site.packageName);
  return signals;
}

function downloadTextFile({ content, filename, type = "text/markdown;charset=utf-8" }) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCsv(rows) {
  const headers = [
    "url",
    "score",
    "decision",
    "source",
    "keyword",
    "title",
    "description",
    "weaknesses",
    "signals",
    "externalSignals",
    "riskFlags",
    "categoryTags",
    "lastSeen"
  ];
  const escapeCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csvCellValue = (row, key) => {
    if (key === "externalSignals") return buildExternalSignals(row).join("; ");
    if (Array.isArray(row[key])) return row[key].join("; ");
    return row[key];
  };
  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((key) => escapeCell(csvCellValue(row, key)))
        .join(",")
    )
  ].join("\n");

  downloadTextFile({
    content: csv,
    filename: `vercel-opportunities-${new Date().toISOString().slice(0, 10)}.csv`,
    type: "text/csv;charset=utf-8"
  });
}

function buildMarkdownReport(rows) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Vercel 机会池报告 ${date}`,
    "",
    `共 ${rows.length} 个候选。`,
    ""
  ];

  rows.forEach((row, index) => {
    const watch = row.watch || {};
    const links = buildResearchLinks(row);
    lines.push(`## ${index + 1}. ${row.host}`);
    lines.push("");
    lines.push(`- 结论：${row.decision || "观察"}`);
    lines.push(`- 阶段：${watch.stage || "未收藏"}`);
    lines.push(`- 机会分：${row.score}`);
    lines.push(`- 关键词：${row.keyword || "-"}`);
    lines.push(`- 标题：${row.title || row.ogTitle || "-"}`);
    lines.push(`- URL：${row.url}`);
    lines.push(`- 分类：${(row.categoryTags || []).join(" / ") || "-"}`);
    lines.push(`- 风险：${(row.riskFlags || []).join(" / ") || "未发现高风险信号"}`);
    lines.push(`- SEO 缺口：${(row.weaknesses || []).join(" / ") || "-"}`);
    lines.push(`- 信号：${(row.signals || []).join(" / ") || "-"}`);
    lines.push(`- 外部热度：${buildExternalSignals(row).join(" / ") || "-"}`);
    lines.push(`- 备注：${watch.note || "-"}`);
    lines.push("");
    lines.push("验证入口：");
    links.forEach((link) => {
      lines.push(`- [${link.label}](${link.href})`);
    });
    lines.push("");
  });

  return lines.join("\n");
}

function exportMarkdown(rows) {
  downloadTextFile({
    content: buildMarkdownReport(rows),
    filename: `vercel-opportunity-report-${new Date().toISOString().slice(0, 10)}.md`
  });
}

export default function App() {
  const [suffix, setSuffix] = useState("vercel.app");
  const [limit, setLimit] = useState(40);
  const [selectedSources, setSelectedSources] = useState(() =>
    Object.fromEntries(SOURCES.map((source) => [source.key, Boolean(source.defaultOn)]))
  );
  const [manualUrls, setManualUrls] = useState(DEFAULT_MANUAL);
  const [candidatePool, setCandidatePool] = useState([]);
  const [rows, setRows] = useState([]);
  const [selectedHost, setSelectedHost] = useState("");
  const [query, setQuery] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [analyzeLimit, setAnalyzeLimit] = useState(30);
  const [analyzeMode, setAnalyzeMode] = useState("smart");
  const [enrichMomentum, setEnrichMomentum] = useState(true);
  const [enrichCompetition, setEnrichCompetition] = useState(true);
  const [saveHistory, setSaveHistory] = useState(true);
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [showRisingOnly, setShowRisingOnly] = useState(false);
  const [showWinnableOnly, setShowWinnableOnly] = useState(false);
  const [watchlist, setWatchlist] = useState(() => readWatchlist());
  const [historySnapshots, setHistorySnapshots] = useState([]);
  const [risingSummary, setRisingSummary] = useState(null);
  const [risingBoard, setRisingBoard] = useState([]);
  const [lastSnapshot, setLastSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("待命：选择数据源后开始扫描。");
  const [error, setError] = useState("");

  const enrichedRows = useMemo(
    () => rows.map((row) => withWatch(row, watchlist)),
    [rows, watchlist]
  );

  const selected = useMemo(() => {
    if (!enrichedRows.length) return null;
    return enrichedRows.find((row) => row.host === selectedHost) || enrichedRows[0];
  }, [enrichedRows, selectedHost]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return enrichedRows
      .filter((row) => !showSavedOnly || row.watch?.saved)
      .filter((row) => row.score >= minScore)
      .filter((row) => decisionFilter === "all" || row.decision === decisionFilter)
      .filter((row) => {
        if (!showRisingOnly) return true;
        const label = row.history?.label;
        return (
          label === "上升" ||
          label === "新出现" ||
          (row.scanMomentum || 0) >= 40 ||
          (row.categoryTags || []).some((tag) => /上升|新出现|热扫/.test(tag))
        );
      })
      .filter((row) => {
        if (!showWinnableOnly) return true;
        return (
          (row.winabilityScore || 0) >= 55 &&
          (row.competitionScore || 0) < 70 &&
          (row.maturityScore || 0) < 70 &&
          row.decision !== "放弃"
        );
      })
      .filter((row) => {
        if (!needle) return true;
        return `${row.url} ${row.title} ${row.keyword} ${row.description} ${formatSources(row)} ${row.watch?.note || ""}`
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => {
        if (showWinnableOnly) {
          const winDiff = (b.winabilityScore || 0) - (a.winabilityScore || 0);
          if (winDiff !== 0) return winDiff;
        }
        const risingDiff = (b.history?.risingScore || b.scanMomentum || 0) - (a.history?.risingScore || a.scanMomentum || 0);
        if (showRisingOnly && risingDiff !== 0) return risingDiff;
        return b.score - a.score;
      });
  }, [enrichedRows, query, minScore, showSavedOnly, decisionFilter, showRisingOnly, showWinnableOnly]);

  const stats = useMemo(() => {
    const hot = enrichedRows.filter((row) => row.decision === "值得").length;
    const watch = enrichedRows.filter((row) => row.decision === "观察").length;
    const rising = enrichedRows.filter(
      (row) =>
        row.history?.label === "上升" ||
        row.history?.isNew ||
        (row.scanMomentum || 0) >= 40
    ).length;
    const multi = enrichedRows.filter((row) => (row.sources || []).length >= 2).length;
    const saved = Object.values(watchlist).filter((entry) => entry?.saved).length;
    return {
      total: enrichedRows.length,
      pool: candidatePool.length,
      hot,
      watch,
      rising,
      multi,
      saved
    };
  }, [enrichedRows, watchlist, candidatePool.length]);

  const reportRows = useMemo(() => {
    const savedRows = enrichedRows.filter((row) => row.watch?.saved);
    return savedRows.length ? savedRows : filteredRows;
  }, [enrichedRows, filteredRows]);

  useEffect(() => {
    refreshHistorySidebar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suffix]);

  function updateWatch(host, updater) {
    setWatchlist((current) => {
      const currentEntry = current[host] || {};
      const nextEntry = {
        ...currentEntry,
        ...updater(currentEntry),
        updatedAt: new Date().toISOString()
      };
      const next = { ...current, [host]: nextEntry };

      if (!nextEntry.saved && !nextEntry.note && !nextEntry.stage) {
        delete next[host];
      }

      writeWatchlist(next);
      return next;
    });
  }

  function toggleSaved(row) {
    updateWatch(row.host, (entry) => {
      if (entry.saved) {
        return { ...entry, saved: false };
      }

      return {
        ...defaultWatchEntry(row),
        ...entry,
        saved: true,
        savedAt: entry.savedAt || new Date().toISOString()
      };
    });
  }

  function updateStage(row, stage) {
    updateWatch(row.host, (entry) => ({
      ...defaultWatchEntry(row),
      ...entry,
      saved: true,
      stage
    }));
  }

  function updateNote(row, note) {
    updateWatch(row.host, (entry) => ({
      ...defaultWatchEntry(row),
      ...entry,
      saved: true,
      note
    }));
  }

  async function refreshHistorySidebar() {
    try {
      const payload = await listHistory({ suffix, limit: 12 });
      const serverSnaps = payload.snapshots || [];
      const localSnaps = getLocalSnapshots({ suffix, limit: 12 });
      // Prefer server list; merge local-only ids.
      const seen = new Set(serverSnaps.map((row) => row.id));
      setHistorySnapshots([
        ...serverSnaps,
        ...localSnaps.filter((row) => !seen.has(row.id))
      ]);
    } catch {
      setHistorySnapshots(getLocalSnapshots({ suffix, limit: 12 }));
    }

    try {
      const rising = await getHistoryRising({ suffix, limit: 15 });
      setRisingSummary(rising);
      setRisingBoard(rising.items || rising.comparison?.rising || []);
    } catch {
      // Derive board from current rows if API unavailable.
      setRisingSummary(null);
      setRisingBoard(
        rows
          .filter(
            (row) =>
              row.history?.label === "上升" ||
              row.history?.isNew ||
              (row.scanMomentum || 0) >= 40
          )
          .map((row) => ({
            host: row.host,
            label: row.history?.label || "扫描上升",
            risingScore: row.history?.risingScore || row.scanMomentum || 0,
            currentScore: row.score,
            scoreDelta: row.history?.scoreDelta
          }))
          .slice(0, 15)
      );
    }
  }

  function applyAnalyzedItems(items, { reason = "discover", analyzed = {} } = {}) {
    let nextItems = [...(items || [])];

    // Save local snapshot first so fallback can see previous runs.
    if (saveHistory) {
      pushLocalHistorySnapshot({
        suffix,
        items: nextItems,
        meta: { mode: analyzeMode, reason }
      });
    }

    if (needsLocalHistoryFallback(nextItems)) {
      const local = enrichWithLocalHistory(nextItems, { suffix });
      nextItems = local.items;
      if (local.comparison) {
        setRisingSummary({
          comparison: local.comparison,
          previous: local.previous
        });
        setRisingBoard(local.comparison.rising || []);
      }
    } else if (analyzed.rising) {
      setRisingBoard(analyzed.rising);
      setRisingSummary({
        comparison: { summary: analyzed.history?.summary, rising: analyzed.rising },
        previous: analyzed.history?.previous
      });
    }

    const sorted = nextItems.sort((a, b) => b.score - a.score);
    setRows(sorted);
    setSelectedHost(sorted[0]?.host || "");
    return sorted;
  }

  async function analyzeBatch(candidates, { excludedHosts = [], reason = "discover" } = {}) {
    const batchSize = Math.min(candidates.length, analyzeLimit);
    const modeLabel =
      reason === "reshuffle"
        ? "换一批"
        : reason === "rising"
          ? "上升复扫"
          : reason === "snapshot"
            ? "快照复扫"
            : analyzeMode === "smart"
              ? "智能优先"
              : "随机抽样";

    setRows([]);
    setSelectedHost("");
    setStatus(
      `候选池 ${candidates.length} 个，${modeLabel}分析 ${batchSize} 个` +
        `${enrichMomentum ? " + 动量" : ""}${enrichCompetition ? " + 竞争" : ""}...`
    );

    const analyzed = await analyzeUrls({
      urls: candidates,
      limit: batchSize,
      source: reason === "rising" ? "Rising" : "Discovery",
      mode: reason === "rising" ? "smart" : analyzeMode,
      excludedHosts,
      suffix,
      enrichMomentum,
      enrichCompetition,
      saveHistory
    });

    const sorted = applyAnalyzedItems(analyzed.items || [], { reason, analyzed });

    if (analyzed.snapshot) {
      setLastSnapshot(analyzed.snapshot);
    }

    const risingCount = sorted.filter(
      (row) => row.history?.label === "上升" || row.history?.isNew || (row.scanMomentum || 0) >= 40
    ).length;
    const momentumHits = sorted.filter((row) => (row.scanMomentum || 0) >= 40).length;
    setStatus(
      `完成：分析 ${sorted.length}/${analyzed.poolSize || candidates.length} · 上升 ${risingCount} · 扫描动量高 ${momentumHits}` +
        (analyzed.snapshot ? ` · 快照 ${analyzed.snapshot.id.slice(0, 19)}` : "")
    );

    await refreshHistorySidebar();
  }

  async function reanalyzeRising() {
    const hosts = risingBoard.map((row) => row.host).filter(Boolean);
    if (!hosts.length) {
      // fallback to current rising rows
      const fromRows = rows
        .filter(
          (row) =>
            row.history?.label === "上升" ||
            row.history?.isNew ||
            (row.scanMomentum || 0) >= 40
        )
        .map((row) => row.host);
      if (!fromRows.length) {
        setError("暂无上升 host 可复扫，先跑一轮发现。");
        return;
      }
      setLoading(true);
      setError("");
      try {
        await analyzeBatch(
          fromRows.map((host) => ({ url: `https://${host}/`, source: "Rising", sources: ["Rising"] })),
          { reason: "rising" }
        );
      } catch (err) {
        setError(err.message || "上升复扫失败");
      } finally {
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    setError("");
    try {
      await analyzeBatch(
        hosts.map((host) => ({ url: `https://${host}/`, source: "Rising", sources: ["Rising"] })),
        { reason: "rising" }
      );
      setShowRisingOnly(true);
    } catch (err) {
      setError(err.message || "上升复扫失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadSnapshotForRescan(snapshotMeta) {
    if (!snapshotMeta?.id) return;
    setLoading(true);
    setError("");
    try {
      let hosts = [];
      try {
        const payload = await getHistorySnapshot(snapshotMeta.id);
        hosts = Object.keys(payload.snapshot?.hosts || {});
      } catch {
        const local = getLocalSnapshot(snapshotMeta.id);
        hosts = Object.keys(local?.hosts || {});
      }

      if (!hosts.length) {
        throw new Error("快照里没有 host");
      }

      setCandidatePool(
        hosts.map((host) => ({
          url: `https://${host}/`,
          source: "Snapshot",
          sources: ["Snapshot"]
        }))
      );
      await analyzeBatch(
        hosts.map((host) => ({ url: `https://${host}/`, source: "Snapshot", sources: ["Snapshot"] })),
        { reason: "snapshot" }
      );
      setStatus(`已从快照 ${snapshotMeta.id.slice(0, 19)} 复扫 ${hosts.length} 个 host`);
    } catch (err) {
      setError(err.message || "加载快照失败");
    } finally {
      setLoading(false);
    }
  }

  function exportRisingReport() {
    const content = buildRisingExport(enrichedRows, { suffix });
    downloadTextFile({
      content,
      filename: `vercel-rising-${new Date().toISOString().slice(0, 10)}.md`
    });
  }

  async function runDiscovery() {
    setLoading(true);
    setError("");
    setCandidatePool([]);
    setRows([]);
    setSelectedHost("");

    try {
      const activeSources = SOURCES.filter((source) => selectedSources[source.key]).map(
        (source) => source.apiKey
      );

      setStatus(
        activeSources.length
          ? `并行发现中（${activeSources.length} 个数据源）...`
          : "仅使用手动 URL..."
      );

      let discovered = [];
      const sourceErrors = [];

      if (activeSources.length) {
        try {
          const payload = await discoverAll({
            suffix,
            limit,
            sources: activeSources
          });
          discovered = payload.items || [];
          if (Array.isArray(payload.errors) && payload.errors.length) {
            sourceErrors.push(...payload.errors);
          }
          if (Array.isArray(payload.sources)) {
            const summary = payload.sources
              .map((item) => `${item.source || item.key}:${item.count || 0}`)
              .join(" · ");
            if (summary) setStatus(`发现完成：${summary}`);
          }
        } catch (err) {
          sourceErrors.push(err.message || "并行发现失败");
        }
      }

      const manual = normalizeManualUrls(manualUrls).map((url) => ({
        url,
        source: "Manual",
        sources: ["Manual"]
      }));
      discovered = [...discovered, ...manual];

      // Client-side host merge as a safety net
      const merged = new Map();
      for (const item of discovered) {
        const host = hostFromUrl(item.url);
        if (!host) continue;
        const prev = merged.get(host);
        if (!prev) {
          merged.set(host, {
            ...item,
            host,
            sources: Array.from(
              new Set([...(item.sources || []), item.source].filter(Boolean))
            )
          });
          continue;
        }
        merged.set(host, {
          ...prev,
          ...item,
          host,
          sources: Array.from(
            new Set([...(prev.sources || []), ...(item.sources || []), item.source].filter(Boolean))
          ),
          stars: Math.max(prev.stars || 0, item.stars || 0),
          points: Math.max(prev.points || 0, item.points || 0),
          downloadsWeekly: Math.max(prev.downloadsWeekly || 0, item.downloadsWeekly || 0)
        });
      }
      const unique = Array.from(merged.values());

      if (!unique.length) {
        setStatus("没有拿到候选域名，可以粘贴手动 URL 再分析。");
        return;
      }

      if (sourceErrors.length) {
        setError(sourceErrors.join("；"));
      }

      setCandidatePool(unique);
      await analyzeBatch(unique);
    } catch (err) {
      setError(err.message || "扫描失败");
      setStatus("扫描中断：请看错误信息。");
    } finally {
      setLoading(false);
    }
  }

  async function reshuffleBatch() {
    if (!candidatePool.length) return;

    setLoading(true);
    setError("");

    try {
      const currentHosts = rows.map((row) => row.host).filter(Boolean);
      await analyzeBatch(candidatePool, {
        excludedHosts: currentHosts,
        reason: "reshuffle"
      });
    } catch (err) {
      setError(err.message || "换一批失败");
      setStatus("换一批中断：请看错误信息。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <MatrixRain />

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Binary size={20} />
          </div>
          <div>
            <h1>Vercel Finder</h1>
            <p>需求雷达</p>
          </div>
        </div>

        <section className="side-section">
          <div className="side-title">
            <Radar size={15} />
            数据源
          </div>
          {SOURCES.map((source) => (
            <label className="source-toggle" key={source.key}>
              <input
                type="checkbox"
                checked={selectedSources[source.key]}
                onChange={(event) =>
                  setSelectedSources((current) => ({
                    ...current,
                    [source.key]: event.target.checked
                  }))
                }
              />
              <span>
                <strong>{source.label}</strong>
                <small>{source.hint}</small>
              </span>
            </label>
          ))}
        </section>

        <section className="side-section">
          <div className="side-title">
            <Terminal size={15} />
            手动导入
          </div>
          <textarea
            value={manualUrls}
            onChange={(event) => setManualUrls(event.target.value)}
            spellCheck="false"
            aria-label="手动 URL"
          />
        </section>

        <section className="side-section legend">
          <div className="side-title">
            <ShieldAlert size={15} />
            评分逻辑
          </div>
          <p>
            并行多源发现 → 合并 host → URLScan 扫描动量 → 历史快照日环比 → 智能抽样分析。输出值得 / 观察 / 放弃。
          </p>
        </section>

        <section className="side-section">
          <div className="side-title">
            <History size={15} />
            历史机会池
          </div>
          <div className="history-list">
            {historySnapshots.length ? (
              historySnapshots.slice(0, 8).map((snap) => (
                <button
                  type="button"
                  className="history-item history-item-btn"
                  key={snap.id}
                  onClick={() => loadSnapshotForRescan(snap)}
                  disabled={loading}
                  title="点击用该快照 host 复扫"
                >
                  <strong>{formatDate(snap.createdAt)}</strong>
                  <small>
                    {snap.hostCount || 0} hosts
                    {snap.local ? " · local" : ""} · 复扫
                  </small>
                </button>
              ))
            ) : (
              <p className="history-empty">扫描后自动写入快照，用于日环比。</p>
            )}
          </div>
          {risingSummary?.comparison?.summary ? (
            <div className="history-rising-box">
              <TrendingUp size={14} />
              <span>
                上升 {risingSummary.comparison.summary.risingCount || 0} · 新
                {risingSummary.comparison.summary.newCount || 0} · 回落
                {risingSummary.comparison.summary.declinedCount || 0}
              </span>
            </div>
          ) : null}

          <div className="rising-board">
            <div className="side-title" style={{ marginTop: 12 }}>
              <TrendingUp size={15} />
              上升榜
            </div>
            {risingBoard.length ? (
              risingBoard.slice(0, 8).map((row) => (
                <div className="rising-row" key={row.host}>
                  <strong title={row.host}>{row.host.replace(/\.vercel\.app$/, "")}</strong>
                  <small>
                    {row.label || "上升"} · {row.risingScore ?? "-"}
                    {typeof row.scoreDelta === "number" ? ` · Δ${row.scoreDelta}` : ""}
                  </small>
                </div>
              ))
            ) : (
              <p className="history-empty">跑完扫描后显示上升 host。</p>
            )}
            <div className="history-actions">
              <button
                type="button"
                className="ghost-btn mini-btn"
                onClick={reanalyzeRising}
                disabled={loading || !risingBoard.length}
              >
                <TrendingUp size={14} />
                复扫上升
              </button>
              <button
                type="button"
                className="ghost-btn mini-btn"
                onClick={exportRisingReport}
                disabled={!enrichedRows.length}
              >
                <Download size={14} />
                导出上升
              </button>
            </div>
          </div>

          {lastSnapshot ? (
            <p className="history-empty">最近快照：{lastSnapshot.id.slice(0, 19)}</p>
          ) : null}
        </section>
      </aside>

      <section className="workspace">
        <header className="command-bar">
          <div className="command-left">
            <label className="input-group suffix-input">
              <span>目标后缀</span>
              <input value={suffix} onChange={(event) => setSuffix(event.target.value)} />
            </label>
            <label className="input-group">
              <span>发现量</span>
              <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
                <option value={20}>20</option>
                <option value={40}>40</option>
                <option value={80}>80</option>
                <option value={150}>150</option>
              </select>
            </label>
            <label className="input-group">
              <span>分析量</span>
              <select
                value={analyzeLimit}
                onChange={(event) => setAnalyzeLimit(Number(event.target.value))}
              >
                <option value={15}>15</option>
                <option value={30}>30</option>
                <option value={50}>50</option>
                <option value={80}>80</option>
              </select>
            </label>
            <label className="input-group">
              <span>抽样</span>
              <select
                value={analyzeMode}
                onChange={(event) => setAnalyzeMode(event.target.value)}
              >
                <option value="smart">智能优先</option>
                <option value="random">随机</option>
              </select>
            </label>
            <label className="toggle-inline" title="URLScan 近7日 vs 前7日扫描量">
              <input
                type="checkbox"
                checked={enrichMomentum}
                onChange={(event) => setEnrichMomentum(event.target.checked)}
              />
              <span>扫描动量</span>
            </label>
            <label className="toggle-inline" title="关键词竞争/红海检测（DuckDuckGo+启发式）">
              <input
                type="checkbox"
                checked={enrichCompetition}
                onChange={(event) => setEnrichCompetition(event.target.checked)}
              />
              <span>竞争密度</span>
            </label>
            <label className="toggle-inline" title="写入 data/snapshots 与本地历史">
              <input
                type="checkbox"
                checked={saveHistory}
                onChange={(event) => setSaveHistory(event.target.checked)}
              />
              <span>存历史</span>
            </label>
            <button className="primary-btn" onClick={runDiscovery} disabled={loading}>
              {loading ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
              开始发现
            </button>
            <button
              className="ghost-btn"
              onClick={reshuffleBatch}
              disabled={loading || !candidatePool.length}
            >
              {loading ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
              换一批
            </button>
            <button
              className="ghost-btn"
              onClick={() => exportCsv(filteredRows)}
              disabled={!filteredRows.length}
            >
              <Download size={16} />
              导出 CSV
            </button>
            <button
              className="ghost-btn"
              onClick={() => exportMarkdown(reportRows)}
              disabled={!reportRows.length}
            >
              <Download size={16} />
              导出报告
            </button>
            <button
              className="ghost-btn"
              onClick={exportRisingReport}
              disabled={!enrichedRows.length}
            >
              <TrendingUp size={16} />
              导出上升
            </button>
          </div>
          <div className="system-status">
            <Activity size={15} />
            {status}
          </div>
        </header>

        {error ? <div className="error-line">{error}</div> : null}

        <section className="kpi-grid">
          <Kpi icon={<Radar size={18} />} label="候选池" value={stats.pool || stats.total} />
          <Kpi icon={<Globe2 size={18} />} label="已分析" value={stats.total} />
          <Kpi icon={<Zap size={18} />} label="值得做" value={stats.hot} />
          <Kpi icon={<TrendingUp size={18} />} label="上升中" value={stats.rising} />
          <Kpi icon={<Binary size={18} />} label="多源命中" value={stats.multi} />
          <Kpi icon={<Bookmark size={18} />} label="已收藏" value={stats.saved} />
        </section>

        <section className="content-grid">
          <div className="table-panel">
            <div className="table-tools">
              <label className="search-box">
                <Search size={16} />
                <input
                  placeholder="筛 URL、标题、关键词..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label className="range-box">
                <Filter size={15} />
                <span>{minScore}+</span>
                <input
                  type="range"
                  min="0"
                  max="90"
                  step="10"
                  value={minScore}
                  onChange={(event) => setMinScore(Number(event.target.value))}
                />
              </label>
              <label className="input-group decision-filter">
                <span>结论</span>
                <select
                  value={decisionFilter}
                  onChange={(event) => setDecisionFilter(event.target.value)}
                >
                  <option value="all">全部</option>
                  <option value="值得">值得</option>
                  <option value="观察">观察</option>
                  <option value="放弃">放弃</option>
                </select>
              </label>
              <button
                className={showRisingOnly ? "toggle-chip active" : "toggle-chip"}
                onClick={() => setShowRisingOnly((value) => !value)}
              >
                <TrendingUp size={14} />
                只看上升
              </button>
              <button
                className={showWinnableOnly ? "toggle-chip active" : "toggle-chip"}
                onClick={() => setShowWinnableOnly((value) => !value)}
              >
                <Zap size={14} />
                只看可切入
              </button>
              <button
                className={showSavedOnly ? "toggle-chip active" : "toggle-chip"}
                onClick={() => setShowSavedOnly((value) => !value)}
              >
                <Bookmark size={14} />
                只看收藏
              </button>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>
                      <span className="th-sort">
                        Score <ArrowDownUp size={13} />
                      </span>
                    </th>
                    <th>Decision</th>
                    <th>Trend</th>
                    <th>Win</th>
                    <th>Source</th>
                    <th>Title</th>
                    <th>Keyword</th>
                    <th>Flags</th>
                    <th>Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr
                      key={`${row.host}-${row.source}`}
                      className={selected?.host === row.host ? "selected-row" : ""}
                      onClick={() => setSelectedHost(row.host)}
                    >
                      <td className="url-cell">
                        <div className="url-line">
                          <button
                            className={row.watch?.saved ? "icon-action saved" : "icon-action"}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleSaved(row);
                            }}
                            title={row.watch?.saved ? "取消收藏" : "收藏"}
                          >
                            <Star size={14} />
                          </button>
                          <span>{row.host}</span>
                        </div>
                        {row.ok ? <small>online</small> : <small className="muted">check failed</small>}
                      </td>
                      <td>
                        <span className={scoreClass(row.score)}>{row.score}</span>
                      </td>
                      <td>
                        <DecisionBadge decision={row.decision} />
                      </td>
                      <td>
                        <TrendBadge row={row} />
                      </td>
                      <td>
                        <WinBadge row={row} />
                      </td>
                      <td className="truncate source-cell" title={formatSources(row)}>
                        {formatSources(row)}
                      </td>
                      <td className="truncate">{row.title || row.ogTitle || "-"}</td>
                      <td className="keyword-cell">
                        <span>{row.keyword || "-"}</span>
                        <ResearchLinks site={row} compact />
                      </td>
                      <td className="truncate">
                        {[
                          ...(row.riskFlags || []),
                          ...(row.categoryTags || []),
                          ...(row.weaknesses || [])
                        ].slice(0, 2).join(" / ") || "-"}
                      </td>
                      <td>{formatDate(row.lastSeen || row.discoveredAt)}</td>
                    </tr>
                  ))}
                  {!filteredRows.length ? (
                    <tr>
                      <td colSpan="10" className="empty-state">
                        {loading ? "正在扫描矩阵信号..." : "暂无数据，点击开始发现。"}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <Inspector
            site={selected}
            onToggleSaved={toggleSaved}
            onUpdateStage={updateStage}
            onUpdateNote={updateNote}
          />
        </section>
      </section>
    </main>
  );
}

function Kpi({ icon, label, value }) {
  return (
    <div className="kpi">
      <div className="kpi-icon">{icon}</div>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function DecisionBadge({ decision }) {
  const value = decision || "观察";
  return <span className={`decision-badge decision-${value}`}>{value}</span>;
}

function TrendBadge({ row }) {
  const label = row?.history?.label;
  const momentum = row?.scanMomentum || 0;
  const delta = row?.history?.scoreDelta;
  const scan7 = row?.scanCount7d;

  if (label === "上升" || label === "新出现") {
    return (
      <span className="trend-badge trend-up" title={`risingScore ${row.history?.risingScore || 0}`}>
        {label === "新出现" ? "NEW" : "↑"}
        {typeof delta === "number" && delta !== 0 ? ` ${delta > 0 ? "+" : ""}${delta}` : ""}
      </span>
    );
  }

  if (momentum >= 40) {
    return (
      <span className="trend-badge trend-up" title={`scanMomentum ${momentum}`}>
        扫↑{scan7 || ""}
      </span>
    );
  }

  if (label === "回落") {
    return <span className="trend-badge trend-down">↓</span>;
  }

  return <span className="trend-badge trend-flat">·</span>;
}

function WinBadge({ row }) {
  const win = row?.winabilityScore || 0;
  const comp = row?.competitionScore || 0;
  const mat = row?.maturityScore || 0;
  const title = `可赢性 ${win} · 竞争 ${comp}${row?.competitionLabel ? `/${row.competitionLabel}` : ""} · 成熟度 ${mat}${row?.maturityLabel ? `/${row.maturityLabel}` : ""}`;

  if (comp >= 75 || (comp >= 65 && mat >= 60)) {
    return (
      <span className="trend-badge trend-down" title={title}>
        红海
      </span>
    );
  }
  if (win >= 60 && mat < 70 && comp < 70) {
    return (
      <span className="trend-badge trend-up" title={title}>
        可切
      </span>
    );
  }
  if (mat >= 70) {
    return (
      <span className="trend-badge trend-flat" title={title}>
        成型
      </span>
    );
  }
  return (
    <span className="trend-badge trend-flat" title={title}>
      {win || "·"}
    </span>
  );
}

function ResearchLinks({ site, compact = false }) {
  const links = buildResearchLinks(site);

  return (
    <div className={compact ? "research-links compact" : "research-links"}>
      {links.map((link) => (
        <a
          key={link.key}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          title={link.title}
          onClick={(event) => event.stopPropagation()}
        >
          {link.key === "github" ? <Github size={13} /> : null}
          {link.key === "reddit" ? <MessageCircle size={13} /> : null}
          {link.key !== "github" && link.key !== "reddit" ? <Search size={13} /> : null}
          <span>{link.label}</span>
        </a>
      ))}
    </div>
  );
}

function MetricBar({ label, metric, invert = false }) {
  const score = metric?.score ?? 0;
  const className = invert
    ? score >= 60
      ? "metric-fill danger"
      : score >= 30
        ? "metric-fill warn"
        : "metric-fill"
    : score >= 75
      ? "metric-fill"
      : score >= 45
        ? "metric-fill warn"
        : "metric-fill muted";

  return (
    <div className="metric-row">
      <div className="metric-label">
        <span>{label}</span>
        <strong>{score}</strong>
      </div>
      <div className="metric-track">
        <span className={className} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function Inspector({ site, onToggleSaved, onUpdateStage, onUpdateNote }) {
  if (!site) {
    return (
      <aside className="inspector empty-inspector">
        <Terminal size={22} />
        <p>选择一个站点后查看需求假设、SEO 缺口和行动清单。</p>
      </aside>
    );
  }

  const externalSignals = buildExternalSignals(site);

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div>
          <span className="terminal-label">SELECTED TARGET</span>
          <h2>{site.host}</h2>
          <DecisionBadge decision={site.decision} />
        </div>
        <div className="inspector-actions">
          <button
            className={site.watch?.saved ? "icon-action saved" : "icon-action"}
            onClick={() => onToggleSaved(site)}
            title={site.watch?.saved ? "取消收藏" : "收藏"}
          >
            <Star size={15} />
          </button>
          <span className={scoreClass(site.score)}>{site.score}</span>
        </div>
      </div>

      <div className="terminal-block">
        <div className="line">
          <span>keyword</span>
          <strong>{site.keyword || "-"}</strong>
        </div>
        <div className="line">
          <span>title</span>
          <strong>{site.title || site.ogTitle || "-"}</strong>
        </div>
        <div className="line">
          <span>description</span>
          <strong>{site.description || "-"}</strong>
        </div>
      </div>

      <section>
        <h3>机会判断</h3>
        <p className="insight">
          {site.fitReason || "需要结合搜索量、合规风险和页面质量继续判断。"}
          当前关键词入口是「{site.keyword || site.host}」。
        </p>
      </section>

      <section>
        <h3>机会池</h3>
        <div className="watch-panel">
          <label>
            <span>阶段</span>
            <select
              value={site.watch?.stage || "待验证"}
              onChange={(event) => onUpdateStage(site, event.target.value)}
            >
              {STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>备注</span>
            <textarea
              value={site.watch?.note || ""}
              onChange={(event) => onUpdateNote(site, event.target.value)}
              placeholder="记录搜索量、竞品、差异化做法或下一步动作..."
            />
          </label>
        </div>
      </section>

      <section>
        <h3>验证入口</h3>
        <ResearchLinks site={site} />
      </section>

      <section>
        <h3>五维评分</h3>
        <div className="metric-stack">
          <MetricBar label="需求信号" metric={site.scoreBreakdown?.demand} />
          <MetricBar label="SEO 缺口" metric={site.scoreBreakdown?.seoGap} />
          <MetricBar label="可复制性" metric={site.scoreBreakdown?.replicability} />
          <MetricBar label="商业化" metric={site.scoreBreakdown?.commercial} />
          <MetricBar label="外部热度" metric={site.scoreBreakdown?.external} />
          <MetricBar label="新鲜度" metric={site.scoreBreakdown?.freshness} />
          <MetricBar label="扫描动量" metric={site.scoreBreakdown?.momentum} />
          <MetricBar label="可赢性" metric={site.scoreBreakdown?.winability} />
          <MetricBar label="成熟度" metric={site.scoreBreakdown?.maturity} invert />
          <MetricBar label="竞争密度" metric={site.scoreBreakdown?.competition} invert />
          <MetricBar label="风险" metric={site.scoreBreakdown?.risk} invert />
        </div>
      </section>

      <section>
        <h3>竞争与成熟度</h3>
        <div className="terminal-block">
          <div className="line">
            <span>competition</span>
            <strong>
              {site.competitionScore || 0}
              {site.competitionLabel ? ` · ${site.competitionLabel}` : ""}
              {site.competitorCount ? ` · 同类~${site.competitorCount}` : ""}
            </strong>
          </div>
          <div className="line">
            <span>maturity</span>
            <strong>
              {site.maturityScore || 0}
              {site.maturityLabel ? ` · ${site.maturityLabel}` : ""}
              {site.blogLinks ? ` · blog ${site.blogLinks}` : ""}
              {site.toolLinks ? ` · tools ${site.toolLinks}` : ""}
            </strong>
          </div>
          <div className="line">
            <span>winability</span>
            <strong>{site.winabilityScore || 0}</strong>
          </div>
          <div className="line">
            <span>verdict</span>
            <strong>
              {(site.competitionScore || 0) >= 70 && (site.maturityScore || 0) >= 60
                ? "需求可借鉴，不建议正面复刻"
                : (site.winabilityScore || 0) >= 60
                  ? "窗口尚可，适合差异化切入"
                  : "需人工再确认竞争与切口"}
            </strong>
          </div>
        </div>
        {(site.similarTools || []).length ? (
          <div className="tag-list" style={{ marginTop: 8 }}>
            {site.similarTools.slice(0, 4).map((tool) => (
              <span key={tool.url || tool.title}>{tool.title || tool.url}</span>
            ))}
          </div>
        ) : null}
      </section>

      <section>
        <h3>上升信号</h3>
        <div className="terminal-block">
          <div className="line">
            <span>history</span>
            <strong>
              {site.history?.label || "无历史"}
              {typeof site.history?.scoreDelta === "number"
                ? ` · Δscore ${site.history.scoreDelta > 0 ? "+" : ""}${site.history.scoreDelta}`
                : ""}
            </strong>
          </div>
          <div className="line">
            <span>scan 7d / prev</span>
            <strong>
              {site.scanCount7d || 0} / {site.scanCountPrev7d || 0}
            </strong>
          </div>
          <div className="line">
            <span>scan momentum</span>
            <strong>{site.scanMomentum || 0}</strong>
          </div>
          <div className="line">
            <span>rising score</span>
            <strong>{site.history?.risingScore ?? "-"}</strong>
          </div>
        </div>
      </section>

      <section>
        <h3>数据源</h3>
        <div className="tag-list">
          {(site.sources || [site.source]).filter(Boolean).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </section>

      <section>
        <h3>外部热度</h3>
        <div className="tag-list">
          {externalSignals.length
            ? externalSignals.map((item) => <span key={item}>{item}</span>)
            : <span>暂无外部热度信号</span>}
        </div>
      </section>

      <section>
        <h3>分类</h3>
        <div className="tag-list">
          {(site.categoryTags || []).length
            ? site.categoryTags.map((item) => <span key={item}>{item}</span>)
            : <span>未分类</span>}
        </div>
      </section>

      <section>
        <h3>风险</h3>
        <div className="tag-list danger-tags">
          {(site.riskFlags || []).length
            ? site.riskFlags.map((item) => <span key={item}>{item}</span>)
            : <span>未发现高风险信号</span>}
        </div>
      </section>

      <section>
        <h3>SEO 缺口</h3>
        <div className="tag-list warning">
          {(site.weaknesses || []).length
            ? site.weaknesses.map((item) => <span key={item}>{item}</span>)
            : <span>未发现明显缺口</span>}
        </div>
      </section>

      <section>
        <h3>信号</h3>
        <div className="tag-list">
          {(site.signals || []).length
            ? site.signals.map((item) => <span key={item}>{item}</span>)
            : <span>信号不足</span>}
        </div>
      </section>

      <section>
        <h3>下一步</h3>
        <ol className="action-list">
          <li>
            <ChevronRight size={14} />
            查核心词和同义词 SERP
          </li>
          <li>
            <ChevronRight size={14} />
            做一个自有域名版本
          </li>
          <li>
            <ChevronRight size={14} />
            补 title、description、FAQ、结构化数据
          </li>
          <li>
            <ChevronRight size={14} />
            围绕长尾需求生成 5-20 个页面
          </li>
        </ol>
      </section>
    </aside>
  );
}

function MatrixRain() {
  return (
    <div className="matrix-rain" aria-hidden="true">
      {Array.from({ length: 36 }).map((_, index) => (
        <span
          key={index}
          style={{
            left: `${(index * 7.7) % 100}%`,
            animationDelay: `${(index % 11) * -0.7}s`,
            animationDuration: `${7 + (index % 9)}s`
          }}
        >
          010101<br />AI SEO<br />VERCEL<br />QUERY<br />INDEX<br />RANK
        </span>
      ))}
    </div>
  );
}
