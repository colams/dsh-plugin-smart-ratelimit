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
    // Provider 级 429 冷却门：同一 provider 的并发 429 共享一次退避等待，
    // 避免每个请求各自同步 sleep、互相阻塞调用栈
    this._cooldowns = new Map(); // providerId -> Promise<{backoffMs}>
  }

  /**
   * 获取/创建 provider 级冷却门
   * 同一 provider 的并发 429 共享冷却等待（只挂一个退避 timer），
   * 避免每个请求各自 sleep 阻塞调用栈；冷却期内新 429 按更大退避时间延长
   * @param {string} providerId
   * @param {number} backoffMs - 本次 429 计算出的退避时间
   * @returns {Promise<number>} resolve 本次 backoffMs；冷却期内再次收到 429 时 reject（RATE_LIMIT_COOLDOWN）
   */
  _getCooldownGate(providerId, backoffMs) {
    const existing = this._cooldowns.get(providerId);
    
    if (existing) {
      // 冷却期内再次 429：按更大退避时间延长（max 策略，防高频 429 让冷却过早解除）
      if (backoffMs > existing.backoffMs) {
        existing.backoffMs = backoffMs;
        clearTimeout(existing.timer);
        existing.timer = setTimeout(existing.onEnd, backoffMs);
      }
      // 拒绝当前调用方：provider 仍在冷却中
      return Promise.reject(new Error('RATE_LIMIT_COOLDOWN'));
    }
    
    // 创建冷却门
    let timer;
    const gateState = { backoffMs, timer: null };
    const promise = new Promise((resolve) => {
      gateState.onEnd = () => {
        this._cooldowns.delete(providerId);
        resolve(gateState.backoffMs);
      };
      timer = setTimeout(gateState.onEnd, gateState.backoffMs);
      gateState.timer = timer;
    });
    this._cooldowns.set(providerId, gateState);
    return promise;
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
      // 透传 _skipRateLimit / _isPolling 等标记：NVCF 轮询等请求应跳过 RPM/TPM 扣减
      const result = await limiter.acquire({
        modelId,
        messages,
        max_tokens,
        isFreeModel: request.isFreeModel,
        signal: request.signal,
        _skipRateLimit: request._skipRateLimit,
        _isPolling: request._isPolling
      });
      
      // 记录指标（跳过的请求不重复统计，_skipRateLimit 请求已在 acquire 中标记 skipped）
      if (!result.skipped) {
        metricsTracker.recordRequest(providerId, result.estimatedTokens);
      }
      
      return {
        ...request,
        _ratelimit: {
          allowed: result.allowed,
          skipped: result.skipped || false,
          bypassed: result.bypassed || false,
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
    
    // 请求成功（2xx）才推进日配额计数；429/失败请求不计入 RPD，
    // 避免重试风暴虚高 NVIDIA 等提供商的日配额计数
    if (response.status >= 200 && response.status < 300) {
      limiter.dailyQuota.recordUsage();
    }

    return response;
  }

  /**
   * 处理 429 错误
   * 触发 provider 级冷却门：并发 429 共享一次退避等待，退避时长取最大值，
   * 冷却期内后续请求统一进入排队（桶已被 penalizeOn429 清空），杜绝雪崩重试
   * @param {Object} limiter - 限速器实例
   * @param {string} providerId - 提供商 ID
   * @param {string} modelId - 模型 ID
   * @param {Object} response - HTTP 响应
   * @param {number} retryCount - 当前重试次数
   */
  async handle429(limiter, providerId, modelId, response, retryCount = 0) {
    // 获取当前滑动窗口统计
    const stats = metricsTracker.getCurrentStats(providerId);
    
    // 触发惩罚（清空双桶），历史由下方 handle429 统一记录一次，避免重复
    limiter.penalizeOn429(modelId, stats.rpm, stats.tpm, { recordHistory: false });
    
    // 记录历史并获取建议值
    const suggestion = historyTracker.record429(providerId, stats.rpm, stats.tpm, modelId);
    
    // 计算退避时间（传入重试次数用于指数退避）
    const backoffMs = this.calculateBackoff(limiter.config, response, retryCount);
    
    // 等待 provider 级冷却门（并发 429 共享一次退避）
    await this._getCooldownGate(providerId, backoffMs);
    
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
   * 剥离 priority 等元数据字段，避免 UI 侧把生效来源标记写进配置数据
   */
  saveSettings(providerId, config) {
    const { priority, ...data } = config || {};
    this.settings[providerId] = { ...this.settings[providerId], ...data, priority: 'user_custom' };
    try {
      writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('[RequestInterceptor] Failed to save settings:', error.message);
    }
  }

  /**
   * 移除某 provider 的本插件限速配置。
   * 只删除本插件保存的配置与限速器，不影响 DSH 自身的 provider 定义。
   * @param {string} providerId
   * @returns {boolean} 是否确实删除了一条配置
   */
  removeSettings(providerId) {
    const had = this.settings && Object.prototype.hasOwnProperty.call(this.settings, providerId);
    if (had) {
      delete this.settings[providerId];
      try {
        writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
      } catch (error) {
        console.error('[RequestInterceptor] Failed to save settings:', error.message);
      }
    }
    this.manager.removeLimiter(providerId);
    return had;
  }

  /**
   * 读取用户手动新增的 provider 列表（持久化在设置文件的 __customProviders 键）。
   * @returns {Array<{id: string, displayName: string, baseUrl: string}>}
   */
  getCustomProviders() {
    const list = this.settings && this.settings.__customProviders;
    return Array.isArray(list) ? list : [];
  }

  /**
   * 写入用户手动新增的 provider 列表。
   * @param {Array<{id: string, displayName: string, baseUrl: string}>} list
   */
  setCustomProviders(list) {
    if (!this.settings) this.settings = {};
    this.settings.__customProviders = Array.isArray(list) ? list : [];
    try {
      writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('[RequestInterceptor] Failed to save settings:', error.message);
    }
  }

  /**
   * 读取用户显式移除的 provider id 列表（持久化在 __removedProviders）。
   * 这些 provider 不再出现在面板中，也不参与限速。
   * @returns {string[]}
   */
  getRemovedProviders() {
    const list = this.settings && this.settings.__removedProviders;
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  }

  /**
   * 写入用户显式移除的 provider id 列表。
   * @param {string[]} list
   */
  setRemovedProviders(list) {
    if (!this.settings) this.settings = {};
    this.settings.__removedProviders = Array.isArray(list) ? list : [];
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