# dsh-web-search-yuanbao

把**腾讯云元宝搜索（SearchPro）**接进 DeepSeek Harness：中文/国内信源优先，支持权威垂直领域与时效过滤，并让模型自己决定检索参数。

```bash
dsh plugin --profile web add dsh-web-search-yuanbao
```

装完重启 `dsh web`，在「插件 → 已安装 → 元宝搜索」里填腾讯云 API KEY 即可。

## 它做什么

两条通道共用一个请求核心：

| 通道 | 面向谁 | 用途 |
|---|---|---|
| `ctx.web` 搜索 provider | 内置 `web_search` 工具 | 无感替换搜索后端，工具面完全不变 |
| `yuanbao_search` 工具 | 模型 | 暴露元宝专有参数，让模型按需决定 |

配置通过 `Config`（schemastery + volatile）声明，Harness **设置页会自动生成表单**，改完即时生效——与内置 provider 同一套机制。

```
web_search ─┐
            ├─► ctx.web ── searchProvider: yuanbao ──► api.wsa.cloud.tencent.com/SearchPro
yuanbao_search ┘（工具直连 provider，逐次覆盖参数）
web_fetch ──► dsh-web-fetch-http（元宝无抓取能力）
```

### 为什么用它

- **中文/国内信源**：微信、知乎、今日头条、国内云厂商文档等英文搜索引擎覆盖差的内容。
- **权威与时效**：`industry=gov|news|acad|finance` 搭配 `freshness=d7|m3|y1|日期区间`（标准版起）。
- **可被模型按次调参**：`yuanbao_search` 的 6 个参数由模型决定，不用改配置。
- **版本感知**：`auto` 从 `Response.Version` 判定极速/标准/旗舰，不支持的参数自动剥离并明示。

## 1. 前置：腾讯云侧

1. 注册/登录腾讯云并完成实名认证。
2. 控制台 <https://console.cloud.tencent.com/wsapi/index> → **开通服务**，选版本（极速 / 标准 / 旗舰）。
3. **概览 → 服务 API KEY 方式 → 创建 API KEY**，复制或下载 CSV（只显示一次）。

硬约束：每账号最多 3 个 KEY；子账号需 CAM 授予元宝搜索（WSA）全读写权限。

> 注意：**极速版只接受 `Query`（与 `Site`）**，`Cnt/Mode/Industry/Freshness` 会被服务端静默忽略。
> 需要这些能力请升级到标准版或旗舰版——插件会在结果里如实标注哪些参数没被采纳。

## 2. 安装

```bash
dsh plugin --profile web add dsh-web-search-yuanbao        # 从 npm
dsh plugin --profile web add dsh-web-search-yuanbao@0.2.2  # 锁版本
dsh plugin --profile web add github:Alancere/dsh-web-search-yuanbao  # 从源码
```

安装后确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `dsh-web-search-yuanbao`，再重启 `dsh web`。

<details>
<summary>本地开发 / 未发布的版本</summary>

```bash
pnpm pack                                              # 会先跑一遍测试（prepack）
dsh plugin --profile web add ./dsh-web-search-yuanbao-0.2.2.tgz
```

**不要用 `link:` 安装**：`link:` 保留符号链接，Node 按真实路径解析依赖，pnpm 又不会替你安装
被链接包的 dependencies，`@deepseek-ai/schemastery` 就解析不到，`Config` 退化为 undefined，
设置页表单随之消失（插件本身仍可用）。非要用 `link:`，得在插件目录里自己跑一次 `pnpm install`。

改代码后必须**先升版本号再 pack**，否则 pnpm 按 lockfile 跳过，装上去还是旧代码。

</details>

## 3. 密钥

解析顺序：`config.apiKey` → `ctx.credentials.resolve(apiKeyEnv)` → `process.env[apiKeyEnv]`。

推荐写进 credentials 存储（与 Models 页同一机制，权限 600）：

```yaml
# $DSH_HOME/.credentials.yaml
refs:
  TENCENTCLOUD_WSA_APIKEY: sk-xxxxxxxx
```

也可以直接在设置页的「API Key」字段里填（`role('secret')`，不回显）。

## 4. 动态配置（设置页自动表单）

