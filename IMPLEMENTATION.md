# dsh-plugin-smart-ratelimit 实现文档

DSH 桌面端的通用多提供商智能限速插件。核心是 **RPM + TPM 双维度令牌桶** 和 **429 自学习**：把请求排队、Token 预扣与结算、429 惩罚与退避、日配额熔断、单模型子限速、NVCF 异步轮询集中在一个可复用的服务里，并提供「设置 → 速率设置」面板。

> 本文档面向插件维护者，描述目录结构、内部流程、配置合并、算法细节和已知问题。安装、配置面板和接入示例见 [README.md](README.md)。

- 运行环境：Node.js `>= 18`，原生 ES Modules
- 当前版本：以 [package.json](package.json) 为准
- 生产依赖：`js-yaml`（解析 DSH 的 YAML 配置）

> **接入现状**：本版本提供限速服务、Cordis 接口和 Web RPC，但还没有自动挂接到 DSH 的对话请求链路上。详见下文「接入方式」。

## 功能

- **双维度令牌桶**：RPM 与可选 TPM 两个平滑桶，按时间连续补充，默认只开放 20% 的初始突发容量。
- **5 层配置合并**：用户自定义 > 历史校准/探测值 > 系统配置 > 内置预设 > 全局兜底。
- **请求排队**：FIFO + 优先级队列，支持 `AbortSignal` 取消和队列超时。
- **Token 预扣/结算**：请求前按消息内容 + `max_tokens` 预扣，响应后按 `usage.total_tokens` 多退少补。
- **429 自学习**：记录 60 秒滑动窗口快照、清空双桶、写入历史文件，并按历史最低触发值给出安全上限。
- **日配额熔断**：按 UTC 自然日重置，95% 触发告警事件，100% 抛出 `ERR_RPD_EXCEEDED`。
- **单模型子限速**：探测值比主桶更严格时为该模型挂独立子桶，执行双重令牌校验。
- **NVCF 202**：按 `NVCF-POLL-SECONDS` 轮询异步结果，轮询请求不重复扣减配额。
- **热更新**：面板保存后立即调整现有令牌桶，保留 RPD 计数和滑动窗口。
- **Provider 管理**：自动发现 DSH 已配置的 Provider，也支持在面板里手动新增/移除。
- **React 设置面板**：Provider 下拉、429 历史横幅、参数表单、实时水位、保存/恢复/清空按钮，以及一个占位的探测按钮。

## 目录结构

```text
dsh-plugin-smart-ratelimit/
├── package.json                  # 插件元数据、DSH bundle/plugin 声明
├── cordis.patch.yml              # 把插件插入 DSH desktop profile 的补丁
├── config/
│   ├── default_presets.json      # 内置 Provider 默认限额
│   ├── rate_limit_settings.json  # 用户自定义配置（5 层中的最高层）
│   ├── rate_limit_429_history.json # 429 触发历史
│   ├── probed_model_limits.json  # 单模型探测结果
│   └── route-status.json         # 运行时生成：RPC 路由挂载状态
├── src/
│   ├── index.js                  # Cordis 插件入口：发现 Provider、注册服务与 RPC
│   ├── config/
│   │   ├── configPaths.js        # 配置目录解析（支持环境变量覆盖）
│   │   ├── configMerger.js       # 5 层配置优先级合并
│   │   └── providerDiscovery.js  # 从 cordis.patch.yml 发现 Provider
│   ├── core/
│   │   └── tokenEstimator.js     # Token 预估与模型校准
│   ├── history/
│   │   └── metricsTracker.js     # 60s 滑动窗口 + 429 历史记录器
│   ├── intercept/
│   │   ├── requestInterceptor.js # 排队、预扣/结算、429 冷却、NVCF 入口
│   │   └── nvcfPoller.js         # NVCF 202 轮询器
│   ├── limiter/
│   │   └── dualRateLimiter.js    # 双令牌桶、RPD 熔断、FIFO 队列、子限速
│   └── ui/
│       ├── client.js             # React 设置面板（运行时样式内联）
│       └── RateLimitSettingsView.css # 独立样式副本，当前未被 client.js 引用
├── scripts/
│   ├── probeModels.mjs           # CLI 模型阈值探测
│   ├── smoke-server.mjs          # 离线模拟 Cordis 宿主，验证 apply → start
│   └── smoke-client.mjs          # 用 React/DOM 桩件验证面板可加载
└── test/
    ├── dualRateLimiter.test.js   # 单元测试
    └── integration.test.js       # 配置合并、拦截器、NVCF、边界条件
```

