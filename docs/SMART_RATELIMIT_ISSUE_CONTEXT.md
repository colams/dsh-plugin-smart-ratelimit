# smart-ratelimit 插件问题上下文整理

> 供插件源项目（`dsh-plugin-smart-ratelimit`）建 Issue / PR 时参考

---

## 📌 问题背景

**现象**：用户配置了 smart-ratelimit 插件，但遇到 429 限流时仍需人工干预，无法实现"慢慢完成、不需人守着"的预期。

**会话 ID**：`session-387433c8-09d9-4323-98bd-bc491274cd1f`

**用户期望**：
- 请求自动按安全频率排队（主动限速）
- 触发 429 后自动按固定策略重试（被动兜底）
- 全程无需人工点击"继续"

---

## 🔍 根因分析（三个层面）

### 1. **DSH 核心层：provider 级 `retryPolicy` 缺失**（最关键）

| Provider | `retryPolicy` 状态 | 实际重试行为 |
|----------|-------------------|-------------|
| `nvidia` | ✅ 配置了 | 20 次 / 固定 10s / 无抖动 |
| `agnes` | ✅ 配置了 | 同左 |
| `sensenova-me` | ✅ 配置了 | 同左 |
| `llm-deepseek-account` | ✅ 配置了 | 同左 |
| **`siliconflow`** | ❌ **未配置** | **默认 5 次 / 500ms 起步 / 10% 抖动** |
| **`opencode-go`** | ❌ **未配置** | **默认 5 次 / 500ms 起步 / 10% 抖动** |

> **AGENTS.md 明确警告**：`dsh-llm-retry 只执行每个 provider 自己声明的 retryPolicy，漏配不会报错，只会静默落回默认重试策略，限流时体验与全局策略不一致。`

**影响**：若会话使用了 `siliconflow` 或 `opencode-go` 的模型，429 触发后仅重试 5 次、间隔极短，根本扛不住限流，导致报错抛给用户 → 必须人工点击继续。

---

### 2. **插件层：smart-ratelimit 仅拦截流式请求**

**代码位置**：`src/index.js:162`
```javascript
this.ctx.on('llm/stream', (options, next) => { ... })  // 仅监听 waterfall 事件
```

| 请求类型 | DSH 事件 | 插件拦截？ |
|----------|----------|-----------|
| 流式（`stream: true`） | `llm/stream` | ✅ 生效 |
| 非流式（`stream: false`） | `llm/complete` | ❌ **完全不拦截** |

**影响**：非流式请求完全依赖 DSH 核心的 `retryPolicy` 兜底，插件的主动限速（令牌桶、排队、429 历史学习）全部失效。

---

### 3. **配置层：面板默认值过于激进 / 缺乏"保守模式"**

- 面板无"一键保守模式"，用户需手动填 RPM/TPM
- 新增 provider 无预设默认值，首次用极易触发 429
- 历史建议值依赖探测任务，冷启动无数据

---

## 🎯 期望行为 vs 现状

| 维度 | 期望行为 | 现状 | Gap |
|------|----------|------|-----|
| **主动限速** | 所有请求（流式+非流式）按配置 RPM/TPM 排队 | 仅流式请求 | 非流式完全裸奔 |
| **被动重试** | 所有 provider 统一 20次/10s 固定重试 | 两个 provider 缺配 → 5次/500ms | 兜底失效 |
| **冷启动保护** | 新 provider 自动应用保守默认值 | 无默认值，需手动配 | 易触发 429 |
| **429 后自愈** | 记录历史 → 自动降频 → 后续请求自动变慢 | 需手动点"应用建议值" | 不够自动化 |

---

## 💡 插件侧优化建议（按优先级）

### P0：拦截非流式请求（`llm/complete`）

```javascript
// src/index.js registerRequestInterceptor()
registerRequestInterceptor() {
  if (!this.ctx.on || typeof this.ctx.on !== 'function') return;

  // 现有：流式
  this.ctx.on('llm/stream', (options, next) => this._wrapStream(options, next));
  
  // 新增：非流式（complete 是普通事件，非 waterfall）
  this.ctx.on('llm/complete', (options) => this._wrapComplete(options));
}

async _wrapComplete(options) {
  // 复用 acquire / postProcess 逻辑
  const request = this._buildRateLimitRequest(options);
  let requestWithRatelimit = null;
  try {
    requestWithRatelimit = await this.interceptor.intercept(request);
  } catch (e) { /* 同流式容错 */ }
  
  // 调用原始 handler（需获取原始 complete 实现）
  const result = await this._callOriginalComplete(options);
  
  if (requestWithRatelimit) {
    const response = this._buildResponseFromCompleteResult(result);
    this.interceptor.postProcess(requestWithRatelimit, response).catch(...);
  }
  return result;
}
```

> **注意**：`llm/complete` 是普通广播事件，非 waterfall，签名为 `(options) => result`，包装方式与流式不同。

---

### P1：内置"保守模式"预设 & 冷启动默认值

