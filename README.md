# GitHub-backed PV Counter

一个兼容原 `domain-visit-counter` 调用方式的低流量 PV/UV 计数服务：浏览器加载静态 `counter.js`，Express 应用运行在 Vercel Function 中，计数通过 GitHub Contents API 写入独立的公开数据仓库。

> GitHub 不是数据库。每次 `/hit` 都会产生一次 commit；GitHub 官方建议单仓库最多约 6 次 push/分钟。本项目适合个人站、作品集和低流量演示，不适合高并发、严格实时或计费级统计。

## 仓库结构

- [`github-backed-pv-counter`](https://github.com/AndersonHJB/github-backed-pv-counter)：代码仓库，只连接 Vercel。
- [`github-backed-pv-counter-data`](https://github.com/AndersonHJB/github-backed-pv-counter-data)：数据仓库，只保存 `data/domains/<domain>.json`。

数据 commit 不会触发 Vercel 重新部署，细粒度 GitHub Token 也只需拥有数据仓库的 `Contents: Read and write` 权限。

```text
访问者页面
  └─ counter.js
       ├─ GET/POST /hit ─ Vercel Function ─ GitHub Contents API ─ 数据仓库
       └─ GET /stats ──── Vercel Function ─ GitHub Contents API ─ 数据仓库
```

## 原项目兼容性

以下旧调用无需修改：

```html
<script
  src="https://counter.bornforthis.cn/counter.js"
  data-domain="ai.bornforthis.cn"
></script>
```

但要让这个 URL 真正切换到新服务，必须把 `counter.bornforthis.cn` 绑定到新的 Vercel 项目。只部署一个新的 `vercel.app` URL 并不能接管已上线页面。

| 原功能 | 当前支持情况 |
| --- | --- |
| `GET /hit`、`POST /hit` | 均支持，普通成功仍返回 `204` |
| domain 总 PV | 支持 |
| 同域 project PV，且计入 domain 总数 | 支持 |
| `debug=1` | 保留旧字段，并新增已提交的 `total`、`last` |
| `includeProjects=1` | 支持 |
| `includeIps=1` 与 UV/IP 频次 | 支持 `hash`、`anonymized`、`raw`、`none` 四种模式；`raw` 读取需要鉴权 |
| `data-domain`、`data-project`、`auto` | 支持 |
| `data-target`、`data-prefix`、`data-poll` | 支持 |
| `BFTCounter.hit/get/on/peek` | 支持；`hit()` 仍为无返回值的容错式上报 |
| `bftcounter:update` DOM 事件 | 支持 |
| `/counter.js`、`/public/counter.js` | 两条旧路径均支持 |
| CORS 与 `OPTIONS` | 支持 |

新增的 `BFTCounter.hitAsync()` 会等待 GitHub commit，并返回已提交计数。旧页面继续使用 `hit()` 即可。

存储架构本身仍有无法消除的差异：GitHub 写入速度有限，默认每个 Vercel 实例只接受 5 次 hit/分钟；写入失败时会返回 `429`、`422` 或 `503`，不会像旧实现那样在落盘失败前提前报告成功。若现有流量超过这个范围，应改用数据库或队列，不能依赖 GitHub 文件充当高频数据库。

## 数据格式

每个域名单独保存：

```text
data/domains/ai.bornforthis.cn.json
```

```json
{
  "version": 2,
  "domain": "ai.bornforthis.cn",
  "total": 12,
  "last": 1785628800000,
  "ips": {
    "h:example-hmac-visitor-id": {
      "count": 2,
      "first": 1785628700000,
      "last": 1785628800000
    }
  },
  "projects": {
    "readygoduel": {
      "total": 5,
      "last": 1785628800000,
      "ips": {}
    }
  }
}
```

默认 `ipMode=hash`：服务使用 HMAC-SHA256 生成稳定访客标识，公开仓库中不会出现原始 IP。必须单独设置至少 32 字节的 `COUNTER_IP_HASH_SECRET`；密钥缺失或过短时只继续记录 PV，不记录新的访客标识。哈希输入包含 domain，同一 IP 在不同域名下不会产生相同标识，也不会回退使用 GitHub Token。

其他模式：

- `anonymized`：IPv4 保存为 `/24`，IPv6 保存为 `/64`。
- `raw`：恢复原始 IP 记录语义，必须同时设置 `COUNTER_ALLOW_RAW_IPS=true`；`includeIps=1` 还需提交 `COUNTER_IP_STATS_TOKEN`。它只能用于私有数据仓库，不得用于本项目的公开数据仓库。
- `none`：不记录访客标识，`includeIps=1` 返回空对象。

默认最多保存 2,000 个 domain/project visitor map 条目；达到上限后 PV 仍会继续累加，只是不再分配新的访客标识，避免单个 JSON 文件因持续增长而停止计数。

删除最新版本中的数据不会清除 Git 历史，严禁把 Token、密码或原始 IP 提交到公开仓库。

## Vercel 配置

项目使用 Node.js 24。在 Vercel Production 环境中设置：

| 环境变量 | 必填 | 默认/示例 | 说明 |
| --- | --- | --- | --- |
| `COUNTER_GITHUB_TOKEN` | 是 | `github_pat_...` | 仅授权数据仓库 `Contents: Read and write` 的细粒度 Token |
| `COUNTER_GITHUB_REPOSITORY` | 是 | `AndersonHJB/github-backed-pv-counter-data` | 数据仓库，格式为 `owner/repository` |
| `COUNTER_GITHUB_BRANCH` | 否 | `main` | 数据分支 |
| `COUNTER_GITHUB_DATA_DIRECTORY` | 否 | `data/domains` | 数据目录 |
| `COUNTER_GITHUB_TIMEOUT_MS` | 否 | `8000` | GitHub 请求超时，`0` 表示禁用内部超时 |
| `COUNTER_GITHUB_MAX_FILE_BYTES` | 否 | `524288` | 单域名 JSON 文件上限 |
| `COUNTER_IP_HASH_SECRET` | `hash` 模式必填 | 至少 32 字节随机字符串 | 独立 HMAC 访客标识密钥；不得复用 GitHub Token |
| `COUNTER_IP_MODE` | 否 | `hash` | `hash/anonymized/raw/none` |
| `COUNTER_ALLOW_RAW_IPS` | 否 | `false` | 原始 IP 存储的显式开关；公开数据仓库必须保持关闭 |
| `COUNTER_IP_STATS_TOKEN` | `raw` 模式必填 | 至少 32 字节随机字符串 | 读取原始 IP 统计时使用的 Bearer/Header Token |
| `COUNTER_MAX_VISITOR_KEYS_PER_DOMAIN` | 否 | `2000` | 每个域名文件的 visitor map 条目上限；`0` 表示不限制 |

部署流程：

1. 把代码仓库导入 Vercel，但暂时不要绑定 `counter.bornforthis.cn`。
2. 创建只允许访问数据仓库的 fine-grained PAT。
3. 生成并安全保存独立访客哈希密钥，例如 `openssl rand -hex 32`。
4. 只在 Vercel Production 环境添加正式密钥、Token 和数据仓库变量。
5. 先部署并使用临时 Vercel URL、临时加入 allowlist 的一次性测试 domain 验证读写，再删除测试 JSON 和临时白名单。
6. 完成下方“旧数据迁移”与核对后，最后绑定自定义域名并切换流量。

不要把正式写入 Token 默认暴露给 Preview 部署。若需要可写预览，请使用独立数据仓库和独立 Token。

## 本地开发

```bash
npm ci
COUNTER_STORAGE=memory COUNTER_ALLOW_ALL=true npm start
```

默认地址为 `http://127.0.0.1:8787`；可使用 `PORT=9000 npm start` 修改端口。内存模式会在进程退出后清空数据。使用真实 GitHub 仓库时，需要配置 `.env.example` 中的变量；项目不会再自动创建本地 `data.json`。

## 前端接入

### 域名与项目

```html
<span id="pv">-</span>
<script
  src="https://counter.bornforthis.cn/counter.js"
  data-domain="ai.bornforthis.cn"
  data-project="readygoduel"
  data-target="#pv"
  data-prefix="PV: "
  data-poll="5000"
></script>
```

- 不写 `data-domain` 时使用 `location.hostname`。
- 不写 `data-project` 时统计整个域名。
- `data-project="auto"` 取当前 URL pathname 第一段并转为小写。
- `data-target` 自动填充目标元素，`data-prefix` 添加显示前缀。
- `data-poll` 按毫秒轮询，并使用单飞锁避免重复请求。

### JavaScript API

```js
window.BFTCounter.hit();

const data = await window.BFTCounter.get();
console.log(data.total);

const off = window.BFTCounter.on((next) => console.log(next));
console.log(window.BFTCounter.peek());
off();

const committed = await window.BFTCounter.hitAsync();
console.log(committed.total);
```

旧式 `hit()` 保持 fire-and-forget、返回 `undefined`、吞掉网络异常。需要明确处理失败时使用新增的 `hitAsync()`。

也可以监听 DOM 事件：

```js
window.addEventListener("bftcounter:update", (event) => {
  console.log(event.detail);
});
```

## HTTP API

```text
GET|POST /hit?d=<domain>&p=<optional-project>
GET      /hit?d=<domain>&debug=1
GET      /stats?d=<domain>&p=<optional-project>
GET      /stats?d=<domain>&includeProjects=1
GET      /stats?d=<domain>&includeIps=1
```

- 普通 hit 成功返回 `204 No Content`。
- `debug=1` 返回 `{ok,domain,project,total,last,ts}`。
- 不存在的 domain/project 返回 `200`，且 `total: 0, last: 0`。
- 非法参数继续返回原来的 `400 invalid_domain/invalid_project`。
- 白名单拒绝继续返回 `403 domain_not_allowed`。
- 超过写入限制返回 `429` 和 `Retry-After`。
- GitHub 未配置、超时或写入失败返回稳定的 `503`。

默认关闭 `/stats` CDN/进程缓存，以保留旧项目 hit 后读取最新值的行为。设置 `COUNTER_STATS_CACHE_TTL_MS` 为正整数可以重新开启缓存。

## 兼容与安全配置

`config.json` 当前使用“旧调用兼容、域名范围收紧”的默认值：

```json
{
  "allowAll": false,
  "allowGetHits": true,
  "allowedDomains": [
    "bornforthis.cn",
    "ai.bornforthis.cn",
    "counter.bornforthis.cn",
    "aistudio.google.com",
    "gemini.google.com"
  ],
  "allowedRootDomains": [],
  "ipMode": "hash",
  "rateLimitMax": 5,
  "rateLimitWindowMs": 60000,
  "statsRateLimitMax": 60,
  "statsCacheTtlMs": 0,
  "maxProjectsPerDomain": 100,
  "maxVisitorKeysPerDomain": 2000
}
```

`allowGetHits=true` 保留旧式 GET 写入，已知存量域名已经列入 `allowedDomains`，所以这些站点的调用代码无需修改。`allowAll=false` 防止任意域名借公开接口创建文件和 Git commit。由于旧 API 无法枚举全部 domain，正式迁移时还要根据旧 `data.json` 补齐未知存量域名；否则它们会收到 `403 domain_not_allowed`。确有需要时可用 `allowedRootDomains` 放行某个根域及其子域。

旧配置 `anonymizeIp=true` 会兼容映射为 `anonymized`；`anonymizeIp=false` 会安全映射为 `none`，不会静默开启原始 IP 存储。

可覆盖：

- `COUNTER_ALLOW_ALL`
- `COUNTER_ALLOW_GET_HITS`
- `COUNTER_IP_MODE`
- `COUNTER_IP_HASH_SECRET`
- `COUNTER_ALLOW_RAW_IPS`
- `COUNTER_IP_STATS_TOKEN`
- `COUNTER_RATE_LIMIT_MAX`
- `COUNTER_RATE_LIMIT_WINDOW_MS`
- `COUNTER_STATS_RATE_LIMIT_MAX`
- `COUNTER_STATS_CACHE_TTL_MS`
- `COUNTER_MAX_PROJECTS_PER_DOMAIN`
- `COUNTER_MAX_VISITOR_KEYS_PER_DOMAIN`

`rateLimitMax`、`statsRateLimitMax`、`statsCacheTtlMs`、`maxProjectsPerDomain` 和 `maxVisitorKeysPerDomain` 允许使用 `0`；分别表示关闭对应限流、缓存或数量上限。关闭限制并不能突破 GitHub 的平台约束。

`raw` 模式下的 `includeIps=1` 必须携带 `Authorization: Bearer <COUNTER_IP_STATS_TOKEN>` 或 `X-Counter-Stats-Token`。普通 PV、project 和不含 IP 的 stats 调用仍保持原接口格式。

所有 `includeIps=1` 响应都强制使用 `private, no-store`，不会进入 Vercel 共享缓存。即使以后从 `raw` 切换到其他模式，文件中遗留的原始 IP 仍会被识别并要求相同 Token，不会因模式切换而变成公开响应。

函数内限流只约束单个 Vercel 实例。生产环境还应在 Vercel Firewall 中同时限制 `GET|POST /hit` 和 `GET /stats`。公开 hit 无法证明访问真实性，本项目不具备防刷或计费级可信度。

## 测试

```bash
npm test
```

自动测试覆盖原 GET/POST API、domain/project 包含关系、IP/UV、旧配置、`counter.js` 的全部 data 属性、全局 API、DOM 事件、静态别名、GitHub SHA 冲突和错误处理。

原式 GET 端到端回归：

```bash
COUNTER_STORAGE=memory COUNTER_ALLOW_ALL=true npm start
npm run test:regression -- --base http://127.0.0.1:8787 --domain localhost
```

浏览器页面位于 `Test/counter-test.html` 和 `Test/counter-test-advanced.html`。

## 旧数据迁移

仓库旧 `counts.txt` 并不是原 `server.js` 的运行数据，不能作为生产快照。真正的旧服务写入主机本地 `data.json`，公开 API 又无法枚举全部 domain，因此当前数据仓库尚未完成正式迁移。

从旧主机取得完整文件后运行：

```bash
export COUNTER_IP_HASH_SECRET="$(openssl rand -hex 32)"
npm run migrate:legacy -- \
  --input /absolute/path/to/data.json \
  --output /absolute/path/to/github-backed-pv-counter-data/data/domains \
  --force
```

把生成的同一个 `COUNTER_IP_HASH_SECRET` 安全保存并配置到 Vercel Production。迁移器支持 `{version, domains}` 的旧 `data.json`，也支持直接 domain map；它保留 domain/project 的 `total`、`last` 和访客频次，并把旧 IP 转为与运行时一致、按 domain 隔离的 HMAC 标识。若明确不需要历史 UV，可以不设置该变量，迁移器会主动丢弃旧 IP map，避免原始 IP 进入公开 Git 历史。迁移会在写文件前检查 `COUNTER_GITHUB_MAX_FILE_BYTES`（默认 524288）和 `COUNTER_MAX_VISITOR_KEYS_PER_DOMAIN`（默认 2000），超限时直接停止，避免生成首个 hit 就会失败的数据文件。

迁移前必须确认输出目录中没有最终快照之外的陈旧 JSON；`--force` 只覆盖同名文件，不会自动删除快照中不存在的文件。配套数据仓库中早期从 `counts.txt` 生成的错误 seed 已移除。

正式切换顺序：先保持旧站在线并完成新 Vercel 临时 URL 的部署验证；随后短暂停止旧服务写入、复制最终 `data.json`、运行迁移、补齐 allowlist、核对每个 domain/project 数值并提交数据仓库，再通过临时 URL 读取最终数据，最后立即切换 `counter.bornforthis.cn`。如果不先停写和做最终快照，迁移期间新增的 PV 会丢失；冻结写入到域名切换之间会有一个尽量缩短的维护窗口。

## 相关文档

- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents)
- [GitHub repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- [Vercel Express deployments](https://vercel.com/docs/frameworks/backend/express)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)

## License

ISC
