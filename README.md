> **文档命名**：`DSH 通用多提供商智能限速与容错插件规格书_2026-11-13.md`  
> **版本**：v2.1 (终极融合版·合并规格书)  
> **日期**：2026-11-13  
> **存放目录**：`/Users/user/Documents/Obsidian Vault/RateLimit/`  
> **代码工作区**：`dsh-plugin-smart-ratelimit/` / `dsh-plugin-universal-ratelimit/`  
> **适用范围**：DSH 桌面端及脚本/工具调用链路（重点针对免费档模型与无 `Retry-After` 响应头的 API 服务商）  
> **前端技术栈**：Vue 3 (Composition API)  
> **运行环境**：Node.js `>= 18.0.0`（原生 ES Modules，零外部生产依赖）

---

## 1. 需求融合与核心设计哲学

本插件将早期单提供商（NVIDIA / Agnes AI）的离散限速脚本升级为**通用型多提供商智能限流中心**，核心解决以下痛点：

1. **统一与差异并存**：不同 Provider 限额机制迥异（Agnes 免费档 20 RPM、NVIDIA 免费档官方 40 RPM、自托管无限制）。插件提供开箱即用的默认预设，同时支持通过探测脚本或实时 429 历史自动修正。
2. **双维度平滑流控（RPM + TPM）**：不仅限制每分钟请求数（RPM），同时引入每分钟 Token 消耗数（TPM）令牌桶，防止大上下文请求在未触发 RPM 时提前打爆服务端算力。
3. **闭环自学习（429 捕获 → 历史归档 → UI 智能提示）**：每次触发 `HTTP 429` 时，自动快照当时的瞬时 RPM/TPM 与所属 Provider/Model，写入本地历史库，并在设置界面的【速率设置】中直接给出推荐安全值。
4. **全链路闭环**：打通「自动配置读取 + Vue 3 速率设置面板 + 429 自动统计与历史提示 + RPM/TPM 双维度令牌桶 + 差异化退避策略」的完整链路。

---

## 2. 预设限额矩阵与配置优先级

### 2.1 配置加载优先级（由高到低）

1. **用户自定义覆盖配置**（用户在【速率设置】界面手动保存的值，持久化至 `rate_limit_settings.json`）
2. **自动探测与历史校准值**（`probeModels` 探测结果或历史 429 触发点安全扣减值）
3. **系统自动配置中已声明的速率参数**（若 DSH 配置中已包含）
4. **内置 Provider 默认规则**（针对免费模型预设，见下表）
5. **全局兜底策略**（默认 `60 RPM` / `TPM 不限制(0)`）

### 2.2 上游 Provider 限额基线与特殊约束（内置特征库）

| 维度 | **NVIDIA NIM** (`build.nvidia.com` / `integrate.api.nvidia.com`) | **Agnes AI** (`api.agnes-ai.cn`) | **通用默认** (`Other Providers`) |
| :--- | :--- | :--- | :--- |
| **插件默认 RPM** | **40 RPM**（官方免费档硬上限）<br>*(触发 429 后自动建议下调至 38)* | **20 RPM**（官方免费版硬上限一致） | **60 RPM**（可自定义） |
| **默认 TPM** | **默认不限制 (`0`)**，建议手动开启如 `100,000` | **40,000 TPM**（20K-80K 估算中值安全值） | **默认不限制 (`0`)**，支持自定义 |
| **配额计算维度** | **账户/API Key 全局共享**（所有模型共用一个桶，严禁按模型拆分） | **账户维度共享**（多 Key 不叠加；图片按分辨率独立计数） | 默认按 **Provider + API Key** 维度共享 |
| **日配额 (RPD)** | **10,000 次/天**（UTC 自然日重置，达 95% 告警，100% 熔断抛出 `ERR_RPD_EXCEEDED`） | 无日次数硬上限（免费版高峰期动态降级） | 无日次数硬上限 |
| **429 响应特征** | **缺失 `Retry-After` 头**，无 `X-RateLimit-*` 头 | 429 响应体标注限制类型，可能缺失 `Retry-After` | 优先读取 `Retry-After` 头 |
| **429 退避策略** | 清空令牌桶 + **固定退避 15s + 0~3s 随机抖动**（避免指数退避过短或过长） | 清空令牌桶 + **指数退避 [1, 2, 4, 8, 16]s + ±20% 抖动** | 优先 `Retry-After`，否则指数退避 |

