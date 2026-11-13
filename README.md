# dsh-plugin-smart-ratelimit

DSH 桌面端的智能限速插件。为不同 Provider 分别设置 RPM / TPM 上限，自动排队请求、记录 429、给出安全值建议，并在「设置 → 速率设置」里提供可视化配置。

> 本文档是**使用指南**，讲安装、配置和接入。实现细节、目录结构、算法和已知问题见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

> **注意**：当前版本不会自动拦截 DSH 的对话请求。装好后还需要在调用方（插件或脚本）里显式使用 `smart-ratelimit` 服务或 HTTP RPC，限速才会生效；具体写法见「通过代码接入」。

## 能做什么

- 给 NVIDIA、Agnes 或其他 Provider 设置每分钟请求数（RPM）和每分钟 Token 数（TPM）上限。
- 超限请求自动排队，而不是立刻失败。
- 记录 429 触发的瞬时流量，按历史最低值推荐更安全的上限。
- 按 UTC 自然日限制每日请求数（RPD）。
- 为某个模型单独设置更严格的限额（基于探测结果）。
- 在面板里查看当前排队数、近 1 分钟请求/Token、今日已用。

## 环境要求

- DSH 桌面端
- Node.js `>= 18`
- profile 目录（默认 `~/.dsh/profiles/desktop`）使用 pnpm 管理依赖

## 安装

### 方式一：tgz + pnpm（推荐）

1. 在插件仓库生成包：

```bash
cd /path/to/dsh-plugin-smart-ratelimit
npm pack
# 或 pnpm pack
```

会生成 `dsh-plugin-smart-ratelimit-<version>.tgz`。

2. 编辑 `~/.dsh/profiles/desktop/package.json`：把包加入依赖，并在现有 `dsh.profile.bundles` 数组末尾追加包名。

```json
{
  "dependencies": {
    "dsh-plugin-smart-ratelimit": "file:/absolute/path/dsh-plugin-smart-ratelimit-<version>.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...保留原有项...",
        "dsh-plugin-smart-ratelimit"
      ]
    }
  }
}
```

3. 安装依赖：

```bash
cd ~/.dsh/profiles/desktop
pnpm install
```

4. 重启 DSH。

### 方式二：源码目录（开发）

把依赖改成源码目录，修改代码后重新安装并重启：

```json
{
  "dependencies": {
    "dsh-plugin-smart-ratelimit": "file:/absolute/path/dsh-plugin-smart-ratelimit"
  }
}
```

```bash
cd ~/.dsh/profiles/desktop
pnpm install
```

### 验证是否加载

- 打开「设置」，左侧应出现「速率设置」。
- 查看配置目录下的 `route-status.json`：`ok: true` 表示 RPC 路由注册成功。
- DSH 日志中应有 `[SmartRateLimit]` 开头的输出。

## 使用设置面板

### 打开

DSH 设置 → 左侧「速率设置」。

### 选择 Provider

顶部下拉列出 DSH 当前配置的 Provider（显示为 `显示名（id）`），默认选中第一项。

- 「新增」可以添加不在 DSH 配置里的 Provider，只用于本插件限速，不会修改 DSH 的模型配置。
- 「删除」会移除该 Provider 在本插件里的限速配置，并让它在后续发现中保持隐藏。

### 设置限额

| 控件 | 说明 |
| :--- | :--- |
| 启用限速控制 | 关闭后该 Provider 的请求直接放行 |
| 每分钟最大请求数（RPM） | 1–10000，滑块调整；免费档建议 NVIDIA 40、Agnes 20 |
| 每分钟最大 Token 数（TPM） | 0 表示不限制；建议 Agnes 40000，NVIDIA 可按需设置 |
| 每日请求配额（RPD） | 仅 `nvidia` 显示；0 表示不限制，按 UTC 0 点重置 |
| 429 退避策略 | 自动适配 / 固定 15s + 抖动 / 指数退避；当前「自动适配」与指数退避等价 |
| 固定退避等待时间 | 仅选择「固定」时显示，单位秒 |
| 仅对免费档模型生效 | 开启后只有 `isFreeModel: true` 的请求受限 |
| 配置优先级 | 只读徽章，显示当前配置来自用户自定义、历史校准、系统自动、默认预设还是全局兜底 |

### 保存

点「保存并生效」后立即热更新，不需要重启 DSH。保存会保留当天已用的 RPD 计数和滑动窗口统计。

### 其他操作

