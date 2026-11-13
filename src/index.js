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
      runProbe: (providerId) => this.runProbe(providerId),
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
   * 如果 DSH 提供了请求中间件机制，在此注册
   */
  registerRequestInterceptor() {
    // 监听 DSH 的请求发送事件（如果有）
    if (this.ctx.on && typeof this.ctx.on === 'function') {
      this.ctx.on('llm-request', async (request) => {
        if (!this.initialized) return request;
        
        try {
          return await this.interceptor.intercept(request);
        } catch (error) {
          console.error('[SmartRateLimit] Request intercept failed:', error);
          return request; // 失败时放行，不阻断正常流程
        }
      });
      
      this.ctx.on('llm-response', async (request, response) => {
        if (!this.initialized) return response;
        
        try {
          return await this.interceptor.postProcess(request, response);
        } catch (error) {
          if (error.message === 'RATE_LIMIT_EXCEEDED') {
            // 429 已在 postProcess 中处理，重新抛出让上层处理重试
            throw error;
          }
          console.error('[SmartRateLimit] Response process failed:', error);
          return response;
        }
      });
    }
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
   * 运行模型探测
   */
  async runProbe(providerId) {
    // 这里可以集成 probeModels 脚本
    // 暂时返回模拟结果
    return {
      success: true,
      message: 'Probe functionality to be implemented',
      providerId
    };
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