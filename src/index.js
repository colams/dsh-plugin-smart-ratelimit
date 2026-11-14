/**
 * DSH Smart Rate Limit Plugin - Main Entry
 * Cordis 插件主入口：注册设置菜单、拦截器与 RPC 接口
 * 对应规格书 §5, §6, §7
 */

import { RequestInterceptor, requestInterceptor } from './intercept/requestInterceptor.js';
import { discoverProviders, getDefaultConfig, getAllDefaultPresets } from './config/providerDiscovery.js';
import { DualRateLimiter, RateLimiterManager } from './limiter/dualRateLimiter.js';
import { metricsTracker, historyTracker } from './history/metricsTracker.js';
import { mergeProviderConfig, getConfigSourceDescription } from './config/configMerger.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigPaths } from './config/configPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = ConfigPaths.settings;
const CONFIG_DIR = ConfigPaths.dir;

/** Base path of the RPC route the Web UI panel talks to. */
const RPC_BASE_PATH = '/api/dsh-plugin-smart-ratelimit/rpc';

/** Maximum accepted JSON body for the RPC endpoint. */
const MAX_BODY_BYTES = 64 * 1024;

/** Write a JSON response. */
function writeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** Read a small JSON request body. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 插件主类
 */
export class SmartRateLimitPlugin {
  constructor(ctx) {
    this.ctx = ctx;
    this.interceptor = requestInterceptor;
    this.initialized = false;
    // provider 列表保存在插件实例上，而不是 ctx 上：Cordis 的 context 是代理，
    // 未在 inject 中声明的属性既不能读也不能写。
    this.providers = [];
    this.providerConfigs = {};
    // 探测任务管理：taskId -> { providerId, modelId, status, progress, result, error, startedAt }
    this.probeTasks = new Map();
    this._probeTaskCounter = 0;
  }

  /**
   * 插件启动入口
   */
  async start() {
    // 确保配置目录存在
    ConfigPaths.ensureDir();
    
    // 发现并初始化 Providers
    await this.initializeProviders();
    
    // 注册设置面板
    this.registerSettingsPanel();
    
    // 注册 RPC 接口
    this.registerRpcMethods();
    
    // 注册请求拦截器（如果 DSH 支持）
    this.registerRequestInterceptor();
    
    this.initialized = true;
    console.log('[SmartRateLimit] Plugin started successfully');
  }

  /**
   * 发现并初始化 Providers
   */
  async initializeProviders() {
    try {
      // 从 DSH 配置发现 Providers
      const discovered = await discoverProviders();

      // 过滤用户显式移除的 provider
      const removed = new Set(this.interceptor.getRemovedProviders());
      const providers = discovered.filter((p) => !removed.has(p.id));

      // 合并用户手动新增的 provider（持久化在设置文件里），放在末尾
      const seen = new Set(providers.map((p) => p.id));
      for (const custom of this.interceptor.getCustomProviders()) {
        if (!custom || typeof custom.id !== 'string' || seen.has(custom.id)) continue;
        seen.add(custom.id);
        providers.push({
          id: custom.id,
          displayName: custom.displayName || custom.id,
          baseUrl: custom.baseUrl || ''
        });
      }

      // 构建配置对象
      const providerConfigs = {};
      for (const provider of providers) {
        const defaultConfig = getDefaultConfig(provider.id);
        const savedConfig = this.loadProviderSettings(provider.id);
        
        providerConfigs[provider.id] = {
          ...defaultConfig,
          ...savedConfig,
          displayName: provider.displayName
        };
      }
      
      // 初始化拦截器
      await this.interceptor.initialize(providerConfigs);
      
      // 存储到上下文供其他模块使用
      this.providers = providers;
      this.providerConfigs = providerConfigs;
      
    } catch (error) {
      console.error('[SmartRateLimit] Failed to initialize providers:', error);
    }
  }

  /**
   * 加载单个 Provider 的保存设置
   */
  loadProviderSettings(providerId) {
    try {
      if (existsSync(SETTINGS_FILE)) {
        const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
        return settings[providerId] || {};
      }
    } catch {}
    return {};
  }

  /**
   * 注册设置面板
   */
  registerSettingsPanel() {
    // 通过 DSH 的前端扩展机制注册设置面板
    // 这里提供 RPC 接口供前端调用
    this.ctx.provide('smart-ratelimit.settings', {
      getProviders: () => this.getProvidersForUI(),
      getSettings: (providerId) => this.getSettings(providerId),
      saveSettings: (providerId, config) => this.saveSettings(providerId, config),
      applySuggestion: (providerId) => this.applySuggestion(providerId),
      clearHistory: (providerId) => this.clearHistory(providerId),
      getMonitorData: (providerId) => this.getMonitorData(providerId),
      getHistory: (providerId) => this.getHistory(providerId),
      runProbe: (providerId) => this.runProbe(providerId)
    });
  }

