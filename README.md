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
pnpm pack                                              # prepublishOnly 只在 publish 时跑测试
dsh plugin --profile web add ./dsh-web-search-yuanbao-0.2.3.tgz
```

**不要用 `link:` 安装**：`link:` 保留符号链接，Node 按真实路径解析依赖，pnpm 又不会替你安装
被链接包的 dependencies，`@deepseek-ai/schemastery` 就解析不到，`Config` 退化为 undefined，
设置页表单随之消失（插件本身仍可用）。非要用 `link:`，得在插件目录里自己跑一次 `pnpm install`。

改代码后必须**先升版本号再 pack**，否则 pnpm 按 lockfile 跳过，装上去还是旧代码。

</details>

## 3. 第三方用户怎么配自己的 API Key

插件自带的 Key 只是作者本地的引用名，**每个用户必须用自己在腾讯云创建的 Key**。四步：

### 步骤 1：先在腾讯云拿到自己的 Key

1. 登录腾讯云并完成实名认证（个人/企业都可）。
2. 打开元宝搜索控制台 <https://console.cloud.tencent.com/wsapi/index> → **开通服务** → 选版本购买。
3. **概览 → 服务 API KEY 方式 → 创建 API KEY** → 命名 → 弹窗里复制（**只显示这一次**）。

> 注意：极速版只支持 `Query` 与 `Site`，`Cnt/Mode/Industry/Freshness` 不生效；
> 需要这些能力要选标准版或旗舰版。

### 步骤 2：安装插件

```bash
dsh plugin --profile web add github:Alancere/dsh-web-search-yuanbao
dsh --profile web                 # 或重启已在运行的 dsh web
```

### 步骤 3：把 Key 填进设置页

**插件 → 已安装 → 元宝搜索**，把 Key 粘进 `API Key` 字段，保存即可（改动即时生效，不用重启）。

这个表单由插件的 `Config` schema 自动生成，字段与第 5 节一致。`apiKey` 声明了
`role('secret')`：值不会被回显，也不会出现在 profile 的 patch 明文里。

如果你更喜欢用命令/文件配置，三选一：

```yaml
# A. profile 的 cordis.patch.yml（会明文落盘，不推荐长期用）
- id: web-search-yuanbao
  config:
    apiKey: sk-你的Key
```

```yaml
# B. 凭据存储 $DSH_HOME/.credentials.yaml（权限 600，与 Models 页同一机制）
refs:
  TENCENTCLOUD_WSA_APIKEY: sk-你的Key
```

```bash
# C. 启动环境变量（注意 GUI 启动的 dsh 读不到 shell 里的 export）
export TENCENTCLOUD_WSA_APIKEY=sk-你的Key
```

### 步骤 4：验证

随便问一个有时效性的问题（“今天的汇率”“最近一周的 AI 新闻”），工具结果首行应当是：

```text
元宝搜索「今日长沙天气」（极速版，10 条）
```

看到这行就说明搜索后端已经是元宝了。也可以直接问“用 yuanbao_search 查今天的新闻”。

## 4. 密钥解析优先级

`config.apiKey`（含设置页写入的值）→ `ctx.credentials.resolve(apiKeyEnv)` → `process.env[apiKeyEnv]`。

引用名默认为 `TENCENTCLOUD_WSA_APIKEY`，可用 `apiKeyEnv` 改成任意环境变量名。三个来源都没有时，
错误码是 `WEB_PROVIDER_CREDENTIAL_MISSING`，提示信息会直接告诉你缺哪一层。

### 常见问题

| 现象 | 原因 |
|---|---|
| 设置页里找不到「元宝搜索」 | 插件没真正加载：检查 profile 的 `dsh.profile.bundles` 是否含 `dsh-web-search-yuanbao`，装完要重启 |
| 表单是空的 / 字段不显示 | 用 `link:` 安装导致 `@deepseek-ai/schemastery` 解析失败；改用 `github:` 或 tarball |
| 报 `ResourceNotFound` | 腾讯云侧没开通元宝搜索服务 |
| 报 `UnauthorizedOperation` | Key 错了/失效，或子账号没有 WSA 全读写权限（主账号在 CAM 里授权） |
| 结果里说“已忽略 count/freshness” | 你的套餐是极速版，换成标准版/旗舰版才生效 |
| 填了参数但结果一样 | 同上，极速版服务端直接忽略这些参数 |
| `web_search` 仍像在走别的引擎 | 有另一个可用 provider 抢了选择权；用 `DSH_WEB_SEARCH_PROVIDER=yuanbao` 或改 `web` 行的 `searchProvider` |

也可以直接在设置页的「API Key」字段里填（`role('secret')`，不回显）。

## 5. 动态配置（设置页自动表单）

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

## 6. `yuanbao_search` 工具（模型自己决定参数）

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

## 7. 版本能力矩阵与降级

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

## 8. 切换与回滚

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

## 9. 错误码映射

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

## 10. 自测

```bash
node --test test/*.test.mjs      # 16 项：映射/条数/降级/版本结算/错误码/取消
```

## 11. 已知限制

- **没有 fetch**：`web_fetch` 仍由 `dsh-web-fetch-http` 提供。
- **设置页下拉里没有它**：内置「网页搜索」卡片只列官方 provider；元宝的配置走
  **自己那张自动生成的表单**，切换 provider 仍要改补丁或 `DSH_WEB_SEARCH_PROVIDER`。
- **无 schema 校验时静默忽略**：以 `link:` 方式装（`Config` 为 undefined）时，配置键名写错不会报错。
- **`Cnt` 是档位不是精确值**：要 8 条也得请求 10 条，由 seam 截断到 `maxResults`。