> **注**：针对非免费订阅套餐（如 Agnes Agent Plan Lite/Plus/Pro/Max 对应的 60/100/200/500 RPM），插件支持在配置中一键切换档位或由用户直接输入目标数值。

---

## 3. 核心限速算法设计（RPM + TPM 双令牌桶）

为彻底避免并发突发导致的瞬间 429 风暴，客户端在发出任何请求前，**必须依次通过**两级平滑令牌桶与日配额熔断器：

```text
请求进入 (携带 providerId, modelId, messages)
  │
  ├─► [1. 日配额熔断器 (RPD)] ──► 若今日已用 ≥ RPD 上限 (如 NVIDIA 10,000) ──► 直接抛出 ERR_RPD_EXCEEDED
  │
  ├─► [2. 预估本次 Token 消耗] ──► estTokens = 字符数估算(messages) + (max_tokens || 1024)
  │
  ├─► [3. TPM 令牌桶排队] ──────► 桶内剩余 Token >= estTokens 才扣减并放行，否则 FIFO 异步排队等待补充
  │
  ├─► [4. RPM 令牌桶排队] ──────► 桶内剩余请求令牌 >= 1 才扣减并放行 (匀速间隔 = 60,000ms / RPM)
  │
  └─► [5. 发起真实 HTTP 请求]
        ├─► HTTP 200: 记录实际消耗的 usage.total_tokens，多退少补修正 TPM 桶水位
        ├─► HTTP 202 (NVCF 异步): 按 NVCF-POLL-SECONDS 轮询结果（轮询请求不重复扣减 RPM/TPM）
        └─► HTTP 429: 触发惩罚与自学习状态机
```

### 3.1 令牌桶防突发机制

* **匀速整形（Smooth Shaping）**：为防止在每分钟第 0 秒瞬间打出全部配额导致网关拒收，默认采用连续补充算法（`refillRatePerMs = limit / 60000`），且初始突发容量默认限制为 `Math.max(1, Math.floor(limit * 0.2))`（可通过配置开启全量突发）。
* **TPM 精准核算（预扣 + 结算）**：
  * **请求前预扣**：按 `中文约 1.5 tokens/字、英文约 0.3 tokens/词` 估算输入长度，加上 `max_tokens`（未指定时默认按 `1024` 预扣）。
  * **响应后结算**：若响应体返回了真实的 `usage.total_tokens`，自动计算差值 `diff = actualTokens - estimatedTokens` 并返还（或补扣）至 TPM 桶中，确保长时间运行无累计误差。

### 3.2 请求放行与 Token 预估/校准闭环（完美解决响应 Token 未知问题）

由于发起请求前无法精确得知 AI 回复的 `completion_tokens`，采用**「预估预扣 + 响应校准」**两阶段算法：

```text
[请求到达]
   │
   ├─► 1. 估算本次请求 Token 消耗:
   │      estimatedTokens = 字符数估算(messages) + (payload.max_tokens || 1024)
   │
   ├─► 2. 进入异步 FIFO 排队队列 (单定时器顺序唤醒，严禁并发抢锁):
   │      同时满足: (rpmTokens >= 1) AND (tpmTokens >= estimatedTokens)
   │      若不满足，计算最大等待时间:
   │      waitMs = Math.max(
   │        (1 - rpmTokens) / rpmRefillRatePerMs,
   │        (estimatedTokens - tpmTokens) / tpmRefillRatePerMs
   │      )
   │      休眠 waitMs 后唤醒队首。
   │
   ├─► 3. 放行瞬间扣减:
   │      rpmTokens -= 1
   │      tpmTokens -= estimatedTokens
   │      滑动窗口记录时间戳与预估 Token 数
   │
   └─► 4. 收到服务端响应 (response.usage):
          actualTokens = usage.total_tokens
          diff = actualTokens - estimatedTokens
          tpmTokens = Math.max(0, Math.min(tpmCapacity, tpmTokens - diff)) // 多退少补
```

---

## 4. 429 统计与历史自学习机制

当任意请求收到 `HTTP 429 Too Many Requests` 时，插件立即执行以下动作：

### 4.1 瞬时流量快照统计

* 滑动窗口统计**过去 60 秒内**该 `providerId`（及具体 `modelId`）实际已发出的请求总数（`actualRpmAt429`）与已消耗 Token 总数（`actualTpmAt429`）。

### 4.2 双桶立即清空惩罚 (`penalizeOn429()`)