`config/model_token_calibrations.json` 为可选的 Token 校准表，不存在时使用默认启发式估算。

## 接入方式

插件在 Cordis 中注册以下服务：

| 服务名 | 内容 |
| :--- | :--- |
| `smartRateLimit` | `SmartRateLimitPlugin` 实例，可访问 `providers`、`providerConfigs`、`interceptor` |
| `smart-ratelimit` | `acquire(request)`、`release(request, response)`、`getLimiter(providerId)`、`updateConfig(providerId, config)` |
| `smart-ratelimit.settings` | 面板使用的配置读写方法（见下文「RPC 与面板接口」） |

调用方在发请求前显式走限速器：

```js
const ratelimit = ctx.get('smart-ratelimit')

// 1. 申请许可：排队、扣减 RPM/TPM、做 RPD 检查
const request = await ratelimit.acquire({
  providerId: 'nvidia',
  modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages,
  max_tokens: 1024,
  isFreeModel: true,   // 见下方说明
})

// 2. 发真实请求
const response = await sendToProvider(request)

// 3. 交回限速器：Token 结算 + RPD 计数 + 429/NVCF 处理
//    202 时返回的是轮询后的最终响应；429 时抛 RATE_LIMIT_EXCEEDED
const finalResponse = await ratelimit.release(request, response)
```

`acquire()` 返回的是原请求对象加上 `_ratelimit` 字段；`release()` 必须接收这个带标记的对象，否则会跳过结算。

