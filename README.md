# Vercel Opportunity Finder

一个网页小工具，用来发现和分析 `*.vercel.app` 子域名里的需求机会。支持本地运行，也支持使用 GitHub Pages 托管前端、Cloudflare Worker 托管 API。

## 适合什么场景

很多 Vercel 项目会直接使用 `*.vercel.app` 子域名对外传播。这个工具用公开数据源批量发现这些站点，自动抓取首页元信息，判断它们解决的需求、SEO 缺口、可复制性和风险，帮助筛出可以进一步验证和复刻优化的机会。

## 能做什么

- 从 Common Crawl、URLScan、GitHub、Hacker News、npm、GitLab 等公开数据源拉取 `vercel.app` 候选站。
- 可选启用 Internet Archive 和 crt.sh，补充历史快照与证书透明日志里的候选域名。
- 支持手动粘贴一批 URL。
- 自动抓取首页 title、description、H1、canonical、robots。
- 根据需求词、收录信号、SEO 缺口、是否仍使用 `vercel.app` 做机会评分。
- 结合 GitHub stars/forks/issues、HN points/comments、npm downloads 等外部热度信号辅助判断。
- 输出多维判断：需求信号、SEO 缺口、可复制性、商业化潜力、外部热度、合规/仿站风险。
- 自动给出 `值得 / 观察 / 放弃` 结论，并标记仿站、登录页、成人内容、作品集、工具站等类型。
- 为每个关键词生成验证入口：Google、Google Trends、GitHub、Reddit、Product Hunt。
- 支持收藏机会、填写阶段和备注，并保存到浏览器本地。
- 支持筛选、导出 CSV、导出 Markdown 机会池报告。
- 默认是快速模式：先发现候选，再深度分析前 30 个，避免大量外站超时导致页面像卡死。
- **并行发现**：多数据源同时拉取，不再串行等待。
- **多源合并**：同一域名跨源命中会合并 stars / HN / npm 等信号，并标记「多源交叉」。
- **智能优先分析**：优先分析有需求词、热度、近期活跃、多源命中的候选（也可切回随机）。
- **新鲜度维度**：结合 lastSeen 判断近 7/30 日活跃，帮助捕捉上升中的词。
- **结论筛选**：表格可按 值得 / 观察 / 放弃 过滤。
- **扫描动量（上升代理）**：用 URLScan 近 7 日 vs 前 7 日扫描次数估计「注意力是否在涨」。
- **历史机会池**：每次分析写入 `data/snapshots/`，并做日环比（上升 / 新出现 / 回落）。
- **更多数据源**：Reddit、Bluesky、Product Hunt（公开搜索 best-effort）、Stack Overflow。
- **CLI 日扫**：`npm run scan` / `npm run scan:cron`，输出 Markdown 上升日报到 `reports/`。
- **上升榜操作**：侧边栏复扫上升 host、点击历史快照复扫、导出上升报告。
- **本地日环比兜底**：即使 Worker 无磁盘历史，浏览器 localStorage 也会做环比。
- **竞争密度**：关键词启发式 + DuckDuckGo 同类结果，识别红海词（如 youtube playlist length）。
- **成熟度降权**：博客/多工具/FAQ/长内容等信号，避免把已成型产品标成「值得」。
- **可赢性**：综合 SEO 缺口、成熟度、竞争，过滤「需求真但别做」的误判。

## 技术栈

- React + Vite
- Express 本地 API 代理
- Cloudflare Worker 线上 API
- Cheerio 解析页面元信息
- Common Crawl Index API
- URLScan Search API
- GitHub Search API
- Hacker News Algolia API
- npm Registry Search API
- GitLab Projects API
- 本地 `localStorage` 保存收藏、阶段和备注

## 本地运行

```bash
npm install
npm run dev
```

### CLI 定时找词（推荐每天跑）

先开 API，或用 `--start-api` 自动拉起：

```bash
# 终端 A
npm run dev:api

# 终端 B
npm run scan

# 或一条命令（自动起 API）
npm run scan:cron -- --limit 40 --analyze 25
```

可选参数：

```bash
npm run scan -- \
  --sources urlscan,reddit,bluesky,github-repos,hackernews \
  --analyze 30 \
  --out reports/my-daily.md \
  --json-out reports/my-daily.json
```

macOS `launchd` / Linux `cron` 示例（每天 9:00）：

```cron
0 9 * * * cd /path/to/vercel-opportunity-finder && /usr/local/bin/npm run scan:cron >> /tmp/vof-scan.log 2>&1
```

打开 Vite 输出的本地地址，通常是：

```bash
http://127.0.0.1:5173/
```

API 默认运行在：

```bash
http://127.0.0.1:4174/
```

可选：设置 `GITHUB_TOKEN`（或 `GH_TOKEN`）提高 GitHub Search API 限额：

```bash
export GITHUB_TOKEN=ghp_xxx
npm run dev
```

## 优化后的常用流程

1. 勾选数据源，设置「发现量」和「分析量」。
2. 抽样模式选 **智能优先**（默认），点「开始发现」。
3. 系统并行拉取各源 → 按 host 合并 → 优先分析高信号候选。
4. 用「结论」筛选只看 **值得**，再点验证入口（Google / Trends / GitHub / Reddit / PH）。
5. 对有价值的站收藏、改阶段、写备注；不够时点「换一批」。
6. 导出 CSV 或 Markdown 机会池报告。

## GitHub Pages + Cloudflare Worker 部署

推荐线上部署拆成两部分：

- GitHub Pages：托管 `dist/` 静态前端。
- Cloudflare Worker：提供 `/api/health`、`/api/discover/*`、`/api/analyze`。

