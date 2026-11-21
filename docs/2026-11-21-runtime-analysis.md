# smart-ratelimit 运行时失效实证分析与改造方案

> 日期：2026-11-21
> 关联会话：`session-387433c8-09d9-4323-98bd-bc491274cd1f`
> 关联文档：[SMART_RATELIMIT_ISSUE_CONTEXT.md](SMART_RATELIMIT_ISSUE_CONTEXT.md)（配置/产品层视角；本文是运行时实证视角，并对其中两处结论做勘误）
> 复现实验脚本：[repro-isolate.mjs](repro-isolate.mjs)

---

## TL;DR

1. **DSH 的 retryPolicy 重试机制一直在正常工作**。session-387433c8 里主对话的每一次 429 都被「固定 10 秒、最多 20 次」的重试接住，没有任何一次重试耗尽。"要人手动继续"的体感不是重试失败造成的。
2. **插件从未拦截过任何一个请求**。RPC 实测 `getMonitorData` 对 nvidia / sensenova-me 全部为 0（队列 0、窗口 RPM 0、日计数 0），而实测期间对话正在持续发请求；`rate_limit_429_history.json` 始终为空 `{}`。
3. **根因是 Cordis 的 Service isolate 过滤器，不是配置、不是版本、不是写法**。`ctx.on('llm/stream')` 注册的监听器被 `Service[symbols.filter]` 的「isolate 桶匹配」规则静默丢弃。用桌面版同版本 cordis 4.1.0 复现实验确认：现状写法事件到达 0 次；加 `{ global: true }` 后事件到达 1 次。
4. **修复是一行改动**：注册监听器时传第三个参数 `{ global: true }`（`ctx.on('llm/stream', handler, { global: true })`），完全落在插件项目内，不改 `cordis.patch.yml`、不改 profile。
5. 修好拦截后，插件的令牌桶排队（acquire 阻塞等待）就是用户想要的「压制速率、慢速无人值守」主体；429 冷却门 + 历史校准提供自适应兜底。retryPolicy 10 秒固定对 `tpm exhausted`（分钟级窗口）不适配的问题，建议由插件的 429 历史校准输出建议值，而不是继续调 profile。

---

## 一、session-387433c8 实测数据

从 `~/.dsh/sessions/--Users-user-wsp-foxconn-sw-tool-services-dev--/session-387433c8-.../session.v4.jsonl.zstd`（zstd 解压后 402 条事件）还原的时间线：

| 时间 | 事件 | 说明 |
|---|---|---|
| 11:18 | turn 1 以 error 结束 | `400 max_tokens exceeds the limit of 65536`（AgnesAI，非 429） |
| 11:20:07 / 11:20:26 | turn 2 / 3 以 error 结束 | `pi-ai provider "sensenova-me" has no configured model "deepseek-v4-flash"`（选了不存在的模型 ID，非 429） |
| 11:19–11:26 | 主对话撞 429 共 18 次 | `rpm exhausted` / `tpm exhausted` / `rps exhausted`；9 组请求的重试分布：1 次×4 组、2 次×2 组、4 次×2 组、11 次×1 组，**全部恢复，无一耗尽** |
| 11:27:22 | 启动 workflow `deadcode-verify` | 一次性并行 6 个 subagent，全部打 sensenova-me |
| 11:27–12:01 | **主对话同步等待 workflow 34 分钟** | 9 个 agent 断续重试；agent-1 中途失败（workflow 的 `agent()` 失败返回 null，不重试 subagent） |
| 11:46 / 11:47 / 12:01:14 | 用户手动切模型 ×2、手动发「继续」 | 「必须在电脑前」的体感来源 |
| 12:01–12:03 | 继续 + 切 deepseek-flash 后连续 11 次 429 | 10 秒一次硬撞，最终恢复 |