- **恢复默认**：把表单恢复为内置的 `nvidia` / `agnes` / `default` 三组预设值并保存。
- **一键应用建议值**：历史横幅出现时可用，把建议的 RPM/TPM 写入配置并立即生效。
- **清空 429 历史**：删除该 Provider 的历史记录和建议值。
- **探测模型阈值**：当前是占位按钮，不会真的探测；请用命令行工具（见下文）。

## 历史限流提示

当某个 Provider 触发过 429，面板顶部会出现警示条：

> 曾在 41 RPM / 18,420 TPM（模型 xxx）触发 429。建议安全上限 ≤ 36 RPM / 16,578 TPM。

- 安全值按历史窗口内最低触发值 × 0.9 计算。
- 点「一键应用建议值」会把建议写入配置。
- 点「暂不调整」只隐藏本次提示，不修改配置。
- 没有历史记录时，整个提示区域不显示。

## 实时监控

面板底部每 5 秒刷新一次：

| 指标 | 含义 |
| :--- | :--- |
| 排队请求 | 当前在限速队列里等待的请求数 |
| 近 1 分钟请求 | 60 秒滑动窗口内的请求数 / RPM 上限 |
| 近 1 分钟消耗 | 60 秒滑动窗口内的预估 Token 数 / TPM 上限（TPM 上限为 0 时不显示进度条） |
| 今日已用 | 当日 RPD 已用 / 上限（上限为 0 时不显示） |

> 当前实现里一次请求会写入两次滑动窗口，因此监控数值可能约为实际值的 2 倍；详见 [IMPLEMENTATION.md](IMPLEMENTATION.md) 的「已知问题与限制」。

## 通过代码接入

### 方式一：Cordis 服务（推荐）

```js
const ratelimit = ctx.get('smart-ratelimit')

const request = await ratelimit.acquire({
  providerId: 'nvidia',
  modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages,
  max_tokens: 1024,
  isFreeModel: true,
})

const response = await sendToProvider(request)

// 202 时返回轮询后的最终响应；429 时抛 RATE_LIMIT_EXCEEDED
const finalResponse = await ratelimit.release(request, response)
```

`acquire()` 返回带 `_ratelimit` 标记的请求对象，`release()` 必须接收同一个对象，否则会跳过 Token 结算。

### 方式二：HTTP RPC

面板用的接口也可以直接调用（需要从 DSH Web 同源页面发起）：

```js
const res = await fetch('/api/dsh-plugin-smart-ratelimit/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'getMonitorData', args: ['nvidia'] }),
})
const payload = await res.json()
// { ok: true, value: {...} } 或 { ok: false, error: '...' }
```

常用方法：

| 方法 | 用途 |
| :--- | :--- |
| `getProviders` | 获取 Provider 列表 |
| `getSettings` / `saveSettings` | 读取 / 保存某个 Provider 的配置 |
| `applySuggestion` | 应用历史建议值 |
| `clearHistory` | 清空 429 历史 |
| `getMonitorData` | 获取实时水位 |
| `getHistory` | 获取原始历史记录 |
| `addProvider` / `removeProvider` | 新增 / 删除 Provider |
| `runProbe` | 占位，当前不会真正探测 |

### `isFreeModel` 很重要

内置的 `nvidia` / `agnes` 预设默认开启「仅对免费档模型生效」。如果你调用 `acquire()` 时没有传 `isFreeModel: true`，请求会被直接放行，限速完全不生效。

希望所有请求都受限时，二选一：

```js
await ratelimit.acquire({ providerId, modelId, messages, isFreeModel: true })
```

或在面板里关闭「仅对免费档模型生效」。

### 429 与重试

- `release()` 收到 429 时会清空该 Provider 的令牌桶、记录历史并等待冷却，然后抛出 `RATE_LIMIT_EXCEEDED`。
- 冷却期内同一 Provider 再次出现 429，会立即抛 `RATE_LIMIT_COOLDOWN`；这表示当前请求应稍后重试，而不是继续等待。
- 重试策略由调用方决定；插件不接管 DSH 的 `retryPolicy`。

### NVCF 202

`release()` 收到 HTTP 202 时会自动轮询，返回轮询后的最终响应；轮询请求不会重复扣减 RPM/TPM。默认最多 60 次、总超时 5 分钟。

## 手动编辑配置

面板能改大部分内容，批量修改或迁移时可以直接编辑文件。默认配置目录是插件包内的 `config/`；如果设置了环境变量 `DSH_SMART_RATELIMIT_CONFIG_DIR`，则读写该目录。

| 文件 | 内容 |
| :--- | :--- |
| `rate_limit_settings.json` | 用户配置（最高优先级） |
| `rate_limit_429_history.json` | 429 历史与建议值 |
| `probed_model_limits.json` | 单模型探测结果，用于子限速 |
| `default_presets.json` | 内置 Provider 默认值，一般不需要改 |