* 将对应 Provider 的 RPM 桶与 TPM 桶余额瞬间归零，重置补充时间戳，强制后续所有排队请求进入完整冷却期，杜绝「雪崩重试」。

### 4.3 持久化写入历史记录 (`config/rate_limit_429_history.json`)

```json
{
  "nvidia": {
    "lastTriggeredAt": "2026-11-13T14:25:10.000Z",
    "triggeredAtRpm": 41,
    "triggeredAtTpm": 18420,
    "model": "nvidia/nemotron-3-ultra-550b-a55b",
    "suggestedSafeRpm": 38,
    "suggestedSafeTpm": 16500,
    "total429Count": 3
  },
  "agnes": {
    "lastTriggeredAt": "2026-11-13T07:04:22.000Z",
    "triggeredAtRpm": 21,
    "triggeredAtTpm": 48200,
    "model": "agnes-vision-3k",
    "suggestedSafeRpm": 18,
    "suggestedSafeTpm": 42000,
    "total429Count": 1
  }
}
```

* **安全值推算公式**：`suggestedSafeRpm = Math.max(1, Math.floor(minTriggeredRpm * 0.9))`（在历史最低触发 429 的频率基础上预留 10% 安全缓冲）。
* 保留每个 Provider 最近 20 条记录及历史最低触发阈值。

---

## 5. 前端交互与设置界面规范（【速率设置】）

插件通过 DSH 前端扩展机制（Cordis / 桌面端设置注入），在系统设置左侧导航栏注册独立菜单项：

### 5.1 左侧菜单入口

* **菜单名称**：`速率设置`（图标：`Gauge` / `Speedometer` / `speedometer`）
* **加载行为**：每次用户点击打开【速率设置】面板时，动态调用 DSH 配置接口读取当前系统中所有已配置的 Providers 列表（例如读取 `cordis.patch.yml` 中的 `llm-pi-ai` 配置节点）。

### 5.2 面板控件与交互逻辑 (Vue 3 组件 `RateLimitSettingsView.vue`)

1. **Provider 下拉选择器**：
   * **显示名称**：严格使用系统配置中为该 Provider 设置的**显示名（Display Name）**（例如“NVIDIA NIM”、“Agnes AI 官方站”），并在右侧附带小标签展示其底层 ID（如 `nvidia`、`agnes`）。
   * **默认选中**：默认选中当前正在使用的主 Provider，或列表第一项。
   * **挂载钩子**：`onMounted` 自动调用后端方法加载系统已配置的全部 Provider 列表。

2. **智能历史提示横幅（条件渲染 `v-if="historyRecord"`）**：
   * **有 429 历史记录时**：在表单顶部展示醒目的提示卡片：
     > ⚠️ **历史限流预警**：该服务商曾在 **41 RPM / 18,420 TPM**（模型 `nemotron-3-ultra`）时触发 `429` 错误。建议将安全上限调整为 **≤ 38 RPM**（[点击一键应用建议值]）。
   * **无 429 历史记录时**：**完全隐藏该提示区域**，保持界面清爽，不干扰用户。

3. **核心限速参数表单 (`v-model` 双向绑定)**：
   * **启用限速控制**：开关（默认开启，勾选“仅对免费档模型生效”或“全量模型生效”）。
   * **每分钟最大请求数 (RPM)**：数字输入（必填，默认 `nvidia=40`、`agnes=20`，支持输入 `1 ~ 10000`）。
   * **每分钟最大 Token 数 (TPM)**：数字输入（选填，`0` 表示不限制，默认 `agnes=40000`、`nvidia=0`，逻辑与 RPM 同步生效）。
   * **429 退避策略**：下拉选择（`自动适配（推荐）` / `固定等待 15s + 抖动` / `指数退避`）。
   * **固定退避等待时间 (秒)**：默认 `15` 秒（NVIDIA 推荐）或 `60` 秒（批处理模式）。
   * **配置优先级状态徽章**：只读展示当前生效来源（`系统自动读取配置` / `用户自定义配置` / `默认预设` / `历史校准值`）。

4. **实时监控状态栏（轮询 / SSE 订阅）**：
   * 展示当前选中 Provider 的实时水位：`当前排队请求数: 0` | `近1分钟请求: 12 / 60 RPM` | `近1分钟消耗: 4,200 TPM`（若为 NVIDIA 额外显示 `今日已用: 340 / 10,000 RPD`）。