  /**
   * 注册 RPC 方法
   */
  registerRpcMethods() {
    // 供其他插件或脚本调用的 RPC 方法
    this.ctx.provide('smart-ratelimit', {
      acquire: (request) => this.interceptor.intercept(request),
      release: (request, response) => this.interceptor.postProcess(request, response),
      getLimiter: (providerId) => this.interceptor.manager.getLimiter(providerId),
      updateConfig: (providerId, config) => this.interceptor.updateConfig(providerId, config)
    });
  }

  /**
   * 注册 Web UI 面板用的 HTTP RPC 路由
   * 面板通过同源 fetch 调用此端点；DSH 的 typert/remote 机制不覆盖普通插件服务，
   * 因此走 Host webserver 的同源路由（与 dsh-browser-panel 相同的做法）。
   */
  registerHttpRoutes() {
    const ctx = this.ctx;
    if (typeof ctx.inject !== 'function') {
      console.warn('[SmartRateLimit] ctx.inject unavailable; Web UI panel RPC disabled');
      return;
    }

    this.writeRouteStatus({ ok: null, phase: 'inject-pending', path: RPC_BASE_PATH, at: new Date().toISOString() });

    ctx.inject(['webServer'], (webCtx) => {
      this.writeRouteStatus({ ok: null, phase: 'inject-resolved', path: RPC_BASE_PATH, at: new Date().toISOString() });
      const route = {
        kind: 'exact',
        path: RPC_BASE_PATH,
        handler: async (req, res) => {
          if ((req.method ?? 'GET') !== 'POST') {
            return writeJson(res, 405, { ok: false, error: 'method not allowed' });
          }
          let method = '';
          try {
            const body = await readJson(req);
            method = typeof body.method === 'string' ? body.method : '';
            const args = Array.isArray(body.args) ? body.args : [];
            const handler = this.rpcHandlers()[method];
            if (!handler) {
              console.warn(`[SmartRateLimit] RPC unknown method: ${method}`);
              return writeJson(res, 404, { ok: false, error: `unknown method: ${method}` });
            }
            const value = await handler(...args);
            return writeJson(res, 200, { ok: true, value });
          } catch (error) {
            console.error(`[SmartRateLimit] RPC ${method || '?'} failed:`, error);
            return writeJson(res, 500, { ok: false, error: error.message });
          }
        }
      };

      try {
        webCtx.effect(() => webCtx.webServer.register(route), 'smart-ratelimit: rpc route');
        console.log(`[SmartRateLimit] RPC route registered: POST ${RPC_BASE_PATH}`);
        this.writeRouteStatus({ ok: true, path: RPC_BASE_PATH, at: new Date().toISOString() });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.error('[SmartRateLimit] Failed to register RPC route:', message);
        this.writeRouteStatus({ ok: false, path: RPC_BASE_PATH, error: message, at: new Date().toISOString() });
      }
    });
  }