`rate_limit_settings.json` 示例：

```json
{
  "nvidia": {
    "rpm": 38,
    "tpm": 100000,
    "rpd": 10000,
    "enabled": true,
    "applyToFreeModelsOnly": true,
    "backoffStrategy": "fixed",
    "fixedBackoffSeconds": 15
  }
}
```

- 手动改文件后需要重启 DSH（或对相应 Provider 在面板里保存一次）才会加载。
- `priority` 字段由插件维护，手动写没有意义。
- 配置优先级（从低到高）：全局兜底 → 内置预设 → DSH 系统配置 → 历史/探测校准 → 用户配置。
- 历史校准会在插件启动时参与合并；如果不想被自动下调，把目标值明确写进 `rate_limit_settings.json`。

## 探测模型阈值

面板上的探测按钮暂不可用，用命令行：

```bash
node scripts/probeModels.mjs \
  -p nvidia \
  -m nvidia/nemotron-3-ultra-550b-a55b \
  -k "$NVIDIA_API_KEY"
```

常用参数：

| 参数 | 说明 |
| :--- | :--- |
| `-p, --provider` | Provider id |
| `-m, --model` | 模型 id |
| `-k, --api-key` | API Key |
| `-u, --base-url` | 覆盖 API 地址 |
| `--max-rpm` | 探测上限，默认 100 |
| `--step` | 步长，默认 5 |
| `--timeout` | 单次请求超时毫秒，默认 30000 |
| `--dry-run` | 不发请求，只打印参数 |
| `--update-settings` | 把结果同时写入 `rate_limit_settings.json` |

结果写入 `config/probed_model_limits.json`。探测会真实请求服务商，注意配额和费用。

> 探测脚本固定使用仓库里的 `config/` 目录，不读取 `DSH_SMART_RATELIMIT_CONFIG_DIR`。如果运行时用的是其他配置目录，需要手动复制结果。

## 开发与测试

```bash
npm test        # node:test，59 个用例
npm run smoke   # 离线模拟 Cordis 宿主与面板加载
npm run probe -- -p nvidia -m <model> -k "$NVIDIA_API_KEY"
```

测试使用临时配置目录（`DSH_SMART_RATELIMIT_CONFIG_DIR`），不会修改仓库的 `config/`。

`smoke-server.mjs` 和 `smoke-client.mjs` 里写的是绝对路径，换机器或换工作区后需要先改脚本。

## 常见问题

**面板打不开或接口 404**

查看配置目录下的 `route-status.json`：

- `inject-pending`：`webServer` 服务还没就绪；
- `ok: true`：RPC 路由已注册；
- `ok: false`：注册失败，`error` 里有原因。

**接口返回 401**

DSH Web 有同源认证，必须在 GUI 页面上下文里调用，不能直接用 curl 从终端访问。

**设置限速后没有效果**

按顺序检查：

1. 调用方是否真的经过了 `smart-ratelimit` 服务？当前版本不会自动拦截对话请求。
2. 是否开启了「仅对免费档模型生效」但没传 `isFreeModel: true`？
3. 该 Provider 的「启用限速控制」是否打开？
4. 监控里的排队数和 RPM 是否在变化？

**429 之后一直失败**

如果错误是 `RATE_LIMIT_COOLDOWN`，说明该 Provider 正在冷却期（同一次 429 风暴中的并发请求）。让上层稍后重试；插件会在冷却结束后恢复。

**历史建议值自己变高了**

历史只保留最近 20 条记录，最早的最低触发值被挤出后，建议值可能回升。需要稳定上限时，直接写入 `rate_limit_settings.json`。

**点了「探测模型阈值」没反应**

按钮当前是占位实现，请用上面的 CLI 命令。

**保存后需要重启吗**

面板保存会立即热更新。手动编辑配置文件或修改探测结果后，需要重启 DSH，或对相应 Provider 在面板里再保存一次。

**怎么彻底删除某个 Provider 的限速配置**

面板里选中它后点「删除」。这会移除配置并写入 `__removedProviders`，重启后不会重新出现；再次新增同名 Provider 可以恢复。

## 已知限制

- 面板的探测按钮是占位。
- 「自动适配」退避策略当前等价于指数退避。
- 95% RPD 告警只发出事件，没有 UI 提示。
- Provider 发现只读取 `~/.dsh/profiles/desktop/cordis.patch.yml`。
- 配置目录里有测试/预置数据，接入真实环境前建议清理。

更完整的说明见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

## License

MIT