每次重试的 `llm/retry` 事件里 `policyKey` 均为 `["normal",20,["RATE_LIMIT","SERVER","STREAM_CLOSED","TRANSPORT"],10000,10000,0]`——profile 的 retryPolicy 配置完整生效。

**关键推论**：被动重试是通的；用户缺的是**主动节流**（发前排队），这恰是本插件的定位，但它从未工作。

## 二、「插件从未拦截」的实证

按排查顺序列出证据与被排除的假设：

| # | 假设 | 验证方法 | 结果 |
|---|---|---|---|
| 1 | 插件没被加载 | `POST /api/dsh-plugin-smart-ratelimit/rpc` 探活 | `ok:true`，返回 5 个 provider（含 sensenova-me）→ **插件活着** |
| 2 | 插件没管 sensenova-me（settings 只有 nvidia/agnes） | RPC `getSettings('sensenova-me')` | `rpm:60, enabled:true, priority:user_custom, backoffStrategy:fixed` → **配置合并层完好，全局兜底 60 RPM 兜住了**（configMerger 的 `mergeDefined` 修复已生效） |
| 3 | 限速器配置非法（rpm=0 放行） | RPC `getMonitorData('sensenova-me')` | 桶满（tokens=60/capacity=60）→ **limiter 正常** |
| 4 | 请求走了但被 bypass | 监控窗口数据 | **`rpm:0, queueLength:0, dailyUsed:0` 全零**——11-21 那天几十次请求（含并行 subagent）无一进入限速器 |
| 5 | 运行中是旧版插件（无 llm/stream 接入） | node_modules 包内容 vs 源码；进程启动时间（11-19 09:36）vs 包安装时间（11-14 14:10） | 运行中的 1.0.21 **包含** `registerRequestInterceptor` → 排除 |
| 6 | DSH 没有 `llm/stream` 事件 | 解包桌面版 app.asar 中 `@deepseek-ai/dsh-llm 0.2.2-rc.3` | `streamWithRegistration` 里确有 `ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(...))` → 事件存在 |
| 7 | 监听器写法错误 | 对照 dsh-live-token-stats 0.4.8（同样 `ctx.on("llm/stream", (options, next) => ...)`） | 写法等价 → 排除 |
| 8 | **Cordis isolate 过滤器丢弃了监听器** | 用桌面版 cordis 4.1.0 跑最小复现（[repro-isolate.mjs](repro-isolate.mjs)） | **确认**（见下节） |

补充对照：dsh-live-token-stats 的 UI 数据来自 `liveTokenStats` **session projection**（不经过事件过滤器），它的 `llm/stream` 实时监听部分很可能同样被过滤——用户感知不到，因为持久化统计照常工作。这解释了「同为 insert 行、同写法，一个『看起来正常』一个失效」的表象矛盾。

## 三、根因：Service isolate 过滤器

### 机制链

1. cordis 的每个 `Service` 基类实例自带原型方法（cordis 4.1.0 `lib/index.js`）：

   ```js
   [symbols.filter](hookCtx) {
     return hookCtx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name];
   }
   ```

2. dsh-llm 的 `LlmRuntime` 继承该基类。它发事件时把**服务实例自己**作为 waterfall 的 `thisArg`：

   ```js
   return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
   ```

3. `_resolve` 解析监听器时（cordis `lib/index.js`）：

   ```js
   const filter = thisArg?.[Context.filter];   // 命中 Service 原型方法 → 非空 → 过滤启用
   return (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx));
   ```

4. DSH loader 对「提供服务的插件」执行 `isolate(name, label)`，把该服务放进以服务名命名的桶。smart-ratelimit 没有声明 join `llm` 桶 → 它的 fiber ctx 上 `isolate['llm'] === undefined` ≠ 服务的桶 → `filter.call(...)` 返回 false → **监听器被静默跳过，宿主流不受任何影响**（无报错、无日志， hence 难排查）。

### 复现实验（桌面版同版本 cordis 4.1.0）

