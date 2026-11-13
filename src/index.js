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

/**
 * 插件主类
 */
export class SmartRateLimitPlugin {
  constructor(ctx) {
    this.ctx = ctx;
    this.interceptor = requestInterceptor;
    this.initialized = false;
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
      const providers = await discoverProviders();
      
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
      this.ctx.providers = providers;
      this.ctx.providerConfigs = providerConfigs;
      
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
    const providers = this.ctx.providers || [];
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
  
  // 启动插件
  ctx.on('ready', async () => {
    await plugin.start();
  });
  
  // 导出实例供外部访问
  ctx.smartRateLimit = plugin;
}

export { SmartRateLimitPlugin };