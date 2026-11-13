/**
 * Request Interceptor - 统一请求包装器
 * 排队 -> 预扣Token -> 校准 -> 429退避
 * 对应规格书 §3, §4.2, §7
 */

import { DualRateLimiter, RateLimiterManager } from '../limiter/dualRateLimiter.js';
import { metricsTracker, historyTracker } from '../history/metricsTracker.js';
import { mergeProviderConfig } from '../config/configMerger.js';
import { nvcfPoller } from './nvcfPoller.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigPaths } from '../config/configPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = ConfigPaths.settings;

/**
 * 请求拦截器主类
 */
export class RequestInterceptor {
  constructor() {
    this.manager = new RateLimiterManager();
    this.settings = this.loadSettings();
    this.initialized = false;
  }

  /**
   * 初始化 - 加载配置并创建限速器
   * 使用 5 层优先级合并：全局兜底 -> 默认预设 -> 系统自动 -> 探测/历史 -> 用户自定义
   */
  async initialize(providerConfigs = {}) {
    // 获取所有已知的 provider ID（来自传入配置、设置文件、默认预设等）
    const allProviderIds = new Set([
      ...Object.keys(providerConfigs),
      ...Object.keys(this.settings)
    ]);
    
    // 也加上默认预设中的 providers
    try {
      const presetPath = join(CONFIG_DIR, 'default_presets.json');
      if (existsSync(presetPath)) {
        const presets = JSON.parse(readFileSync(presetPath, 'utf-8'));
        for (const id of Object.keys(presets)) {
          if (id !== 'default') allProviderIds.add(id);
        }
      }
    } catch {}
    
    // 为每个 provider 合并配置并创建限速器
    for (const providerId of allProviderIds) {
      // 使用 5 层优先级合并获取最终配置
      const mergedConfig = mergeProviderConfig(providerId);
      
      // 如果传入了显式配置（来自 DSH 系统配置），它已经在 mergeProviderConfig 的第3层处理了
      // 但为了向后兼容，如果 providerConfigs 中有显式配置，确保它生效
      if (providerConfigs[providerId]) {
        Object.assign(mergedConfig, providerConfigs[providerId]);
        mergedConfig.priority = 'system_auto'; // 显式传入的视为系统自动配置
      }
      
      this.manager.getLimiter(providerId, mergedConfig);
    }
    this.initialized = true;
  }

  /**
   * 核心拦截方法 - 在发起请求前调用
   * @param {Object} request - 请求对象
   * @returns {Promise<Object>} 放行信息
   */
  async intercept(request) {
    const { providerId, modelId, messages, max_tokens, ...rest } = request;
    
    if (!providerId) {
      throw new Error('Missing providerId in request');
    }

    const limiter = this.manager.getLimiter(providerId);
    if (!limiter) {
      throw new Error(`No rate limiter found for provider: ${providerId}`);
    }

    try {
      // 通过双重令牌桶获取许可
      const result = await limiter.acquire({
        modelId,
        messages,
        max_tokens,
        isFreeModel: request.isFreeModel,
        signal: request.signal
      });
      
      // 记录指标
      metricsTracker.recordRequest(providerId, result.estimatedTokens);
      
      return {
        ...request,
        _ratelimit: {
          allowed: true,
          estimatedTokens: result.estimatedTokens,
          limiter
        }
      };
    } catch (error) {
      if (error.message === 'ERR_RPD_EXCEEDED') {
        throw error;
      }
      throw error;
    }
  }

  /**
   * 响应后处理 - Token 结算与 429 处理
   * @param {Object} request - 原始请求（含 _ratelimit 信息）
   * @param {Object} response - 响应对象
   * @returns {Promise<Object>} 处理后的响应
   */
  async postProcess(request, response) {
    const { _ratelimit, providerId, modelId } = request;
    
    if (!_ratelimit?.allowed || !_ratelimit?.limiter) {
      return response;
    }

    const limiter = _ratelimit.limiter;
    const estimatedTokens = _ratelimit.estimatedTokens;

    // 处理 HTTP 429
    if (response.status === 429) {
      // 从请求中获取重试次数（默认 0）
      const retryCount = request._retryCount || 0;
      await this.handle429(limiter, providerId, modelId, response, retryCount);
      throw new Error('RATE_LIMIT_EXCEEDED');
    }

    // 处理 NVCF 202 异步响应
    if (response.status === 202) {
      return this.handleNVCFAsync(request, response, limiter);
    }

    // 正常响应 - Token 结算
    if (response.data?.usage?.total_tokens) {
      const actualTokens = response.data.usage.total_tokens;
      limiter.settle(actualTokens, estimatedTokens);
    }

    return response;
  }