```
A: 消费方在桶外（现状 smart-ratelimit）: 事件到达 0 次 chunk=1   ← 流照常，监听器全被跳过
B: 消费方 join llm 桶（isolate 对齐）  : 事件到达 1 次 chunk=1
C: 桶外 + 监听器 global:true          : 事件到达 1 次 chunk=1   ← 一行修复
D: join 桶 + global:true              : 事件到达 1 次 chunk=1
```

`hook.global = true` 在 `_resolve` 的过滤表达式里短路所有 filter，与桶无关。

## 四、对既有文档的两处勘误

[SMART_RATELIMIT_ISSUE_CONTEXT.md](SMART_RATELIMIT_ISSUE_CONTEXT.md) 中的：

1. **「根因 1：siliconflow / opencode-go 缺 retryPolicy」**——成立但是**潜在风险**，不是本次 session 的实锤原因：本次所有 429 都发生在 sensenova-me / nvidia，两者 retryPolicy 完整生效。漏配 provider 的默认策略（5 次 / 500ms / 10% 抖动）风险保留，建议插件做「retryPolicy 漏配检测 + 面板告警」，见改造项 R3。
2. **「根因 2：仅拦截流式，非流式走 `llm/complete` 不拦截」**——前提不成立：实测**流式拦截本身也从未生效**（isolate 过滤）；另外桌面版 `@deepseek-ai/dsh-llm 0.2.2-rc.3` 中未发现 `llm/complete` 事件（grep 无命中），非流式路径是否存在独立事件待验证。先修 global:true，再验证非流式。

## 五、改造路线图（全部只改插件项目代码）

### R1（P0，一行）：打通 llm/stream 拦截

`src/index.js` 的 `registerRequestInterceptor()`：

```js
// 修改前
this.ctx.on('llm/stream', (options, next) => { ... });
// 修改后
this.ctx.on('llm/stream', (options, next) => { ... }, { global: true });
```

风险控制：`global` 只影响事件可见性，不改变 waterfall 契约（监听器签名、`next()` 单次调用、返回 async generator 均不变）；复现实验 D 场景确认无副作用。

### R2（P0）：429 记账链路补全

现状 `_tapLlmStream` 的 `postProcess` 依赖流层信号，而 429 发生在 adapter 层、已被转成 terminal `finish` chunk（`adapterFailureChunk`：`reason.kind = 'error'`，`failure.message` 含 429 文本）。需要：

1. `_tapLlmStream` 在 `finish` chunk 上识别 `reason.kind === 'error'` 且 `failure.message` 匹配 429（或 `failure.code` 属于 `RATE_LIMIT` 类）→ 传给 `postProcess` 触发：清桶、写 `rate_limit_429_history.json`、进入 provider 冷却门。
2. 验收标准：`rate_limit_429_history.json` 出现 sensenova-me 记录；面板 429 横幅出现。
3. 注意与 DSH retryPolicy 的分工：插件记录 + 冷却（影响**后续**请求的发送时机），retryPolicy 负责当前请求的重试——两层不冲突，但要避免双重退避叠加导致过长等待（冷却门已有「共享一次退避」设计，确认 acquire 路径复用同一冷却门即可）。

### R3（P1）：成为「发前压制」的主体 + retryPolicy 缺口检测

1. **令牌桶排队即压制**：R1 生效后，acquire 阻塞排队天然实现「慢速发送」。对 workflow 并行 subagent 场景（session 里 6 个并发），provider 级 FIFO 队列自动把并发摊平为 RPM 上限内的匀速流——这正是「慢点但无人值守」。
2. **退避策略适配**：`tpm exhausted` 是分钟窗口，10 秒固定重试大概率空转（session 中 4 连重试即证据）。插件已有 per-provider `backoffStrategy`（auto/fixed/exponential）与冷却门；R2 生效后冷却门真正介入后续请求的发送时机，等于**用插件侧退避补 retryPolicy 的粒度不足**，不需要改 profile。
3. **retryPolicy 漏配检测**：`initializeProviders` 时对照 DSH 配置里每个 provider 的 `retryPolicy` 声明，缺失的在面板显示告警（可复用横幅组件），提示用户该 provider 会落回 5 次默认策略。只读检测，不改配置。
4. **（可选，需先验证）** 调研 dsh-llm-pi-ai 是否支持运行时热更新 provider 配置；若支持，可提供「一键把 429 历史校准值写回 retryPolicy 建议值」的按钮。未验证前不做。

