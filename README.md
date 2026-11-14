# DSH Smart Rate Limit Plugin

为 DeepSeek Harness (DSH) 提供智能限速的 Cordis 插件：RPM/TPM 双维度令牌桶、RPD 日配额熔断、429 历史校准、流式请求自动拦截。

## 功能特性

- **双维度限速**：RPM (请求/分) + TPM (Token/分) 平滑令牌桶，防突发、匀速整形
- **RPD 熔断**：NVIDIA 免费档每日 10000 次硬性限制，UTC 自然日重置
- **子限速器**：针对特定模型更严格的探测值自动创建独立限速器
- **FIFO + 优先级队列**：免费模型低优先级，付费/高配额模型可直通
- **429 退避**：provider 级冷却门（并发 429 共享退避），支持 Retry-After、固定、指数退避
- **历史校准**：记录 429 触发点，自动计算安全建议值（最低触发点 × 0.9）
- **流式拦截**：挂接 DSH `llm/stream` 钩子，普通对话自动经过限速器
- **实时监控**：面板显示队列长度、滑动窗口 RPM/TPM、日配额用量、进度条
- **多层配置优先级**：用户自定义 > 历史校准 > 系统自动 > 默认预设 > 全局兜底

## 安装

```bash
# 在 DSH 插件目录下
git clone <this-repo> dsh-plugin-smart-ratelimit
cd dsh-plugin-smart-ratelimit
pnpm install
```

重启 DSH，Settings 页面底部会出现「速率设置」菜单。

## 快速上手

1. 打开 Settings → 速率设置
2. 选择服务商（如 NVIDIA、Agnes）
3. 调整 RPM/TPM/RPD、退避策略
4. 点击「保存并生效」——热更新立即生效，无需重启

**NVIDIA 免费档建议值**：
- RPM: 40
- TPM: 0 (不限制) 或 100000
- RPD: 10000 (硬性日限额)
- 退避: 固定 15s + 抖动
- 仅免费档生效: 开启

**Agnes 免费档建议值**：
- RPM: 20
- TPM: 40000
- RPD: 0
- 退避: 指数退避
- 仅免费档生效: 开启

## 配置说明

| 参数 | 说明 | 推荐值 |
|------|------|--------|
| RPM | 每分钟最大请求数，1–10000 | NVIDIA 40, Agnes 20 |
| TPM | 每分钟最大 Token 数，0=不限制 | Agnes 40000, NVIDIA 100000 |
| RPD | 每日请求配额 (UTC 重置)，0=不限制 | NVIDIA 10000 |
| 退避策略 | 429 后等待方式 | NVIDIA: fixed, Agnes: exponential |
| 固定退避秒数 | fixed 模式下的等待时间 | NVIDIA 15, 批处理 60 |
| 仅免费档生效 | 付费模型绕过限速 | 开启 |

### 优先级层级（高 → 低）

1. **用户自定义** — 面板保存的配置
2. **历史校准** — 429 触发后自动计算的安全值
3. **系统自动** — DSH 配置文件中的 provider 设置
4. **默认预设** — 插件内置的 `default_presets.json`
5. **全局兜底** — 代码里的硬编码默认值

面板右侧会显示当前生效的优先级徽标。

## 面板功能

- **实时监控**：5 秒轮询，显示队列、RPM/TPM 进度条、日配额用量
- **历史预警**：触发过 429 时显示横幅，一键应用建议值
- **日配额预警**：RPD 用量 ≥ 95% 时显示横幅
- **探测按钮**：模态表单输入 modelId/apiKey/baseUrl，异步任务轮询进度，结果自动生成子限速器
- **清空历史**：清除该服务商的 429 记录
- **恢复默认**：回退到内置预设
- **新增/删除服务商**：手动管理自定义 provider

## 使用 CLI 探测真实阈值

```bash
# 探测 NVIDIA nemotron-3-ultra
node scripts/probeModels.mjs -p nvidia -m nvidia/nemotron-3-ultra-550b-a55b -k $NVIDIA_API_KEY

# 探测 Agnes vision-3k
node scripts/probeModels.mjs -p agnes -m agnes-vision-3k -k $AGNES_API_KEY

# 自定义端点
node scripts/probeModels.mjs -p custom -m my-model -k $API_KEY -u https://api.example.com/v1

# 探测完成后同步更新 settings
node scripts/probeModels.mjs -p nvidia -m nvidia/nemotron-3-ultra-550b-a55b -k $NVIDIA_API_KEY --update-settings
```

探测结果写入 `config/probed_model_limits.json`，下次启动自动生成子限速器。

## RPC 接口（供其他插件/脚本调用）

```javascript
const ratelimit = ctx.require('smart-ratelimit');

// 拦截请求（排队、扣减令牌）
const requestWithLimit = await ratelimit.acquire({
  providerId: 'nvidia',
  modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [...],
  max_tokens: 1024,
  isFreeModel: true
});

// 响应后处理（Token 结算、429 处理、RPD 计数）
const finalResponse = await ratelimit.release(requestWithLimit, response);
```

也可通过 HTTP RPC（同源）：
```
POST /api/dsh-plugin-smart-ratelimit/rpc
{ "method": "acquire", "args": [request] }
{ "method": "release", "args": [request, response] }
{ "method": "getMonitorData", "args": ["nvidia"] }
```

## 已知限制

暂无。前版遗留的两项限制均已解决：

- ✅ 探测按钮：面板现提供模态表单输入 modelId/apiKey/baseUrl，异步任务轮询显示进度，结果自动写入 `probed_model_limits.json` 生成子限速器。
- ✅ 多配置文件合并：`DSH_CONFIG_PATH` 支持逗号分隔多路径，按优先级合并所有存在的配置文件，并标记每个 provider 的 `sourceFile` 来源。

更完整的说明见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

---

## 生产部署清理

配置目录 `config/` 包含测试/预置数据（`probed_model_limits.json`、`rate_limit_429_history.json`、`rate_limit_settings.json`）。接入真实环境前建议清理：

```bash
node scripts/clean-config.mjs
```

此脚本会删除测试生成的配置文件，保留 `default_presets.json`（默认预设）。重启 DSH 后插件会自动按需重新生成。

## License

MIT