- `config/default_presets.json` 增加 `conservative` 预设：`rpm: 20, tpm: 5000, rpd: 10000`
- `getDefaultConfig()` 返回保守预设而非空对象
- 面板新增"一键应用保守模式"按钮

---

### P2：429 后自动降频（无需手动点按钮）

```javascript
// requestInterceptor.js handle429() 内
async handle429(limiter, providerId, modelId, response, retryCount = 0) {
  // ... 现有逻辑 ...
  
  // 新增：自动应用建议值（带阈值防抖）
  const suggestion = historyTracker.getSuggestion(providerId);
  if (suggestion && suggestion.hasHistory) {
    const curr = limiter.config;
    const newRpm = suggestion.suggestedSafeRpm;
    const newTpm = suggestion.suggestedSafeTpm;
    // 仅当建议值显著更低时自动降频（避免抖动）
    if (newRpm < curr.rpm * 0.9 || newTpm < curr.tpm * 0.9) {
      limiter.updateConfig({ rpm: newRpm, tpm: newTpm });
      this.saveSettings(providerId, { rpm: newRpm, tpm: newTpm });
      console.log(`[SmartRateLimit] Auto-throttled ${providerId}: rpm ${curr.rpm}→${newRpm}, tpm ${curr.tpm}→${newTpm}`);
    }
  }
}
```

---

### P3：Provider 级 `retryPolicy` 缺失检测 & 提醒

插件启动时扫描 DSH 配置，发现 provider 无 `retryPolicy` 则：
- 控制台警告：`[SmartRateLimit] Provider "siliconflow" 缺失 retryPolicy，429 重试将用默认策略（5次/500ms），建议在 cordis.patch.yml 补全`
- 面板顶部显示黄色横幅提醒

---

### P4：非流式请求的取消信号透传

当前流式拦截支持 `options.signal`（AbortSignal），非流式包装需同步支持，避免用户取消对话时残留排队任务。

---

## 📂 涉及文件清单

| 文件 | 修改类型 |
|------|----------|
| `src/index.js` | P0: 注册 `llm/complete` 拦截；P3: 启动时扫描 retryPolicy |
| `src/intercept/requestInterceptor.js` | P0: 新增 `_wrapComplete()`；P2: `handle429()` 自动降频；P4: 取消信号支持 |
| `config/default_presets.json` | P1: 新增 `conservative` 预设 |
| `config/configMerger.js` | P1: `getDefaultConfig()` 返回保守默认值 |
| `src/ui/client.js` | P1: 面板加"一键保守模式"按钮；P3: 顶部提醒横幅 |

---

## 🧪 验证用例（建议加入测试）

| 场景 | 预期 |
|------|------|
| 发送非流式请求 → 触发 RPM 限速排队 | ✅ 请求在 acquire 阶段等待 |
| 非流式请求收到 429 → 记录历史 → 自动降频 | ✅ 后续请求自动变慢 |
| 新增无预设 provider → 面板显示保守默认值 | ✅ rpm=20, tpm=5000 |
| 启动时检测到 provider 缺 retryPolicy → 控制台警告 | ✅ 明确提示补全位置 |
| 用户取消对话（AbortSignal） → 排队任务取消 | ✅ 无残留等待 |

---

## 🔗 关联配置（用户侧 workaround）

用户当前可在 `~/.dsh/profiles/desktop/cordis.patch.yml` 补全缺失 `retryPolicy`：

```yaml
siliconflow:
  # ... 现有字段 ...
  retryPolicy:
    mode: normal
    maxRetries: 20
    retryableCodes: [RATE_LIMIT, TRANSPORT, STREAM_CLOSED, SERVER]
    backoff:
      initialDelayMs: 10000
      maxDelayMs: 10000
      jitterRatio: 0

opencode-go:
  # ... 现有字段 ...
  retryPolicy:
    mode: normal
    maxRetries: 20
    retryableCodes: [RATE_LIMIT, TRANSPORT, STREAM_CLOSED, SERVER]
    backoff:
      initialDelayMs: 10000
      maxDelayMs: 10000
      jitterRatio: 0
```

> 此配置修改后需重启 DSH 生效，**属于用户侧临时方案**，插件侧 P0/P1/P2 解决后可减少此类手动配置需求。

---

## 📝 总结

| 优先级 | 任务 | 价值 |
|--------|------|------|
| **P0** | 拦截 `llm/complete` 非流式请求 | 覆盖 100% 请求类型，主动限速全生效 |
| **P1** | 保守模式预设 + 冷启动默认值 | 新 provider 零配置也安全 |
| **P2** | 429 后自动降频 | 真正实现"无需人工干预" |
| **P3** | retryPolicy 缺失检测提醒 | 防止用户踩同坑 |
| **P4** | 取消信号透传 | 体验完善 |

**核心结论**：插件目前只解决了"流式请求主动限速"，但**非流式请求完全裸奔**，且**缺乏冷启动保护和自动降频**，导致用户在常见场景下仍需手动干预。建议按上述优先级迭代。