  /**
   * 把 HTTP 路由的挂载状态写到配置目录，便于离线排查“面板 404”。
   * @param {object} status
   */
  writeRouteStatus(status) {
    try {
      const dir = dirname(SETTINGS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'route-status.json'), JSON.stringify(status, null, 2));
    } catch (error) {
      console.warn('[SmartRateLimit] writeRouteStatus failed:', error.message);
    }
  }

  /**
   * RPC 方法表
   */
  rpcHandlers() {
    return {
      getProviders: () => this.getProvidersForUI(),
      getSettings: (providerId) => this.getSettings(providerId),
      saveSettings: (providerId, config) => this.saveSettings(providerId, config),
      applySuggestion: (providerId) => this.applySuggestion(providerId),
      clearHistory: (providerId) => this.clearHistory(providerId),
      getMonitorData: (providerId) => this.getMonitorData(providerId),
      getHistory: (providerId) => this.getHistory(providerId),
      startProbe: (providerId, modelId, apiKey, options) => this.startProbe(providerId, modelId, apiKey, options),
      getProbeStatus: (taskId) => this.getProbeStatus(taskId),
      addProvider: (payload) => this.addProvider(payload),
      removeProvider: (providerId) => this.removeProvider(providerId)
    };
  }

  /**
   * 手动新增一个自定义 provider（仅用于本插件的限速配置，不改动 DSH 的 llm 配置）
   * @param {{id?: string, displayName?: string, baseUrl?: string}} payload
   */
  addProvider(payload) {
    const rawId = payload && typeof payload.id === 'string' ? payload.id.trim().toLowerCase() : '';
    if (!rawId) return { success: false, error: 'provider id 不能为空' };
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(rawId)) {
      return { success: false, error: 'id 只能包含小写字母、数字、点、下划线和连字符' };
    }

    const providers = this.providers || [];
    if (providers.some((p) => p.id === rawId)) {
      return { success: false, error: `provider 已存在：${rawId}` };
    }

    const displayName = payload && typeof payload.displayName === 'string' && payload.displayName.trim()
      ? payload.displayName.trim()
      : rawId;

    // 1) 加入内存列表
    const entry = { id: rawId, displayName, baseUrl: (payload && payload.baseUrl) || '' };
    this.providers = [...providers, entry];

    // 2) 持久化到设置文件的 __customProviders
    const custom = this.interceptor.getCustomProviders().filter((p) => p.id !== rawId);
    custom.push({ id: rawId, displayName, baseUrl: entry.baseUrl });
    this.interceptor.setCustomProviders(custom);

    // 若此前被移除过，这次新增要解除移除标记
    const removedNow = this.interceptor.getRemovedProviders().filter((id) => id !== rawId);
    this.interceptor.setRemovedProviders(removedNow);

    // 3) 创建限速器 + 写入默认配置
    const defaultConfig = getDefaultConfig(rawId) || {};
    this.interceptor.manager.getLimiter(rawId, defaultConfig);
    this.interceptor.saveSettings(rawId, { ...defaultConfig, displayName });

    return { success: true, provider: entry };
  }

  /**
   * 移除一个 provider 的本插件限速配置。
   * 对 DSH 内置/配置的 provider 只取消限速配置；对手动新增的还会从自定义列表移除。
   * @param {string} providerId
   */
  removeProvider(providerId) {
    const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
    if (!id) return { success: false, error: 'provider id 不能为空' };

    const before = (this.providers || []).length;
    this.providers = (this.providers || []).filter((p) => p.id !== id);

    // 自定义列表里也移除
    const custom = this.interceptor.getCustomProviders();
    const filtered = custom.filter((p) => p.id !== id);
    if (filtered.length !== custom.length) this.interceptor.setCustomProviders(filtered);

    // 删除配置与限速器
    const removedConfig = this.interceptor.removeSettings(id);

    // 记住“已移除”，避免重启后又被 discoverProviders 重新发现
    const removedList = this.interceptor.getRemovedProviders();
    if (!removedList.includes(id)) {
      removedList.push(id);
      this.interceptor.setRemovedProviders(removedList);
    }

    return {
      success: true,
      removed: before !== (this.providers || []).length || removedConfig
    };
  }

  /**
   * 注册请求拦截器
   * 对接 DSH 的 llm/stream 钩子：包装流式响应，在首个 chunk 前 acquire、流结束后 release
   */
  registerRequestInterceptor() {
    if (!this.ctx.on || typeof this.ctx.on !== 'function') return;

    const interceptor = this.interceptor;
    const buildResponse = this.buildResponseFromChunks.bind(this);

    this.ctx.on('llm/stream', (request, stream) => {
      if (!this.initialized || !stream) return stream;

      // 如果请求已标记跳过限速，直接透传
      if (request._skipRateLimit || request._isPolling) return stream;

      // 创建 TransformStream 包装器
      // - start: 流开始被消费时调用 acquire()
      // - transform: 透传 chunk
      // - flush: 流结束（正常或异常）时调用 postProcess()
      let acquired = false;
      let requestWithRatelimit = null;
      let chunks = [];
      let streamEnded = false;
      let streamError = null;

      const transformer = new TransformStream({
        async start(controller) {
          // 流开始被消费：执行 acquire
          try {
            requestWithRatelimit = await interceptor.intercept(request);
            acquired = true;
          } catch (error) {
            // acquire 失败（如 RPD 超限）：直接报错，不阻断原流
            controller.error(error);
            return;
          }
        },
        transform(chunk, controller) {
          // 缓存 chunk 用于后续 release 时重构响应
          chunks.push(chunk);
          controller.enqueue(chunk);
        },
        async flush(controller) {
          streamEnded = true;
          if (!acquired || !requestWithRatelimit) return;

          // 从流式 chunks 重构类响应对象供 postProcess 使用
          const response = buildResponse(chunks, streamError);
          
          try {
            await interceptor.postProcess(requestWithRatelimit, response);
          } catch (error) {
            // 429 (RATE_LIMIT_EXCEEDED) 需要向上抛出让 DSH 重试
            if (error.message === 'RATE_LIMIT_EXCEEDED') {
              controller.error(error);
            }
            // 其他错误只记录不阻断
            else {
              console.error('[SmartRateLimit] Stream postProcess failed:', error);
            }
          }
        }
      });

      // 捕获流错误，确保 flush 能拿到 error
      const wrappedStream = stream.pipeThrough(transformer);
      wrappedStream.getReader().closed.catch(err => {
        streamError = err;
        if (!streamEnded && acquired && requestWithRatelimit) {
          // 流异常中断，手动触发 flush 逻辑
          const response = buildResponse(chunks, err);
          interceptor.postProcess(requestWithRatelimit, response).catch(() => {});
        }
      });

      return wrappedStream;
    });
  }

  /**
   * 从流式 chunks 重构响应对象供 postProcess 使用
   * 兼容 SSE 格式和普通 JSON chunk 格式
   */
  buildResponseFromChunks(chunks, error = null) {
    if (error) {
      return {
        status: 0,
        statusText: error.message || 'Stream error',
        headers: {},
        data: null,
        _streamError: true,
        _streamErrorDetail: error
      };
    }

    // 尝试解析最后一个有效的 data chunk 作为完整响应
    // DSH 的流式响应通常最后会发送完整的 response 对象
    let lastData = null;
    for (let i = chunks.length - 1; i >= 0; i--) {
      const chunk = chunks[i];
      if (chunk && typeof chunk === 'object' && chunk.data) {
        lastData = chunk;
        break;
      }
      // SSE 格式：{ data: '...' } 或直接是字符串
      if (chunk && typeof chunk === 'object' && chunk.choices) {
        lastData = chunk;
        break;
      }
    }

    if (lastData) {
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        data: lastData,
        _streaming: true,
        _chunkCount: chunks.length
      };
    }

    // 兜底：返回基础成功响应
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { choices: [] },
      _streaming: true,
      _chunkCount: chunks.length,
      _incomplete: true
    };
  }

  /**
   * 获取供 UI 使用的 Provider 列表
   */
  getProvidersForUI() {
    const providers = this.providers || [];
    return providers.map(p => ({
      id: p.id,
      displayName: p.displayName,
      baseUrl: p.baseUrl
    }));
  }

  /**
   * 获取指定 Provider 的设置
   */
  getSettings(providerId) {
    const limiter = this.interceptor.manager.getLimiter(providerId);
    const history = historyTracker.getSuggestion(providerId);
    
    // 使用配置合并器获取完整配置（包含正确的优先级）
    const mergedConfig = mergeProviderConfig(providerId);
    
    if (!limiter) {
      return {
        ...mergedConfig,
        historySuggestion: history
      };
    }
    
    return {
      ...limiter.config,
      priority: mergedConfig.priority || 'user_custom',
      historySuggestion: history
    };
  }

  /**
   * 保存设置
   */
  saveSettings(providerId, config) {
    this.interceptor.updateConfig(providerId, config);
    return { success: true };
  }

  /**
   * 应用历史建议值
   */
  applySuggestion(providerId) {
    const suggestion = this.interceptor.applySuggestion(providerId);
    return { success: !!suggestion, suggestion };
  }

  /**
   * 清空历史
   */
  clearHistory(providerId) {
    this.interceptor.clearHistory(providerId);
    return { success: true };
  }

  /**
   * 获取监控数据
   */
  getMonitorData(providerId) {
    return this.interceptor.getMonitorData(providerId);
  }

  /**
   * 获取历史数据
   */
  getHistory(providerId) {
    return historyTracker.getHistory(providerId);
  }

  /**
   * 运行模型探测（旧接口，保留兼容）
   */
  async runProbe(providerId) {
    return {
      success: true,
      message: 'Use startProbe with modelId and apiKey for actual probing',
      providerId
    };
  }

  /**
   * 启动异步探测任务
   * @param {string} providerId
   * @param {string} modelId
   * @param {string} apiKey
   * @param {Object} options - { maxRpm, step, timeout, baseUrl }
   * @returns {Object} { taskId }
   */
  async startProbe(providerId, modelId, apiKey, options = {}) {
    if (!providerId || !modelId || !apiKey) {
      return { success: false, error: 'providerId, modelId, apiKey 均为必填' };
    }

    const taskId = `probe_${Date.now()}_${++this._probeTaskCounter}`;
    const task = {
      taskId,
      providerId,
      modelId,
      apiKey,
      options: {
        maxRpm: options.maxRpm || 100,
        step: options.step || 5,
        timeout: options.timeout || 30000,
        baseUrl: options.baseUrl || ''
      },
      status: 'pending',
      progress: 0,
      stage: 'init', // init, rpm, tpm, saving, done
      result: null,
      error: null,
      startedAt: new Date().toISOString()
    };

    this.probeTasks.set(taskId, task);

    // 异步执行探测，不阻塞返回
    this._executeProbe(taskId).catch(err => {
      console.error('[SmartRateLimit] Probe task failed:', err);
      const t = this.probeTasks.get(taskId);
      if (t) {
        t.status = 'failed';
        t.error = err.message;
        t.progress = 100;
      }
    });

    return { success: true, taskId };
  }

  /**
   * 获取探测任务状态
   */
  getProbeStatus(taskId) {
    const task = this.probeTasks.get(taskId);
    if (!task) {
      return { success: false, error: '任务不存在' };
    }
    return { success: true, task: { ...task, apiKey: '***' } };
  }

  /**
   * 内部：执行探测逻辑（复用 probeModels.mjs 的核心算法）
   */
  async _executeProbe(taskId) {
    const task = this.probeTasks.get(taskId);
    if (!task) return;

    const { providerId, modelId, apiKey, options } = task;

    // 确定 baseUrl
    let baseUrl = options.baseUrl;
    if (!baseUrl) {
      const defaultConfig = getDefaultConfig(providerId);
      baseUrl = defaultConfig?.baseUrl || '';
    }
    if (!baseUrl) {
      task.status = 'failed';
      task.error = `无法确定 ${providerId} 的 API 基础 URL，请在选项中指定 baseUrl`;
      return;
    }

    try {
      // 阶段 1：探测 RPM
      task.stage = 'rpm';
      task.progress = 10;
      const rpmResult = await this._probeMaxRpm(baseUrl, apiKey, modelId, options, (p) => {
        task.progress = 10 + Math.floor(p * 0.4); // 10-50%
      });

      // 阶段 2：探测 TPM
      task.stage = 'tpm';
      task.progress = 50;
      const tpmResult = await this._probeTpm(baseUrl, apiKey, modelId, rpmResult.rpm, options, (p) => {
        task.progress = 50 + Math.floor(p * 0.4); // 50-90%
      });

      // 阶段 3：保存结果
      task.stage = 'saving';
      task.progress = 90;
      const results = {
        ...rpmResult,
        ...tpmResult,
        tpmConfidence: tpmResult.confidence
      };

      this._saveProbedResults(providerId, modelId, results);

      task.status = 'done';
      task.progress = 100;
      task.stage = 'done';
      task.result = results;
      task.completedAt = new Date().toISOString();

    } catch (error) {
      task.status = 'failed';
      task.error = error.message;
      task.progress = 100;
    }
  }

  /**
   * 二分法探测最大 RPM（内部实现）
   */
  async _probeMaxRpm(baseUrl, apiKey, model, options, onProgress) {
    const { maxRpm, step, timeout } = options;
    let low = step;
    let high = maxRpm;
    let lastSuccessRpm = 0;
    let last429Rpm = null;
    let consecutive429 = 0;
    let iteration = 0;
    const maxIterations = Math.ceil(Math.log2(maxRpm / step)) + 2;

    while (low <= high && iteration < maxIterations) {
      iteration++;
      const mid = Math.floor((low + high) / 2);
      const testRpm = Math.max(step, Math.floor(mid / step) * step);

      if (onProgress) onProgress(iteration / maxIterations);

      const intervalMs = 60000 / testRpm;
      const requestCount = Math.min(10, testRpm);

      let successCount = 0;
      let error429Count = 0;

      const promises = [];
      for (let i = 0; i < requestCount; i++) {
        const delay = i * intervalMs;
        promises.push(
          new Promise(resolve => setTimeout(() => resolve(this._sendTestRequest(baseUrl, apiKey, model, 16, timeout)), delay))
        );
      }

      const results = await Promise.all(promises);

      for (const result of results) {
        if (result.status === 200) successCount++;
        else if (result.status === 429) error429Count++;
      }

      if (error429Count > 0) {
        high = testRpm - step;
        consecutive429++;
        if (consecutive429 >= 2) break;
      } else if (successCount >= requestCount * 0.8) {
        lastSuccessRpm = testRpm;
        low = testRpm + step;
        consecutive429 = 0;
      } else {
        high = testRpm - step;
      }
    }

    const safeRpm = last429Rpm ? Math.max(1, Math.floor(last429Rpm * 0.9)) : lastSuccessRpm;

    return {
      rpm: safeRpm,
      triggeredAtRpm: last429Rpm,
      lastSuccessRpm,
      confidence: last429Rpm ? 0.8 : 0.5
    };
  }

  /**
   * 探测 TPM 限制（内部实现）
   */
  async _probeTpm(baseUrl, apiKey, model, safeRpm, options, onProgress) {
    const { timeout } = options;
    const testTokens = [1000, 4000, 8000, 16000, 32000, 64000, 100000];
    let maxSafeTpm = 0;
    let triggeredAtTpm = null;

    for (let i = 0; i < testTokens.length; i++) {
      const tokens = testTokens[i];
      if (onProgress) onProgress(i / testTokens.length);

      const result = await this._sendTestRequest(baseUrl, apiKey, model, tokens, timeout);

      if (result.status === 200) {
        const actualTokens = result.data?.usage?.total_tokens || tokens;
        maxSafeTpm = Math.max(maxSafeTpm, actualTokens * safeRpm);
      } else if (result.status === 429) {
        triggeredAtTpm = tokens * safeRpm;
        break;
      }

      // 避免触发限速，等待一下
      await new Promise(r => setTimeout(r, 2000));
    }

    const safeTpm = triggeredAtTpm ? Math.max(1, Math.floor(triggeredAtTpm * 0.9)) : maxSafeTpm;

    return {
      tpm: safeTpm,
      triggeredAtTpm,
      confidence: triggeredAtTpm ? 0.8 : 0.5
    };
  }

  /**
   * 发送测试请求
   */
  async _sendTestRequest(baseUrl, apiKey, model, maxTokens, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: maxTokens,
          temperature: 0
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const data = await response.json().catch(() => ({}));

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data,
        error: null
      };
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        status: 0,
        headers: {},
        data: null,
        error: error.message
      };
    }
  }

  /**
   * 保存探测结果到 probed_model_limits.json
   */
  _saveProbedResults(providerId, modelId, results) {
    const PROBED_FILE = join(CONFIG_DIR, 'probed_model_limits.json');
    let probedData = {};
    if (existsSync(PROBED_FILE)) {
      probedData = JSON.parse(readFileSync(PROBED_FILE, 'utf-8'));
    }

    if (!probedData[providerId]) {
      probedData[providerId] = {};
    }

    probedData[providerId][modelId] = {
      rpm: results.rpm,
      tpm: results.tpm || 0,
      probedAt: new Date().toISOString(),
      probedRpm: results.triggeredAtRpm || null,
      probedTpm: results.triggeredAtTpm || null,
      confidence: Math.min(results.confidence || 0.5, results.tpmConfidence || 0.5)
    };

    writeFileSync(PROBED_FILE, JSON.stringify(probedData, null, 2));
    console.log(`[SmartRateLimit] Probe results saved for ${providerId}/${modelId}`);
  }
}

/**
 * Cordis 插件导出
 * @param {Object} ctx - Cordis 上下文
 */
export default function apply(ctx) {
  const plugin = new SmartRateLimitPlugin(ctx);

  // HTTP 路由必须在 apply 阶段挂载：Cordis 的 ctx.inject 只在插件 fiber 活跃期
  // （apply 执行期间及其之后由 fiber 持有的 effect）生效，放到 ready 回调里不会注册。
  plugin.registerHttpRoutes();

  // 导出实例供外部访问。Cordis 的 context 是代理，禁止直接赋值属性
  // （会抛 "cannot set property ... without provide" 并让整个插件加载失败），
  // 必须走 ctx.provide() 注册为服务；该服务随插件 fiber 卸载自动移除。
  ctx.provide('smartRateLimit', plugin);

  // 启动插件（provider 发现、限速器初始化等）。Cordis 没有 'ready' 事件，
  // 早先的 ctx.on('ready') 永远不会触发，导致 provider 列表一直为空；
  // 这里在 apply 内直接启动，异步部分不阻塞插件加载。
  void plugin.start().catch((error) => {
    console.error('[SmartRateLimit] start failed:', error);
  });

  console.log('[SmartRateLimit] apply() done');
}