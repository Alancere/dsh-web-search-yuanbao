# Changelog

## 0.2.2

- `@deepseek-ai/schemastery` 由 peer 改为真实依赖：干净 profile 里也会被装进 node_modules，
  设置页表单不再因为解析不到 schema 而消失。

## 0.2.1

首个公开版本。

- `ctx.web` 搜索 provider（id `yuanbao`）：让内置 `web_search` 走腾讯云元宝搜索。
- 新增 `yuanbao_search` 工具：把 `count` / `freshness` / `industry` / `site` / `mode` 暴露给模型按次决定。
- 导出 `Config`（schemastery + volatile），Harness 设置页自动生成表单，改动即时生效。
- 版本感知：`auto` 由 `Response.Version` 判定；极速版会自动剥离不支持的参数，并在结果首行注明哪些参数未被采纳。
- 归一化：`Pages` 二次解析、同 URL 去重、HTML 清洗、日期转 ISO-8601、`Cnt` 档位吸附。
- 错误码映射到 seam 的开放 code（未授权 / 未开通 / 欠费 / 限流 / 参数错误 / 缺密钥 / 超时 / 取消）。

## 0.1.0

内部可用版本（未发布）：最小 provider 实现，`link:` 安装，无配置 schema。