**`isFreeModel` 注意事项**：内置的 `nvidia` / `agnes` 预设和面板默认值里，`applyToFreeModelsOnly` 都是 `true`。这时只有 `isFreeModel: true` 的请求才会被限速；没有传该字段的请求会直接放行（`bypassed: true`）。如果希望所有请求都受约束，调用方应显式传 `isFreeModel: true`，或在配置里把 `applyToFreeModelsOnly` 设为 `false``.

**已接入对话主链路**：`src/index.js` 现注册 `llm/stream` 监听器，使用 `TransformStream` 包装流式响应——首个 chunk 被消费前调用 `interceptor.intercept()`（acquire），流结束（正常或异常）后调用 `interceptor.postProcess()`（release/结算）。普通对话现在会自动经过限速器并计入统计。

**指标去重修复**：`metricsTracker.recordRequest()` 现在仅在 `DualRateLimiter.acquire()` 第 447 行调用一次。`RequestInterceptor.intercept()` 不再重复记录。子限速器通过 `_skipMetrics: true` 显式跳过记录，由主限速器统一聚合，消除了约 2× 的 RPM/TPM 数值放大问题。

**探测系统集成**：`src/index.js` 新增 `getProbeDefaults(providerId)`、`startProbe(providerId, modelId, apiKey, options)` 与 `getProbeStatus(taskId)` RPC，内部复用 `probeModels.mjs` 的二分法 RPM 探测 + 线性 TPM 探测算法。

探测参数**全部自动读取 DSH 配置**，不需要用户手填：

- `getProbeDefaults(providerId)` 从 `cordis.patch.yml` 读取该 provider 的 `models`、`baseURL`、`apiKeyEnv`，返回模型下拉选项与「密钥能否自动取到」；**绝不回传密钥明文**。
- 密钥解析顺序：`process.env[apiKeyEnv]` → `~/.dsh/.credentials.yaml` 的 `refs[apiKeyEnv]`（DSH 本地凭据库，Web「模型」页面填写的 Key 落在这里）。`startProbe` 的 `apiKey` 因此可省略。
- 面板打开弹窗即拉取上述信息，模型为下拉、Base URL 只读展示；仅当密钥确实取不到时才回退到手动输入框。

启动任务后 3 秒轮询进度，完成后结果写入 `probed_model_limits.json`，下次启动自动为该模型创建子限速器（`getSubLimiter` 判定更严格时）。

**自动退避策略**：`RequestInterceptor.calculateBackoff()` 中 `strategy: 'auto'` 现在按 provider 智能选择：`nvidia*` → fixed 15s、agnes → exponential、其他 → exponential 并优先读取 `Retry-After` 头。

**RPD 95% 告警**：`getMonitorData` 返回 `dailyQuotaWarning` 标记（来源 `DailyQuotaBreaker.warnThreshold=0.95`），面板 `rpdBanner` 横幅在用量 ≥ 95% 时自动显示，含当前用量/上限/百分比。

**多配置文件合并发现**：`providerDiscovery.getCandidateConfigPaths()` 支持 `DSH_CONFIG_PATH="path1,path2"` 逗号分隔，遍历所有存在的文件按优先级合并，首次出现的 provider 胜出并标记 `sourceFile`，供 UI 展示来源。

## 核心流程

```text
请求进入 acquire()
  │
  ├─ _skipRateLimit? ──► 直接放行（NVCF 轮询等）
  ├─ applyToFreeModelsOnly 且 !isFreeModel? ──► 直接放行
  ├─ enabled=false? ──► 直接放行
  │
  ├─ 1. RPD 检查：已用 ≥ 上限 ──► 抛 ERR_RPD_EXCEEDED
  │
  ├─ 2. 预估 Token：estimateTokens(messages, modelId, max_tokens)（未传 max_tokens 时按 1024）
  │
  ├─ 3. 子限速器（如果该模型有更严格的探测值）──► 先过子桶
  │
  ├─ 4. 进入 FIFO/优先级队列，等待 (rpmTokens >= 1 且 tpmTokens >= 预估值)
  │
  ├─ 5. 放行瞬间扣减 rpmTokens -= 1、tpmTokens -= estimatedTokens
  │     并记入 60s 滑动窗口
  │
  └─ release()
       ├─ HTTP 429 ──► 双桶清零 + 写历史 + 冷却退避 + 抛 RATE_LIMIT_EXCEEDED
       ├─ HTTP 202 ──► NVCF 轮询，轮询请求跳过限速扣减
       └─ 2xx ──► usage.total_tokens 多退少补 + RPD 计数 +1