插件导出的 `Config` 字段：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `apiKey` | secret | — | 字面量密钥，优先于环境变量 |
| `apiKeyEnv` | credential-ref | `TENCENTCLOUD_WSA_APIKEY` | 密钥引用名 |
| `endpoint` | string | `https://api.wsa.cloud.tencent.com/SearchPro` | 端点 |
| `version` | enum | `auto` | `auto` 由服务端 `Response.Version` 判定；可强制 `lite`/`standard`/`flagship` |
| `mode` | enum 0/1/2 | — | 0 公开网页 / 1 权威垂直信源 / 2 混合 |
| `site` | string | — | 单域名，或 `exclude:a.com\|b.com`（最多 5 个） |
| `industry` | enum | — | `gov` / `news` / `acad` / `finance` |
| `freshness` | string | — | `d7` / `m3` / `y1` / `2026-08-20` / 日期区间 |
| `timeoutMs` | number | 20000 | 单次搜索超时 |
| `snippetChars` | number | 500 | 摘要截断长度 |
| `exposeTool` | boolean | true | 是否注册 `yuanbao_search` 工具（改后需重启） |

这些字段全部 `volatile()`：设置页保存后写进 profile patch，下一次搜索即读到新值，不重挂插件。

验证表单确实注册（不打开 UI 的检查方式）：插件以 `ns=web-search-yuanbao`、`autoGenerate=true`
出现在 `ctx.settings.describe()` 里。

## 5. `yuanbao_search` 工具（模型自己决定参数）

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string（必填） | 搜索词 |
| `count` | integer enum | 10/20/30/40/50（服务端只接受这五档） |
| `freshness` | string | 时效范围 |
| `industry` | enum | 垂直领域 |
| `site` | string | 站点定向/排除 |
| `mode` | integer enum | 结果类型 |

调用参数优先于设置页的默认值（`query` 除外）。工具返回的文本首行会写明**生效版本**与
**被忽略的参数**，例如：

```
元宝搜索「今日长沙天气」（极速版，10 条；已忽略极速版不支持的 count（条数）、industry（垂直领域）、freshness（时效））
```

## 6. 版本能力矩阵与降级

| 能力 | 极速版 | 标准版 | 旗舰版 |
|---|---|---|---|
| `Query` | ✅ | ✅ | ✅ |
| `Site` | ✅ | ✅ | ✅ |
| `Cnt` / `Mode` / `Industry` / `Freshness` | ❌ | ✅ | ✅ |
| 返回 `content` / `pics` | ❌ | ✅ | ✅ |
| `authority_level` / `deeplinks` | ❌ | ❌ | ✅ |

降级有两条路径，都自动完成：

1. **按探测到的版本预先裁剪**：知道是 `lite` 就只发 `Query`（+`Site`）。
2. **事后纠偏**：版本未知时先发全参数；收到 `InvalidParameter` 就记住 `lite` 并重试一次。
   实测极速版可能**不报错、直接忽略**这些参数——此时按最终版本重新结算「哪些参数没被采纳」，
   在结果里明示，避免看起来像是生效了。

## 7. 切换与回滚

```yaml
# profile 的 cordis.patch.yml（优先级高于插件 bundle）
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

```bash
DSH_WEB_SEARCH_PROVIDER=deepseek-official dsh web   # 等价
dsh plugin --profile web remove dsh-web-search-yuanbao
```

## 8. 错误码映射

| 元宝 | 本插件 `code` |
|---|---|
| `UnauthorizedOperation` / 401 / 403 | `WEB_PROVIDER_UNAUTHORIZED` |
| `ResourceNotFound` | `WEB_PROVIDER_NOT_SUBSCRIBED` |
| `ResourceUnavailable` | `WEB_PROVIDER_UNAVAILABLE` |
| `RequestLimitExceeded` | `WEB_PROVIDER_RATE_LIMITED` |
| `InvalidParameter` | `WEB_PROVIDER_ERROR`（内部触发一次降级重试） |
| 无密钥 | `WEB_PROVIDER_CREDENTIAL_MISSING` |
| 超时 | `WEB_PROVIDER_TIMEOUT` |
| 取消 | `WEB_ABORTED` |

## 9. 自测

```bash
node --test test/*.test.mjs      # 16 项：映射/条数/降级/版本结算/错误码/取消
```

## 10. 已知限制

- **没有 fetch**：`web_fetch` 仍由 `dsh-web-fetch-http` 提供。
- **设置页下拉里没有它**：内置「网页搜索」卡片只列官方 provider；元宝的配置走
  **自己那张自动生成的表单**，切换 provider 仍要改补丁或 `DSH_WEB_SEARCH_PROVIDER`。
- **无 schema 校验时静默忽略**：以 `link:` 方式装（`Config` 为 undefined）时，配置键名写错不会报错。
- **`Cnt` 是档位不是精确值**：要 8 条也得请求 10 条，由 seam 截断到 `maxResults`。