### 1. 部署 Worker API

先登录 Cloudflare：

```bash
npx wrangler login
```

本地调试 Worker：

```bash
npm run worker:dev
```

部署 Worker：

```bash
npm run worker:deploy
```

部署完成后记录 Worker 地址，例如：

```bash
https://vercel-opportunity-finder-api.<your-subdomain>.workers.dev
```

### 2. 配置 GitHub Pages

在 GitHub 仓库里进入：

```text
Settings -> Pages -> Build and deployment -> Source -> GitHub Actions
```

然后在仓库 Secrets 中添加：

```text
VITE_API_BASE_URL=https://vercel-opportunity-finder-api.<your-subdomain>.workers.dev
```

推送到 `main` 后，`.github/workflows/pages.yml` 会自动执行：

```bash
npm ci
npm run build:pages
```

构建时前端会把 API 请求指向 `VITE_API_BASE_URL`。如果没有配置该变量，前端会继续请求同源 `/api/*`，适合本地 Express 开发。

Workflow 会自动把 Vite `base` 设置成 `/<repo>/`，适配 GitHub Pages 项目站路径。

### 3. 本地模拟 Pages 构建

```bash
VITE_BASE_PATH=/vercel-opportunity-finder/ VITE_API_BASE_URL=http://127.0.0.1:8788 npm run build:pages
```

## 常用流程

1. 点击「开始发现」。
2. 查看 `值得 / 观察 / 放弃` 结论和五维评分。
3. 点右侧「验证入口」去 Google、Trends、GitHub、Reddit、Product Hunt 验证需求。
4. 对有价值的站点点星标收藏。
5. 设置阶段，填写备注。
6. 用「只看收藏」复盘机会池。
7. 导出 CSV 或 Markdown 报告。

## 数据源说明

- Common Crawl：公开网页索引，适合批量发现已经被抓取的项目。
- URLScan：公开扫描记录，适合发现最近被提交或扫描过的项目。
- GitHub Repos：公开仓库描述、homepage 和仓库元信息里的站点。
- GitHub Issues：公开 issue 标题和正文里提到的站点。
- Hacker News：HN 提交记录里的站点。
- npm：包描述、homepage 和 repository 字段里的站点。
- GitLab：公开项目描述和项目元信息里的站点。
- Internet Archive：历史网页快照，默认关闭，适合补充旧站点。
- crt.sh：证书透明日志，默认关闭，量大但偏旧，公共服务也更容易超时。
- Manual URLs：适合把 SEO 工具、社媒、GitHub 搜到的域名粘进来统一分析。

## 评分说明

工具会综合以下维度生成机会分和结论：

- 需求信号：是否像工具站、查询站、生成器、计算器、颜色/游戏等明确需求。
- SEO 缺口：是否缺少 title、description、H1、canonical 等基础 SEO。
- 可复制性：是否适合做一个更完整的自有域名版本。
- 商业化潜力：是否包含模板、PDF、YouTube、AI、设计、视频等可变现关键词。
- 外部热度：是否有 GitHub stars/forks/issues、HN points/comments、npm downloads 等公开热度。
- 新鲜度：lastSeen / 快照时间是否集中在近 7–30 日（上升/新鲜信号）。
- 多源交叉：同一 host 被多个公开索引同时提到时加分。
- 风险：是否疑似品牌仿站、登录/账号页、成人内容或其他不适合复刻的页面。
- 已有正式产品：如果 `*.vercel.app` 子域已跳转到同品牌自有域名，或页面 `canonical` / `og:url` 指向同品牌正式站，会标记为已有正式产品并降权。

## API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/discover/*` | 单源发现（兼容旧调用） |
| POST | `/api/discover` | 并行多源发现 `body: { suffix, limit, sources[] }` |
| POST | `/api/analyze` | 深度分析 + 扫描动量 + 自动存历史 |
| GET | `/api/history` | 快照列表 |
| GET | `/api/history/rising` | 日环比上升 host |
| GET | `/api/history/compare` | 对比最近两次扫描 |
| GET | `/api/history/:id` | 读取快照 |
| POST | `/api/history/save` | 手动保存一批结果 |

### 历史与上升信号说明

- **不是真实流量**，而是公开代理信号：
  - URLScan 扫描频次（近 7 日 / 前 7 日）
  - 机会分、多源命中数的日环比
- 本地运行会把快照写到 `data/snapshots/`（已 gitignore）。
- Cloudflare Worker **不持久化**历史；前端会额外写入 `localStorage` 作备份。
- Product Hunt 使用公开 Algolia 搜索，密钥若轮换会失败（默认关闭该源）。

### 竞争 / 成熟度 / 可赢性

| 维度 | 含义 | 高分意味着 |
|------|------|------------|
| 竞争密度 | 关键词是否红海 | 后发难做，倾向观察/放弃 |
| 成熟度 | 对方是否已运营成型 | 不宜 1:1 复刻 |
| 可赢性 | 是否还有切入窗口 | 高才配「值得」 |

**「值得」门槛（简化）：** 需求够 + 可赢性够 + 竞争不太高 + 成熟度不太高 + 风险可控。  
像 `ytp-length` 这类「需求真、页面完整、词很卷」会被标成 **观察/放弃**，并提示「借鉴需求，不正面复刻」。

## 注意

这个工具只分析公开网页和公开索引，不绕过权限、不抓取私有数据。评分是机会初筛，不等于真实流量，需要再结合关键词工具、SERP 和社媒讨论验证。

不要把明显涉及钓鱼、仿站、侵权、成人内容或账号登录的站点当作可复刻机会。
