# GitHub-backed PV Counter

一个面向低流量网站的跨域 PV 计数服务：静态 `counter.js` 负责上报，Express 应用部署为 Vercel Function，计数数据以 JSON 文件直接提交到独立的 GitHub 公开仓库。

> GitHub 不是数据库。每次 `/hit` 都会产生一次 commit；GitHub 官方建议单仓库最多约 6 次 push/分钟。因此本项目适合个人站、作品集、低流量演示，不适合高并发或严格实时统计。

## 架构

```text
访问者页面
  └─ counter.js
       ├─ POST /hit ── Vercel Function ── GitHub Contents API ── 数据仓库
       └─ GET  /stats ─ Vercel Function ── GitHub Contents API ── 数据仓库
```

推荐使用两个公开仓库：

- `github-backed-pv-counter`：代码仓库，只连接 Vercel。
- `github-backed-pv-counter-data`：数据仓库，只保存 `data/domains/<domain>.json`。

这样数据 commit 不会触发 Vercel 重新部署，细粒度 GitHub Token 也只需要写入数据仓库。

## 功能

- 保持 `/hit` 查询参数、`/stats` 和 `counter.js` 的旧数据格式兼容；写入默认改为 `POST`。
- 按域名统计 PV，也可按同域项目分别统计。
- 每个域名使用一个 JSON 文件，降低不同域名之间的写入冲突。
- 使用 GitHub 文件 SHA 做乐观并发控制；遇到 `409` 或创建竞态时重新读取并重试。
- 使用精确域名白名单，并完全不持久化 IP，避免向公开 Git 历史写入隐私数据。
- 每实例默认最多接受 5 次写入/分钟，并限制每个域名最多 100 个项目键。
- `/stats` 使用 10 秒存储缓存和 Vercel CDN 缓存，减少 GitHub API 调用。
- GitHub Token 只在 Vercel Function 中读取，不进入浏览器代码。

## 数据格式

数据仓库中的文件路径示例：

```text
data/domains/ai.bornforthis.cn.json
```

```json
{
  "version": 2,
  "domain": "ai.bornforthis.cn",
  "total": 12,
  "last": 1785628800000,
  "ips": {},
  "projects": {
    "readygodule": {
      "total": 5,
      "last": 1785628800000,
      "ips": {}
    }
  }
}
```

`ips` 字段只为旧响应结构兼容而保留，服务始终写入空对象。删除当前版本中的数据不会自动清除 Git 历史，因此不要写入密码、Token、IP 或其他隐私信息。

## Vercel 配置

在 Vercel 项目中配置以下环境变量：

| 环境变量 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- |
| `COUNTER_GITHUB_TOKEN` | 是 | `github_pat_...` | 仅授权数据仓库 `Contents: Read and write` 的细粒度 Token |
| `COUNTER_GITHUB_REPOSITORY` | 是 | `AndersonHJB/github-backed-pv-counter-data` | 数据仓库，格式为 `owner/repository` |
| `COUNTER_GITHUB_BRANCH` | 否 | `main` | 数据分支，默认 `main` |
| `COUNTER_GITHUB_DATA_DIRECTORY` | 否 | `data/domains` | 数据文件目录 |
| `COUNTER_GITHUB_API_VERSION` | 否 | `2022-11-28` | GitHub REST API 版本 |

`COUNTER_GITHUB_TOKEN` 应在 Vercel 中标记为 Sensitive。不要使用 `NEXT_PUBLIC_*`、`VITE_*` 或任何会进入前端 bundle 的变量名。

部署步骤：

1. 把代码仓库导入 Vercel。
2. 创建只允许访问数据仓库的 GitHub fine-grained personal access token，并授予 `Contents: Read and write`。
3. 只在 Vercel Production 环境中添加生产数据仓库变量。
4. 重新部署。

默认不要把生产 `COUNTER_GITHUB_TOKEN` 暴露给 Preview 部署，因为预览分支代码会在该环境中运行。如果确实需要可写预览，请使用独立的 Preview 数据仓库和独立 Token。

## 本地开发

本地调试可以使用非持久化内存存储，不会调用真实 GitHub：

```bash
npm ci
COUNTER_STORAGE=memory COUNTER_ALLOW_ALL=true npm start
```