  /**
   * 处理 429 错误
   * @param {Object} limiter - 限速器实例
   * @param {string} providerId - 提供商 ID
   * @param {string} modelId - 模型 ID
   * @param {Object} response - HTTP 响应
   * @param {number} retryCount - 当前重试次数
   */
  async handle429(limiter, providerId, modelId, response, retryCount = 0) {
    // 获取当前滑动窗口统计
    const stats = metricsTracker.getCurrentStats(providerId);
    
    // 触发惩罚（清空双桶）
    limiter.penalizeOn429(modelId, stats.rpm, stats.tpm);
    
    // 记录历史并获取建议值
    const suggestion = historyTracker.record429(providerId, stats.rpm, stats.tpm, modelId);
    
    // 计算退避时间（传入重试次数用于指数退避）
    const backoffMs = this.calculateBackoff(limiter.config, response, retryCount);
    
    // 等待退避时间
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    
    return {
      backoffMs,
      suggestion,
      stats
    };
  }

  /**
   * 计算退避时间
   * @param {Object} config - 限速器配置
   * @param {Object} response - HTTP 响应
   * @param {number} retryCount - 当前重试次数 (0-based)
   */
  calculateBackoff(config, response, retryCount = 0) {
    const strategy = config.backoffStrategy || 'exponential';
    
    // 优先读取 Retry-After 头
    const retryAfter = response.headers?.['retry-after'];
    if (retryAfter && !isNaN(retryAfter)) {
      return parseInt(retryAfter) * 1000;
    }
    
    switch (strategy) {
      case 'fixed':
        // 固定退避 + 抖动
        const baseMs = (config.fixedBackoffSeconds || 15) * 1000;
        const jitter = Math.random() * 3000; // 0-3s 抖动
        return baseMs + jitter;
        
      case 'exponential':
      default:
        // 指数退避 [1, 2, 4, 8, 16]s + ±20% 抖动
        const delays = [1000, 2000, 4000, 8000, 16000];
        const baseDelay = delays[Math.min(retryCount, delays.length - 1)];
        const jitterFactor = 0.8 + Math.random() * 0.4; // ±20%
        return Math.floor(baseDelay * jitterFactor);
    }
  }

  /**
   * 处理 NVCF 202 异步响应
   * @param {Object} request - 原始请求（包含 headers 等信息）
   * @param {Object} response - 初始 202 响应
   * @param {Object} limiter - 限速器实例（用于配置获取）
   * @returns {Promise<Object>} 最终的响应对象
   */
  async handleNVCFAsync(request, response, limiter) {
    // 使用独立的 NVCFPoller 模块处理轮询
    // 支持：可配置超时、错误分类、取消信号、跳过限速扣减
    return nvcfPoller.poll(request, response, {
      signal: request.signal // 支持 AbortSignal 取消
    });
  }

  /**
   * 加载用户设置
   */
  loadSettings() {
    try {
      if (existsSync(SETTINGS_FILE)) {
        return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
      }
    } catch (error) {
      console.warn('[RequestInterceptor] Failed to load settings:', error.message);
    }
    return {};
  }

  /**
   * 保存用户设置
   */
  saveSettings(providerId, config) {
    this.settings[providerId] = { ...this.settings[providerId], ...config, priority: 'user_custom' };
    try {
      writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('[RequestInterceptor] Failed to save settings:', error.message);
    }
  }

  /**
   * 获取实时监控数据
   */
  getMonitorData(providerId) {
    const limiter = this.manager.getLimiter(providerId);
    if (!limiter) return null;
    
    return limiter.getMonitorState();
  }

  /**
   * 获取所有 Provider 的监控数据
   */
  getAllMonitorData() {
    const data = {};
    for (const limiter of this.manager.getAllLimiters()) {
      data[limiter.providerId] = limiter.getMonitorState();
    }
    return data;
  }

  /**
   * 热更新配置
   */
  updateConfig(providerId, config) {
    const limiter = this.manager.getLimiter(providerId);
    if (limiter) {
      limiter.updateConfig(config);
      this.saveSettings(providerId, config);
    }
  }

  /**
   * 应用历史建议值
   */
  applySuggestion(providerId) {
    const suggestion = historyTracker.getSuggestion(providerId);
    if (suggestion && suggestion.hasHistory) {
      this.updateConfig(providerId, {
        rpm: suggestion.suggestedSafeRpm,
        tpm: suggestion.suggestedSafeTpm
      });
      return suggestion;
    }
    return null;
  }

  /**
   * 清空历史记录
   */
  clearHistory(providerId) {
    historyTracker.clearHistory(providerId);
  }
}

// 单例实例
export const requestInterceptor = new RequestInterceptor();

export default {
  RequestInterceptor,
  requestInterceptor
};