```

## 限速算法

### 令牌桶

- 容量：`rpm`（请求数）、`tpm`（Token 数，`0` 表示不建 TPM 桶）。
- 补充速率：`rpm / 60000`、`tpm / 60000`，按毫秒连续补充。
- 初始令牌：`Math.max(1, Math.floor(capacity * 0.2))`，即默认只开放 20% 突发，避免第一秒打满配额。
- 429 惩罚：主桶和所有已创建的子桶余额直接归零，重置补充时间戳。

### 排队

- 队列默认超时 5 分钟，超时抛 `Queue timeout after ...ms`。当前 `intercept()` / RPC 路径不透传 `timeoutMs`，只有直接调用 `limiter.acquire({ timeoutMs })` 才能覆盖。
- 优先级数值越小越先处理：付费请求为 `0`，免费请求为 `10`。新入队的高优先级请求可以在下一个调度 tick 插到低优先级请求之前。
- 支持 `AbortSignal`：排队中或等待中取消会抛 `Request aborted` / `Request aborted before queueing`。
- 调度循环每 20ms 重新评估一次队首，避免低优先级请求长时间占住调度。

### Token 预扣与结算

- 请求前：`estimatedTokens = 消息估算 + max_tokens`（`max_tokens` 为 `undefined` 时按 1024），放入 TPM 桶扣减。
- 响应后：`diff = usage.total_tokens - estimatedTokens`，`tpmTokens = clamp(tpmTokens - diff, 0, tpmCapacity)`。
- 没有 `usage` 的响应不做结算；429 和 202 不走普通结算路径。

## 配置系统

### 优先级

从低到高合并，后写入的层覆盖前面的同名字段：

| 层级 | 来源 | `priority` 值 |
| :--- | :--- | :--- |
| 1（最低） | 全局兜底：`60 RPM`、`TPM=0`、`RPD=0`、指数退避、60s 固定等待 | `global_fallback` |
| 2 | `config/default_presets.json` 中该 Provider 的预设 | `default_preset` |
| 3 | DSH 配置 `llm-pi-ai.providers.<id>` 里的 `rpm/tpm/rpd/enabled/...` | `system_auto` |
| 4 | `probed_model_limits.json` 与 `rate_limit_429_history.json` 的校准值（历史值覆盖探测值） | `probed` / `history_calibrated` |
| 5（最高） | `config/rate_limit_settings.json` 中该 Provider 的配置 | `user_custom` |

注意：第 4 层会把历史建议值直接合并进主配置。插件启动初始化时，一旦某个 Provider 已有 429 历史，即使没有在面板点「一键应用」，主桶也会降到建议值；运行中产生的 429 要等下次初始化（重启/重新加载插件）或点「一键应用建议值」后才会反映到主桶。如需固定数值，把配置写入 `rate_limit_settings.json`（最高层）。

### 配置目录

默认使用插件包内的 `config/` 目录。如果设置环境变量 `DSH_SMART_RATELIMIT_CONFIG_DIR`，所有配置文件都读写该目录。插件目录下没有 `default_presets.json` 时，回退到 `~/.dsh/smart-ratelimit`。

| 文件 | 作用 |
| :--- | :--- |
| `default_presets.json` | 内置 Provider 默认限额与约束 |
| `rate_limit_settings.json` | 用户自定义配置；也保存 `__customProviders`、`__removedProviders` |
| `rate_limit_429_history.json` | 每个 Provider 的 429 历史与建议值 |
| `probed_model_limits.json` | 单模型实测/预置限额，用于创建子限速器 |
| `model_token_calibrations.json` | 可选，Token 估算校准表 |
| `route-status.json` | 运行时生成，记录 RPC 路由的挂载阶段 |

### 内置预设

| 字段 | `nvidia` | `agnes` | `default` |
| :--- | :--- | :--- | :--- |
| 显示名 | NVIDIA NIM | Agnes AI 官方站 | 通用提供商 |
| RPM | 40 | 20 | 60 |
| TPM | 0（不限制） | 40000 | 0（不限制） |
| RPD | 10000 | 0 | 0 |
| 退避策略 | `fixed` | `exponential` | `exponential` |
| 固定等待 | 15s | 60s（仅 `fixed` 时生效） | 60s（仅 `fixed` 时生效） |
| 配额维度 | 账户共享 | 账户共享，图片单独计数 | Provider + API Key |

预设里的 `retryPolicy` 字段目前只作为数据保留，插件不会读取它来接管 DSH 的全局重试。`constraints` 同样是描述性数据，不参与限速计算；实际每个 Provider 只有一个主桶，不按 API Key 再拆分。

### 用户配置字段

`rate_limit_settings.json` 中每个 Provider 支持：

```json
{
  "nvidia": {
    "rpm": 40,
    "tpm": 0,
    "rpd": 10000,
    "enabled": true,
    "applyToFreeModelsOnly": true,
    "backoffStrategy": "fixed",
    "fixedBackoffSeconds": 15,
    "priority": "user_custom"
  }
}
```

- `enabled: false`：整个 Provider 直接放行。
- `tpm: 0`：不创建 TPM 桶。
- `applyToFreeModelsOnly`：只对 `isFreeModel: true` 的请求限速。
- `backoffStrategy`：`auto` / `fixed` / `exponential`；当前 `auto` 与 `exponential` 行为相同。
- `fixedBackoffSeconds`：仅 `fixed` 策略使用，具体值由预设或用户配置给出（nvidia 15，agnes/default 60）。

特殊键：

- `__customProviders`：面板手动新增的 Provider 列表，`[{id, displayName, baseUrl}]`。
- `__removedProviders`：被手动移除的 Provider id 列表，重启后仍不会出现在发现结果里。

### 429 历史

`rate_limit_429_history.json` 每个 Provider 的结构：

```json
{
  "nvidia": {
    "lastTriggeredAt": "2026-11-13T14:25:10.000Z",
    "triggeredAtRpm": 41,
    "triggeredAtTpm": 18420,
    "model": "nvidia/nemotron-3-ultra-550b-a55b",
    "suggestedSafeRpm": 36,
    "suggestedSafeTpm": 16578,
    "total429Count": 3,
    "records": [
      { "timestamp": "2026-11-13T14:25:10.000Z", "rpm": 41, "tpm": 18420, "model": "nvidia/nemotron-3-ultra-550b-a55b" }
    ]
  }
}
```

- `triggeredAtRpm` / `triggeredAtTpm` / `model` 是最近一次 429 的快照。
- `records` 只保留最近 20 条。
- 建议值公式：`max(1, floor(窗口内最低触发 RPM × 0.9))`，TPM 同理。窗口内最低值随 `records` 滚动，可能随旧记录被挤掉而升高。
- 快照里的 RPM/TPM 是 60 秒滑动窗口内的**预估** Token 累计（`metricsTracker` 记录的是预扣值，响应结算不会回写统计）。

## Provider 发现

启动时读取 `~/.dsh/profiles/desktop/cordis.patch.yml`：

1. 内置 Provider：`llm-deepseek-account` → `deepseek-account`（DeepSeek 账号）、`llm-deepseek` → `deepseek-official`（DeepSeek）。
2. `llm-pi-ai` 的 `config.providers` 下的所有 Provider，id 转小写，显示名取 `displayName`。
3. 都没有时，回退到 `default_presets.json` 里的 Provider（不含 `default`）。
4. 叠加 `__customProviders`，再排除 `__removedProviders`。

发现结果只用于插件自己的限速配置，不会改动 DSH 的 LLM 配置。

## 429 处理与退避

收到 429 后依次执行：

1. 用当前 60 秒滑动窗口生成快照。
2. `penalizeOn429()` 清空主桶和子桶。
3. 写入 `rate_limit_429_history.json`，重算建议值。
4. 计算退避时间并进入 Provider 级冷却门。

退避时间：

- 优先读取响应头 `retry-after`（秒），有值就直接使用。
- `fixed`：`fixedBackoffSeconds × 1000 + 0~3000ms` 随机抖动。
- `exponential`：`[1s, 2s, 4s, 8s, 16s]` 按 `_retryCount` 取档，再乘 `0.8 ~ 1.2` 抖动。
- 未配置策略时按 `exponential` 处理；`auto` 目前也落在这里。

冷却门：

- 同一 Provider 的并发 429 共享一个退避计时器，避免每个请求各 sleep 一份。
- 冷却期内再次收到 429：如果新退避时间更长，会延长计时器；当前调用方立即收到 `RATE_LIMIT_COOLDOWN` 错误，由上层决定是否重试。
- 429 的 `postProcess()` 最终抛出 `RATE_LIMIT_EXCEEDED`，让调用方知道需要重试。
- 插件不读取也不接管 DSH 的 `retryPolicy`；429 之后的重试仍由调用方或上层决定。

## 日配额（RPD）

- `rpd = 0` 表示不限制。
- 按 UTC 自然日重置（0 点）。
- 只在普通 2xx 响应后推进计数；429、失败响应和 202 轮询路径不计数。
- 达到 95% 时 `DualRateLimiter` 发出 `dailyQuotaWarning` 事件，`RateLimiterManager` 会转发；目前没有订阅者，也不会在面板上显示。
- 达到 100% 后下一次 `acquire()` 抛 `ERR_RPD_EXCEEDED`。

## Token 估算

默认使用启发式估算（`src/core/tokenEstimator.js`）：

| 内容 | 系数 |
| :--- | :--- |
| 中文字符 | 1.5 tokens/字 |
| 英文单词 | 0.3 tokens/词 |
| 标点（中英文） | 0.5 tokens/个 |
| 数字 | 0.5 tokens/个 |
| 代码块 | 每块 +10 |
| 每条消息格式开销 | +3 |
| `system` 消息 | 额外 +5 |

最终加上 `max_tokens`；该字段为 `undefined` 时按 `1024` 计算（传 `0` 则按 0 计算）。

可选的 `config/model_token_calibrations.json` 用于按模型修正估算：

```json
{
  "nvidia/nemotron": {
    "multiplier": 1.2,
    "offset": 0,
    "isPrefix": true,
    "lastCalibrated": "2026-11-13T12:00:00.000Z",
    "sampleCount": 12
  }
}
```

匹配顺序：精确模型 id → 带 `isPrefix` 的前缀 → 模型 id 的第一段（Provider 名）。

## 子限速

`probed_model_limits.json` 中的模型限制比主配置更严格时，会为该模型创建一个子 `DualRateLimiter`：

- 触发条件（任一）：探测 RPM > 0 且小于主 RPM；主 TPM > 0 且探测 TPM 更小；主 TPM 为 0 但探测 TPM > 0。
- 请求先通过子桶，再通过主桶；子桶不重复写入滑动窗口统计（`_skipMetrics`）。
- 子桶不使用独立 RPD（`rpd: 0`）。
- 主限速器 `updateConfig()` 会把退避策略、固定等待时间、免费模型开关传播给子桶，但保留子桶自己的 RPM/TPM。

文件结构：

```json
{
  "nvidia": {
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "rpm": 30,
      "tpm": 80000,
      "probedAt": "2026-11-13T12:00:00.000Z",
      "probedRpm": 32,
      "probedTpm": 90000,
      "confidence": 0.8
    }
  }
}
```

> 仓库里现有的探测数据包含 `probedAt: null`、`confidence: 0` 的预置条目，它们同样会被当作限制值使用；接入真实探测前请确认这些值是否符合预期。

## NVCF 202

`postProcess()` 收到 HTTP 202 时交给 `NVCFPoller`：

- 轮询地址取响应头 `nvcf-poll-url` 或响应体 `data.poll_url`；间隔取 `nvcf-poll-seconds` 或 `data.poll_seconds`，缺省 5 秒。没有轮询地址时直接返回原始 202 响应。
- 默认最多 60 次、总超时 5 分钟、单次请求 30 秒。
- 轮询请求带 `_skipRateLimit: true`，不会重复扣减 RPM/TPM。
- 202 继续轮询；429/5xx/网络错误视为可重试；400/401/403/404/409 立即返回错误。
- 成功响应会带上 `_polling: true`、`_pollAttempts`、`_pollCompleted: true` 等字段。

## RPC 与面板接口

### `smart-ratelimit.settings` 方法

`smart-ratelimit.settings`（面板使用的服务）暴露的方法：

| 方法 | 说明 |
| :--- | :--- |
| `getProviders()` | 返回发现并叠加手动新增、再排除手动移除后的 Provider 列表 |
| `getSettings(providerId)` | 当前生效配置、`priority`、`historySuggestion` |
| `saveSettings(providerId, config)` | 持久化并热更新限速器 |
| `applySuggestion(providerId)` | 应用历史建议 RPM/TPM |
| `clearHistory(providerId)` | 清空该 Provider 的 429 历史 |
| `getMonitorData(providerId)` | 队列长度、窗口 RPM/TPM、RPD、桶状态 |
| `getHistory(providerId)` | 原始历史记录 |
| `getProbeDefaults(providerId)` | 探测表单自动填充：模型列表、baseURL、apiKeyEnv、密钥是否可取到、`canAutoProbe` |
| `runProbe(providerId)` | 旧接口，保留兼容；实际探测走 `startProbe` |
| `addProvider({id, displayName, baseUrl})` | 新增自定义 Provider |
| `removeProvider(providerId)` | 移除本插件的 Provider 配置 |

### HTTP RPC

面板通过同源接口调用：

```text
POST /api/dsh-plugin-smart-ratelimit/rpc
Content-Type: application/json