5. **操作按钮**：
   * **保存并立即生效**：持久化至 `rate_limit_settings.json` 并热更新内存中对应 `DualRateLimiter` 实例的容量与速率，无需重启 DSH。
   * **恢复默认预设**：重置为该 Provider 的默认规则。
   * **清空该服务商 429 历史记录**：清除 `rate_limit_429_history.json` 中对应条目。
   * **运行模型阈值探测**：可直接在后台触发 `probeModels` 探测当前 Provider 下的模型真实极限。

---

## 6. 插件目录结构与模块契约

遵循 DSH 插件规范，零外部生产依赖（仅使用 Node.js `>= 18` 内置模块与 DSH 宿主 Vue 3 上下文）：

### 6.1 推荐统一目录结构

```text
dsh-plugin-smart-ratelimit/          # 或 dsh-plugin-universal-ratelimit/
├── package.json                      # 插件元数据与 DSH 挂载声明 (ESM 模块)
├── cordis.patch.yml                  # 自动挂载至 DSH desktop profile
├── config/
│   ├── rate_limit_settings.json      # 用户自定义的各 Provider RPM/TPM 持久化配置
│   ├── rate_limit_429_history.json   # 429 触发历史记录与峰值统计数据库
│   ├── default_presets.json          # 内置免费模型默认限额 (nvidia: 40, agnes: 20)
│   └── probed_model_limits.json      # 自动探测产出的单模型实测限额表
├── src/
│   ├── index.js                      # Cordis 插件主入口（注册设置菜单、拦截器与 RPC 接口）
│   ├── providerDiscovery.js          # 自动读取系统配置，解析所有 Provider 及其显示名
│   ├── dualRateLimiter.js            # 核心引擎：RPM + TPM 双维度令牌桶与 FIFO 队列
│   ├── metricsTracker.js             # 60s 滑动窗口实时统计器 & 429 历史记录器
│   ├── requestInterceptor.js         # 统一请求包装器（排队 -> 预扣Token -> 校准 -> 429退避）
│   ├── historyTracker.js             # 别名/兼容层：滑动窗口统计、429 快照记录与安全值推荐算法
│   ├── smartClient.js                # 别名/兼容层：拦截/封装请求、Pre-check 预扣、Post-check Token 结算、退避重试
│   └── ui/
│       └── RateLimitSettingsView.vue # 【速率设置】Vue 3 单文件组件（动态加载 Providers 下拉、历史提示横幅）
├── scripts/
│   └── probeModels.mjs               # CLI 自动化探测脚本（支持 NVIDIA/Agnes 等所有兼容端点）
└── test/
    └── dualRateLimiter.test.js       # 基于 node:test 的 RPM/TPM 匀速、结算、429 统计、配置热重载单元测试
```

### 6.2 模块职责映射

| 模块文件 | 核心职责 | 对应规格章节 |
| :--- | :--- | :--- |
| `providerDiscovery.js` | 自动扫描 DSH 配置，提取 Provider 列表与显示名 | §2.1, §5.1 |
| `dualRateLimiter.js` | 双令牌桶核心引擎（RPM+TPM、FIFO队列、RPD熔断、热更新） | §3, §3.1, §3.2 |
| `metricsTracker.js` / `historyTracker.js` | 滑动窗口统计、429 快照记录、安全值推荐、历史持久化 | §4 |
| `requestInterceptor.js` / `smartClient.js` | 请求拦截管线、预扣/结算、退避重试、NVCF 轮询适配 | §3, §4.2, §7 |
| `RateLimitSettingsView.vue` | Vue 3 设置面板组件（下拉、历史提示、表单、实时监控、操作按钮） | §5 |
| `probeModels.mjs` | 可选 CLI 探测工具，实测模型真实 429 边界 | §2.1, §5.2 |

---

## 7. 架构对接与防冲突声明

### 7.1 与 DSH 全局 `retryPolicy` 的协同

* 在 `~/.dsh/AGENTS.md` 中明确约定：当本插件处于激活状态时，请求排队与 `429` 冷却由本插件接管；若插件未启用或仅在纯对话链路运行，则回退至 `cordis.patch.yml` 中配置的底层 `retryPolicy`。
* 插件应在 `cordis.patch.yml` 中为各 Provider 声明 `retryPolicy`（如 `RATE_LIMIT` / `TRANSPORT` / `STREAM_CLOSED` / `SERVER`），确保全局重试策略一致。

### 7.2 多模型共享与单模型子限速

