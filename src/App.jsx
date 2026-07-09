import { useMemo, useState } from "react";
import {
  Activity,
  ArrowDownUp,
  Binary,
  Bookmark,
  ChevronRight,
  Download,
  Eye,
  Filter,
  Github,
  Globe2,
  Loader2,
  MessageCircle,
  Play,
  Radar,
  Search,
  ShieldAlert,
  Sparkles,
  Star,
  Terminal,
  Zap
} from "lucide-react";
import { analyzeUrls, discoverAll } from "./api";

const SOURCES = [
  { key: "commoncrawl", apiKey: "commoncrawl", label: "Common Crawl", hint: "公开网页索引" },
  { key: "urlscan", apiKey: "urlscan", label: "URLScan", hint: "近期扫描记录" },
  { key: "githubRepos", apiKey: "github-repos", label: "GitHub Repos", hint: "仓库描述/主页" },
  { key: "githubIssues", apiKey: "github-issues", label: "GitHub Issues", hint: "Issue 讨论" },
  { key: "hackernews", apiKey: "hackernews", label: "Hacker News", hint: "HN 提交" },
  { key: "npm", apiKey: "npm", label: "npm", hint: "包描述/主页" },
  { key: "gitlab", apiKey: "gitlab", label: "GitLab", hint: "公开项目" },
  { key: "internetArchive", apiKey: "internet-archive", label: "Internet Archive", hint: "历史网页快照" },
  { key: "certificates", apiKey: "certificates", label: "crt.sh", hint: "证书日志，量大偏旧" }
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
  const [selectedSources, setSelectedSources] = useState({
    commoncrawl: true,
    urlscan: true,
    githubRepos: true,
    githubIssues: true,
    hackernews: true,
    npm: true,
    gitlab: true,
    internetArchive: false,
    certificates: false
  });
  const [manualUrls, setManualUrls] = useState(DEFAULT_MANUAL);
  const [candidatePool, setCandidatePool] = useState([]);
  const [rows, setRows] = useState([]);
  const [selectedHost, setSelectedHost] = useState("");
  const [query, setQuery] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [analyzeLimit, setAnalyzeLimit] = useState(30);
  const [analyzeMode, setAnalyzeMode] = useState("smart");
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [watchlist, setWatchlist] = useState(() => readWatchlist());
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
        if (!needle) return true;
        return `${row.url} ${row.title} ${row.keyword} ${row.description} ${formatSources(row)} ${row.watch?.note || ""}`
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => b.score - a.score);
  }, [enrichedRows, query, minScore, showSavedOnly, decisionFilter]);

  const stats = useMemo(() => {
    const hot = enrichedRows.filter((row) => row.decision === "值得").length;
    const watch = enrichedRows.filter((row) => row.decision === "观察").length;
    const reachable = enrichedRows.filter((row) => row.ok).length;
    const multi = enrichedRows.filter((row) => (row.sources || []).length >= 2).length;
    const saved = Object.values(watchlist).filter((entry) => entry?.saved).length;
    return {
      total: enrichedRows.length,
      pool: candidatePool.length,
      hot,
      watch,
      reachable,
      multi,
      saved
    };
  }, [enrichedRows, watchlist, candidatePool.length]);

  const reportRows = useMemo(() => {
    const savedRows = enrichedRows.filter((row) => row.watch?.saved);
    return savedRows.length ? savedRows : filteredRows;
  }, [enrichedRows, filteredRows]);

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

  async function analyzeBatch(candidates, { excludedHosts = [], reason = "discover" } = {}) {
    const batchSize = Math.min(candidates.length, analyzeLimit);
    const modeLabel =
      reason === "reshuffle"
        ? "换一批"
        : analyzeMode === "smart"
          ? "智能优先"
          : "随机抽样";

    setRows([]);
    setSelectedHost("");
    setStatus(`候选池 ${candidates.length} 个，${modeLabel}深度分析 ${batchSize} 个...`);

    const analyzed = await analyzeUrls({
      urls: candidates,
      limit: batchSize,
      source: "Discovery",
      mode: analyzeMode,
      excludedHosts
    });

    const sorted = (analyzed.items || []).sort((a, b) => b.score - a.score);
    setRows(sorted);
    setSelectedHost(sorted[0]?.host || "");
    setStatus(
      `完成：候选池 ${candidates.length} 个，已${modeLabel}分析 ${sorted.length} 个（池内 ${analyzed.poolSize || candidates.length}），按机会分排序。`
    );
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
            并行发现多源候选，按域名合并后智能优先分析。综合需求、SEO 缺口、可复制性、商业化、外部热度、新鲜度与风险，输出值得 / 观察 / 放弃。
          </p>
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
          <Kpi icon={<Eye size={18} />} label="观察中" value={stats.watch} />
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
                    <th>Source</th>
                    <th>Title</th>
                    <th>Keyword</th>
                    <th>Flags</th>
                    <th>Signals</th>
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
                      <td className="truncate">
                        {(row.signals || []).slice(0, 2).join(" / ") || "-"}
                      </td>
                      <td>{formatDate(row.lastSeen || row.discoveredAt)}</td>
                    </tr>
                  ))}
                  {!filteredRows.length ? (
                    <tr>
                      <td colSpan="9" className="empty-state">
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
          <MetricBar label="风险" metric={site.scoreBreakdown?.risk} invert />
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
