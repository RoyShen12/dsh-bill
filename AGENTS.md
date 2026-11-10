# dsh-bill 项目规则

本仓库是 `Jannchie/dsh-bill` 的本地 fork：`origin` 为 `RoyShen12/dsh-bill`，`upstream` 为上游。上游保持只读，本地改动单独提交，按需向上游发 PR。

## 文档索引

- [README.md](README.md) / [README.zh.md](README.zh.md) — 功能、安装、配置与开发；中英成对，`scripts/i18n-pair.mjs` 校验。
- [MAGPIE-PRICING.md](MAGPIE-PRICING.md) — magpie 价目表接入的可行性研究与口径（本地文档，未提交）。
- [DEBUGGING.md](../dsh-plugins/docs/dsh-bill/DEBUGGING.md) — 装配方式、数据落点、计价链与常见故障。
- [VERIFICATION.md](../dsh-plugins/docs/dsh-bill/VERIFICATION.md) — 验证范围、已核对/未核对项与人眼复核步骤。

调试与验收文档集中在 `../dsh-plugins/docs/dsh-bill/`；README 不写调试或验收内容。

## 实现约定

- 纯 JavaScript，无构建步骤：`lib/*.js` 就是运行的文件。`lib/client.js` 手写，不生成，改它就是改产物；`scripts/` 只有中英 README 对齐检查。
- Host：`lib/index.js`（`Config`、用量捕获、环形缓冲与 rollup、webServer 路由）、`lib/pricing.js`（计价）、`lib/attribution.js`（成本归因）、`lib/projection.js`（`billTurns` 每轮费用投影）、`lib/hostkit.js`（借用宿主的原子写与跨进程锁）、`lib/magpie.js`（magpie 价目表源）。
- `Config` 用 Standard Schema（`~standard`），不用 schemastery：宿主投影不出 JSON Schema，插件管理页没有配置表单，配置项在插件自己的设置页里改。
- `POST /dsh-bill/api` 是浏览器半边唯一入口；`webServer.register` 对重复 `(kind, path)` 抛错，注册必须包在 `ctx.effect` 里，否则热重载会留下重影路由，表现为改动不生效。
- 计价顺序：本机 magpie 价目表 → models.dev / OpenRouter → 内置历史快照。目录刷新本身是被请求驱动的惰性检查，因此另有一个 5 分钟的生命周期 tick 去问「过期没有」（小时窗口不依赖面板被打开）；捕获到未计价的调用时限频（5 分钟）强制重取一次 magpie 列表。两种情况都会把 ring 里 `usd: null` 的行补价；不改历史记录里已存的 `usd`（价格是时间轴），新价只影响新调用；匹配不到的模型名标记为未计价，不估算。
- 运行态数据只写 `<DSH home>/dsh-bill/`（`records.jsonl`、`rollup.json`、`prefs.json`）。`rollup.json` 承载已被压缩掉的明细汇总，不能当缓存删除。
- 不修改 `~/.dsh` 的 profile 配置与安装（`cordis.patch.yml`、profile 定义），不跑 `pnpm/npm install`。

## 验证

`npm run check`（每个 lib 文件 `node --check`）与 `npm test`（15 个测试脚本 + 中英 README 对齐）。装配核对用 `cordis_inspect_query` 的 `Config.listConfigs` 与 `Slots.listSubTree`，细节见集中文档。