### R4（P2）：可观测性

1. 插件启动时往日志打一行实际注册状态（`[SmartRateLimit] llm/stream listener registered (global)`），并在 `route-status.json` 增加 `llmStreamListener: true` 字段——避免本次「静默失效一周无人知晓」。
2. 面板监控区加「累计拦截请求数」计数器：若请求发生而计数不涨，说明拦截断链，一眼可见。

## 六、验证清单（R1/R2 完成后）

1. `pnpm pack` 更新 tgz → profile `pnpm install` → 重启 DSH（插件代码改动需重启加载；当前进程自 11-19 09:36 运行至今）。
2. `curl -s -X POST http://127.0.0.1:62276/api/dsh-plugin-smart-ratelimit/rpc -d '{"method":"getMonitorData","args":["nvidia"]}'`：随便发起一次对话后，`rpm` 应 > 0、`queueLength` 随并发变化。
3. 触发一次 429（或在测试环境 mock）后：`rate_limit_429_history.json` 出现对应 provider 记录；第二次请求前有冷却等待。
4. 在 `~/.dsh/logs` 或插件日志确认 `[SmartRateLimit] llm/stream listener registered`。
5. 长跑验证：给一个会持续撞限流的多 agent 任务，确认全程无人工干预完成（subagent 失败除外——workflow 层不重试 subagent 属于 DSH 行为，超出插件控制范围，见第七节）。

## 七、插件管不到的部分（记录边界）

- **workflow 的 `agent()` 失败不重试 subagent**（session 里 agent-1 中途死亡、结果残缺）——这是 workflow 工具的语义，插件只能在请求层把 429 概率压到极低来间接缓解。
- **turn 1 的 400 / turn 2-3 的 UNKNOWN_MODEL** 与限流无关：前者是 provider `maxTokens` 配置超过上游上限，后者是模型 ID 选错；retryPolicy 对这两类错误（非 retryable code）不重试，属正确行为。

## 附录：证据路径

| 证据 | 位置 |
|---|---|
| session 原始事件 | `~/.dsh/sessions/--Users-user-wsp-foxconn-sw-tool-services-dev--/session-387433c8-.../session.v4.jsonl.zstd` |
| 插件运行时配置（RPC） | `getSettings` / `getMonitorData`，POST `http://127.0.0.1:62276/api/dsh-plugin-smart-ratelimit/rpc` |
| 429 历史文件（空） | `config/rate_limit_429_history.json` |
| 桌面版 cordis 4.1.0（解包自 app.asar） | `/tmp/dsh-asar/cordis-index.js`；`_resolve` 过滤在 L833-834，`Service[symbols.filter]` 在 L1849-1851 |
| 桌面版 dsh-llm 0.2.2-rc.3 | `/tmp/dsh-asar/dsh-llm-index.js`；waterfall 在 L2507 |
| 桌面版 dsh-llm-retry | `/tmp/dsh-asar/dsh-llm-retry-index.js`；`agent/request-error` 扩展点 + provider 配置声明 retryPolicy |
| 复现脚本 | [docs/repro-isolate.mjs](repro-isolate.mjs)（`node repro-isolate.mjs`，需与 cordis-index.js 同目录） |
| 对照插件 | `~/.dsh/profiles/desktop/node_modules/dsh-live-token-stats/lib/index.js` L138175 |