默认地址为 `http://127.0.0.1:8787`。

使用真实 GitHub 数据仓库时，将 `.env.example` 中的变量配置到 shell 或本地 `.env` 加载工具中。`.env` 已被 Git 忽略。

## 前端接入

### 整个域名

```html
<span id="pv">-</span>
<script
  src="https://your-counter.vercel.app/counter.js"
  data-domain="ai.bornforthis.cn"
  data-target="#pv"
  data-prefix="PV: "
></script>
```

### 同域项目

```html
<script
  src="https://your-counter.vercel.app/counter.js"
  data-domain="ai.bornforthis.cn"
  data-project="readygodule"
  data-target="#pv"
></script>
```

`data-project="auto"` 会取当前 URL 路径的第一段作为项目名。

脚本继续提供：

- `BFTCounter.hit()`：主动上报。
- `BFTCounter.get()`：读取统计。
- `BFTCounter.on(fn)`：订阅更新。
- `BFTCounter.peek()`：读取最近一次结果。

## API

```text
POST     /hit?d=<domain>&p=<optional-project>
GET      /stats?d=<domain>&p=<optional-project>
GET      /stats?d=<domain>&includeProjects=1
GET      /stats?d=<domain>&includeIps=1
```

- 普通 `/hit` 成功返回 `204`。
- `/hit?...&debug=1` 成功返回 JSON。
- 默认的 `GET /hit` 返回 `405`；只有明确设置 `COUNTER_ALLOW_GET_HITS=true` 才会兼容旧式 GET 写入。
- 超过本实例写入上限时返回 `429` 和 `Retry-After`。
- GitHub 写入失败时返回稳定的 `503`，不会误报成功。
- `/stats` 对尚不存在的域名返回 `total: 0`。
- `includeIps=1` 为兼容保留，但始终返回空对象。

## 安全配置

`config.json` 默认：

```json
{
  "allowAll": false,
  "allowGetHits": false,
  "allowedDomains": [
    "bornforthis.cn",
    "ai.bornforthis.cn",
    "counter.bornforthis.cn",
    "aistudio.google.com",
    "gemini.google.com"
  ],
  "allowedRootDomains": [],
  "rateLimitMax": 5,
  "rateLimitWindowMs": 60000,
  "statsRateLimitMax": 60,
  "statsCacheTtlMs": 10000,
  "maxProjectsPerDomain": 100
}
```

建议保持 `allowAll: false`，优先把完整域名加入 `allowedDomains`；只有确实需要任意子域时才使用 `allowedRootDomains`。公开 `/hit` 无法证明访问真实性，计数不具备防刷或计费级可信度。

可以用环境变量临时覆盖：

- `COUNTER_ALLOW_ALL`
- `COUNTER_ALLOW_GET_HITS`
- `COUNTER_RATE_LIMIT_MAX`
- `COUNTER_RATE_LIMIT_WINDOW_MS`
- `COUNTER_STATS_RATE_LIMIT_MAX`
- `COUNTER_STATS_CACHE_TTL_MS`
- `COUNTER_MAX_PROJECTS_PER_DOMAIN`

函数内限流和内存缓存只约束单个 Vercel 实例，不能抵挡分布式请求或多实例扩容。生产环境还应在 Vercel Firewall 中同时为 `POST /hit` 和 `GET /stats` 配置全局速率限制；若需要可靠、高流量或防刷统计，应改用真正的数据库/队列方案。

## 测试

```bash
npm test
```

测试使用内存存储和模拟 GitHub API，不会访问或修改真实仓库。手动端到端回归：

```bash
COUNTER_STORAGE=memory COUNTER_ALLOW_ALL=true npm start
npm run test:regression -- --base http://127.0.0.1:8787 --domain localhost
```

## 旧数据迁移

旧仓库中的 `counts.txt` 没有被原 `server.js` 实际读取。本项目已将其中的 `counter.bornforthis.cn` 总数转换为单域名 JSON，并迁移到配套的 `github-backed-pv-counter-data` 数据仓库。

## 相关文档

- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents)
- [GitHub repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- [Vercel Express deployments](https://vercel.com/docs/frameworks/backend/express)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)

## License

ISC