{ "method": "getSettings", "args": ["nvidia"] }
```

响应：

```json
{ "ok": true, "value": { "...": "..." } }
{ "ok": false, "error": "unknown method: xxx" }
```

- 只接受 POST，其它方法返回 405。
- 请求体上限 64 KB。
- 未知方法返回 404。

### 设置面板

`src/ui/client.js` 通过 `window.__ModuleLoader__` 注册，React 由宿主提供，无需构建步骤；样式内联在 `client.js` 里。

- 菜单：设置 → 速率设置（section id `smart-ratelimit`，order 100）。
- Provider 下拉：显示 `displayName（id）`，默认选中列表第一项。
- 历史横幅：有 429 历史时显示触发时的 RPM/TPM、模型和建议上限；无历史时隐藏。
- 表单：RPM 数字输入框（1–10000）、TPM、RPD（仅 `nvidia` 显示）、退避策略、固定等待秒数、仅免费模型开关、优先级徽章；**启用开关已并入服务商栏**，形式为「已启用限速 / 未启用限速」文字胶囊 + 右侧迷你开关（hover 显示原说明）。
- 实时监控：每 5 秒拉取一次，显示排队数、近 1 分钟请求、近 1 分钟 Token、今日已用（`dailyLimit > 0` 时）。
- 操作：保存并生效、恢复默认、清空 429 历史、探测模型阈值（当前为占位）。「恢复默认」使用面板内置的 `nvidia` / `agnes` / `default` 三组数值，不读取 `default_presets.json`。
- 新增/删除 Provider：新增会写入 `__customProviders` 并创建默认限速器；删除会移除配置并写入 `__removedProviders`。

## 安装与挂载

这个项目按 tgz + pnpm 的方式挂载（profile 的 `package.json` 用 `file:` 指向本地包）：

1. 在插件仓库生成本地包：

```bash
npm pack
# 或
pnpm pack
```

2. 在 `~/.dsh/profiles/desktop/package.json` 中把插件加入依赖，并在现有的 `dsh.profile.bundles` 数组里追加包名（不要覆盖已有项）：

```json
{
  "dependencies": {
    "dsh-plugin-smart-ratelimit": "file:/absolute/path/dsh-plugin-smart-ratelimit-<version>.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-plugin-smart-ratelimit"
      ]
    }
  }
}
```

3. 安装并重启 DSH：

```bash
cd ~/.dsh/profiles/desktop
pnpm install
```

开发时也可以把依赖写成 `file:/absolute/path/dsh-plugin-smart-ratelimit`（源码目录），修改后重新安装并重启。示例里的 `<version>` 替换为实际版本号（见 `package.json`）。`cordis.patch.yml` 负责把 `smart-ratelimit` 插入 bundle；profile 的 `dsh.profile.bundles` 必须包含包名，否则插件不会加载。

## 开发与测试

```bash
npm test        # node:test：unit + integration，共 59 个用例
npm run smoke   # 离线模拟 Cordis 宿主和面板加载
npm run probe -- -p nvidia -m <model> -k "$NVIDIA_API_KEY"
```

测试会通过 `DSH_SMART_RATELIMIT_CONFIG_DIR` 指向临时目录，不会写入仓库的 `config/`。

`smoke-server.mjs` 和 `smoke-client.mjs` 里的模块路径是绝对路径，换机器或换工作区后需要先改这两个脚本；它们也没有被打进 npm 包（`package.json` 的 `files` 未包含）。

## 探测工具

`scripts/probeModels.mjs` 用真实请求探测模型的 RPM/TPM 边界：

| 参数 | 说明 |
| :--- | :--- |
| `-p, --provider <id>` | Provider id |
| `-m, --model <id>` | 模型 id |
| `-k, --api-key <key>` | API Key（必需） |
| `-u, --base-url <url>` | 覆盖基础 URL |
| `--max-rpm <n>` | 探测上限，默认 100 |
| `--step <n>` | RPM 步长，默认 5 |
| `--timeout <ms>` | 单次请求超时，默认 30000 |
| `--dry-run` | 只打印参数，不发请求 |
| `--update-settings` | 探测完成后把结果写入 `rate_limit_settings.json`（未在 help 中列出） |

```bash
node scripts/probeModels.mjs -p nvidia -m nvidia/nemotron-3-ultra-550b-a55b -k "$NVIDIA_API_KEY"
```

结果写入 `config/probed_model_limits.json`，字段为 `rpm/tpm/probedAt/probedRpm/probedTpm/confidence`。探测会真实发送请求，注意配额和费用。

注意：`probeModels.mjs` 固定使用仓库内的 `config/` 目录，不读取 `DSH_SMART_RATELIMIT_CONFIG_DIR`。如果运行时的配置目录不是仓库 `config/`，需要手动把探测结果复制过去。

## 已知问题与限制

以下是当前实现与设计意图之间已知的差距；修复其中一项后，请同步删除对应条目。

1. **没有自动拦截对话请求**：见上文「接入方式」；`llm-request` / `llm-response` 事件在当前 DSH 中不存在。
2. **普通请求会写入两次滑动窗口**：`RequestInterceptor.intercept()` 和 `DualRateLimiter.acquire()` 各记一次，监控 RPM/TPM 和 429 快照可能翻倍，建议值也会随之偏高。
3. **探测按钮是占位**：面板「探测模型阈值」只返回成功提示，不会真正调用 `probeModels.mjs`。
4. **`auto` 退避策略**：等价于 `exponential`，不会按 Provider 自动选择固定或指数退避。
5. **历史建议值的滚动窗口**：只保留最近 20 条，历史最低触发值可能被挤出，导致建议值回升。
6. **95% RPD 告警没有消费方**：只发出事件，不写日志、不显示在面板。
7. **RPD 输入框只对 `nvidia` 显示**：其它 Provider 只能通过配置文件设置 `rpd`。
8. **Provider 发现路径固定**：只读 `~/.dsh/profiles/desktop/cordis.patch.yml`，非 `desktop` profile 需要改代码。
9. **预置数据**：`rate_limit_429_history.json` 里有测试记录（`test-429-provider` 等），`probed_model_limits.json` 里有 `probedAt: null` 的预置值；接入真实环境前建议清理。
10. **面板无图标**：设置页菜单项只显示文字「速率设置」。
11. **保存后不刷新优先级徽章**：保存只刷新监控数据，徽章保持当前表单里的值，重新进入面板才会重新读取。
12. **`RateLimitSettingsView.css` 当前未被引用**：面板样式实际内联在 `client.js` 中。
13. **`llm/stream` 监听器被 Cordis isolate 过滤器丢弃**（2026-11-21 实证）：`Service` 基类自带 `[symbols.filter]`（isolate 桶匹配），服务实例作为 waterfall 的 `thisArg` 时启用过滤；本插件未 join `llm` 桶，监听器被静默跳过，对话流量从未进入限速器（监控全零、429 历史为空）。修复：注册时传 `{ global: true }`。完整证据链与改造路线图见 [docs/2026-11-21-runtime-analysis.md](docs/2026-11-21-runtime-analysis.md)。

## 排查

- 面板打不开或接口返回 404：检查配置目录下的 `route-status.json`：
  - `inject-pending`：`ctx.inject(['webServer'])` 尚未完成。
  - `inject-resolved`：注入回调已进入。
  - `ok: true`：`POST /api/dsh-plugin-smart-ratelimit/rpc` 已注册。
  - `ok: false`：注册失败，`error` 字段有原因。
- 日志关键字：`[SmartRateLimit]`。
- 接口 401：DSH Web 的同源认证未通过，确认从 GUI 页面发起请求。
- 限速看起来没生效：先确认调用方传了 `isFreeModel: true`（当 `applyToFreeModelsOnly` 为 true 时），再检查 `getMonitorData()` 的桶状态和队列长度。
- 配置目录确认：`DSH_SMART_RATELIMIT_CONFIG_DIR` 优先，否则为插件包内 `config/`。

## License

MIT
