#!/usr/bin/env node
/**
 * Headless daily scan for cron / launchd.
 *
 * Examples:
 *   npm run scan
 *   npm run scan -- --limit 40 --analyze 25 --sources urlscan,reddit,github-repos
 *   npm run scan -- --no-momentum --out reports/daily.md
 *
 * Env:
 *   PORT / API_BASE   default http://127.0.0.1:4174
 *   GITHUB_TOKEN      optional
 *   SCAN_SUFFIX       default vercel.app
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = {
    limit: 40,
    analyze: 25,
    suffix: process.env.SCAN_SUFFIX || "vercel.app",
    sources: [
      "commoncrawl",
      "urlscan",
      "github-repos",
      "hackernews",
      "reddit",
      "npm"
    ],
    momentum: true,
    history: true,
    mode: "smart",
    out: "",
    api: process.env.API_BASE || `http://127.0.0.1:${process.env.PORT || 4174}`,
    startApi: false,
    jsonOut: ""
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--limit") {
      args.limit = Number(next);
      i += 1;
    } else if (token === "--analyze") {
      args.analyze = Number(next);
      i += 1;
    } else if (token === "--suffix") {
      args.suffix = next;
      i += 1;
    } else if (token === "--sources") {
      args.sources = String(next)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === "--mode") {
      args.mode = next === "random" ? "random" : "smart";
      i += 1;
    } else if (token === "--out") {
      args.out = next;
      i += 1;
    } else if (token === "--json-out") {
      args.jsonOut = next;
      i += 1;
    } else if (token === "--api") {
      args.api = next.replace(/\/$/, "");
      i += 1;
    } else if (token === "--no-momentum") {
      args.momentum = false;
    } else if (token === "--no-history") {
      args.history = false;
    } else if (token === "--start-api") {
      args.startApi = true;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    }
  }

  return args;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(api, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${api}/api/health`);
      if (response.ok) return true;
    } catch {
      // retry
    }
    await sleep(250);
  }
  return false;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status} ${url}`);
  }
  return payload;
}

function buildRisingReport({ suffix, items, rising, snapshot, discovered }) {
  const date = new Date().toISOString().slice(0, 10);
  const risingHosts = new Set((rising || []).map((row) => row.host));
  const ranked = [...(items || [])].sort((a, b) => {
    const ar = a.history?.risingScore || a.scanMomentum || 0;
    const br = b.history?.risingScore || b.scanMomentum || 0;
    if (br !== ar) return br - ar;
    return (b.score || 0) - (a.score || 0);
  });

  const lines = [
    `# Vercel 找词日报 ${date}`,
    "",
    `- 后缀：\`${suffix}\``,
    `- 发现候选：${discovered}`,
    `- 深度分析：${ranked.length}`,
    `- 快照：${snapshot?.id || "未保存"}`,
    `- 上升/新出现：${risingHosts.size || ranked.filter((r) => r.history?.label === "上升" || r.history?.isNew).length}`,
    "",
    "## 上升榜",
    ""
  ];

  const topRising = ranked
    .filter(
      (row) =>
        row.history?.label === "上升" ||
        row.history?.isNew ||
        (row.scanMomentum || 0) >= 40 ||
        risingHosts.has(row.host)
    )
    .slice(0, 20);

  if (!topRising.length) {
    lines.push("_本次无显著上升信号（可能是首日快照，或动量较弱）。_");
    lines.push("");
  } else {
    topRising.forEach((row, index) => {
      lines.push(`### ${index + 1}. ${row.host}`);
      lines.push("");
      lines.push(`- 结论：${row.decision || "观察"}`);
      lines.push(`- 机会分：${row.score}`);
      lines.push(`- 趋势：${row.history?.label || "-"} (rising ${row.history?.risingScore ?? "-"})`);
      lines.push(`- 扫描动量：${row.scanMomentum || 0} · 7d ${row.scanCount7d || 0} / prev ${row.scanCountPrev7d || 0}`);
      lines.push(`- 关键词：${row.keyword || "-"}`);
      lines.push(`- 标题：${row.title || row.ogTitle || "-"}`);
      lines.push(`- URL：${row.url}`);
      lines.push(`- 来源：${(row.sources || [row.source]).filter(Boolean).join(" + ")}`);
      lines.push(`- 分类：${(row.categoryTags || []).join(" / ") || "-"}`);
      lines.push(`- 风险：${(row.riskFlags || []).join(" / ") || "无明显风险"}`);
      lines.push("");
    });
  }

  lines.push("## 全量分析 Top 15");
  lines.push("");
  ranked.slice(0, 15).forEach((row, index) => {
    lines.push(
      `${index + 1}. **${row.host}** · ${row.score} · ${row.decision || "观察"} · ${row.keyword || "-"}`
    );
  });
  lines.push("");
  lines.push("---");
  lines.push("_Generated by vercel-opportunity-finder `npm run scan`_");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Usage: npm run scan -- [options]

Options:
  --limit N          discovery per source (default 40)
  --analyze N        deep analyze count (default 25)
  --suffix DOMAIN    default vercel.app
  --sources a,b,c    discovery sources
  --mode smart|random
  --out path.md      write markdown report
  --json-out path.json
  --api URL          API base (default http://127.0.0.1:4174)
  --start-api        spawn local API if health check fails
  --no-momentum
  --no-history
`);
    process.exit(0);
  }

  let child = null;

  try {
    let healthy = await waitForHealth(args.api, 4);
    if (!healthy && args.startApi) {
      console.log(`[scan] starting local API...`);
      child = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      healthy = await waitForHealth(args.api, 40);
    }

    if (!healthy) {
      throw new Error(
        `API not reachable at ${args.api}. Run \`npm run dev:api\` or pass --start-api`
      );
    }

    console.log(`[scan] discover suffix=${args.suffix} sources=${args.sources.join(",")}`);
    const discovered = await postJson(`${args.api}/api/discover`, {
      suffix: args.suffix,
      limit: args.limit,
      sources: args.sources
    });

    const candidates = discovered.items || [];
    console.log(
      `[scan] candidates=${candidates.length} sourceErrors=${(discovered.errors || []).length}`
    );

    if (!candidates.length) {
      throw new Error("No candidates discovered");
    }

    console.log(
      `[scan] analyze count=${Math.min(args.analyze, candidates.length)} momentum=${args.momentum}`
    );
    const analyzed = await postJson(`${args.api}/api/analyze`, {
      urls: candidates,
      limit: args.analyze,
      source: "CLI",
      mode: args.mode,
      suffix: args.suffix,
      enrichMomentum: args.momentum,
      saveHistory: args.history
    });

    const items = analyzed.items || [];
    const rising = analyzed.rising || [];
    const report = buildRisingReport({
      suffix: args.suffix,
      items,
      rising,
      snapshot: analyzed.snapshot,
      discovered: candidates.length
    });

    const defaultOut = path.join(
      ROOT,
      "reports",
      `scan-${new Date().toISOString().slice(0, 10)}.md`
    );
    const outPath = path.resolve(args.out || defaultOut);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, report, "utf8");
    console.log(`[scan] report -> ${outPath}`);

    if (args.jsonOut) {
      const jsonPath = path.resolve(args.jsonOut);
      await fs.mkdir(path.dirname(jsonPath), { recursive: true });
      await fs.writeFile(
        jsonPath,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            suffix: args.suffix,
            discovered: candidates.length,
            snapshot: analyzed.snapshot,
            rising,
            items
          },
          null,
          2
        ),
        "utf8"
      );
      console.log(`[scan] json -> ${jsonPath}`);
    }

    const worth = items.filter((item) => item.decision === "值得").length;
    const risingCount = items.filter(
      (item) => item.history?.label === "上升" || item.history?.isNew || (item.scanMomentum || 0) >= 40
    ).length;
    console.log(
      `[scan] done analyzed=${items.length} worth=${worth} rising=${risingCount} snapshot=${analyzed.snapshot?.id || "-"}`
    );
  } finally {
    if (child) {
      child.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  console.error(`[scan] failed: ${error.message}`);
  process.exit(1);
});