* 同一 API Key 下所有模型默认共享该 Provider 的主令牌桶（防止多模型并发叠加超限）。
* 若 `probed_model_limits.json` 中记录了某特定大模型（如 550B 参数模型或 Agnes 3K/4K 图像模型）的实测极限低于主桶上限，自动为其挂载独立的子令牌桶，执行**双重令牌校验**。

### 7.3 安装与挂载步骤

```bash
# 1. 软链接插件至 DSH profile 目录
ln -s /path/to/dsh-plugin-smart-ratelimit ~/.dsh/profiles/desktop/node_modules/dsh-plugin-smart-ratelimit

# 2. 在 ~/.dsh/profiles/desktop/cordis.patch.yml 中声明加载
# - insert:
#     - id: smart-ratelimit
#       name: dsh-plugin-smart-ratelimit
```

---

## 8. 验收测试矩阵

| 测试用例 | 验证目标 | 预期通过标准 |
| :--- | :--- | :--- |
| **T1: 动态发现与默认值** | 验证配置发现、默认值兜底 | 打开【速率设置】Vue 3 下拉框，正确显示系统配置的所有 Provider `displayName`；未修改时 `nvidia` 显示 `40 RPM`，`agnes` 显示 `20 RPM`。 |
| **T2: RPM + TPM 双桶整形** | 验证双维度限速、预扣/结算 | 设定 `RPM=60, TPM=1000`，连续发送 2 个预估 `800 Token` 的请求：第 1 个立即放行，第 2 个自动排队等待约 `36 秒` 攒够 Token 后放行，不触发远程 429。 |
| **T3: 429 统计与 UI 历史提示** | 验证自动统计、历史提示 | 模拟某 Provider 在第 21 次请求时返回 `429`；打开【速率设置】选中该 Provider，页面明确提示「曾在 21 RPM 触发 429」；切换至未报错的 Provider，提示条完全隐藏。 |
| **T4: 热更新与桶清空惩罚** | 验证配置热重载、429 惩罚 | 修改设置保存后，新速率立即生效；收到 429 后剩余令牌瞬间归零，后续并发请求乖乖进入冷却队列。 |
| **T5: RPD 日配额熔断** | 验证 NVIDIA 10,000/天限制 | 模拟累计请求达 9,500 触发告警，达 10,000 抛出 `ERR_RPD_EXCEEDED` 熔断。 |
| **T6: 多模型子限速** | 验证单模型独立桶 | 配置主桶 60 RPM，特定模型实测 30 RPM 触发 429；该模型后续请求受限于 30 RPM，其他模型仍受主桶 60 RPM 约束。 |
| **T7: NVCF 异步轮询** | 验证 202 响应处理 | NVCF 返回 202 时按 `NVCF-POLL-SECONDS` 轮询，轮询请求不重复扣减 RPM/TPM 配额。 |

---

## 9. 版本差异对照表（合并说明）

本文档融合了两份源文档，主要差异已按以下原则统一：

| 差异点 | 文档 1 (规格书) | 文档 2 (技术规范) | **合并版统一结论** |
| :--- | :--- | :--- | :--- |
| **NVIDIA 默认 RPM** | 40 | 60 (文档中后文又提到官方 40) | **40**（遵循官方免费档硬上限） |
| **Agnes 默认 RPM** | 20 | 20 | **20**（一致） |
| **NVIDIA 默认 TPM** | 100,000 | 0 (不限制) | **0 (不限制)**，文档建议手动开启 100,000 |
| **Agnes 默认 TPM** | 40,000 | 40,000 | **40,000**（一致） |
| **配置优先级层数** | 4 层 | 3 层 | **5 层**（增加系统自动配置层） |
| **历史文件路径** | `~/.dsh/ratelimit_history.json` | `config/rate_limit_429_history.json` | **`config/rate_limit_429_history.json`**（插件内配置目录） |
| **设置文件路径** | 隐含在配置中 | `config/rate_limit_settings.json` | **`config/rate_limit_settings.json`** |
| **前端组件名** | `RateLimitSettings.vue` | `RateLimitSettingsView.vue` | **`RateLimitSettingsView.vue`** |
| **入口文件导出** | Cordis 插件标准 | Cordis 插件标准 | **一致** |
| **测试框架** | `node:test` | `node:test` | **一致** |

---

> **文档状态**：终极融合版规格书，Ready for Implementation。  
> **维护建议**：后续代码实现请以本文档为唯一权威来源；如发现与实现不符，优先更新本文档再同步代码。