/**
 * Dual Rate Limiter - 核心引擎
 * RPM + TPM 双维度令牌桶与 FIFO 队列、RPD 熔断、热更新
 * 对应规格书 §3, §3.1, §3.2
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyTracker, metricsTracker } from './metricsTracker.js';
import { estimateTokens } from './tokenEstimator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');

/**
 * 平滑令牌桶类
 * 实现匀速整形，防止突发流量
 */
export class SmoothTokenBucket {
  constructor(capacity, refillRatePerMs, initialBurstFactor = 0.2) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.refillRatePerMs = refillRatePerMs;
    this.tokens = Math.max(1, Math.floor(this.capacity * initialBurstFactor));
    this.lastRefill = Date.now();
    this.initialBurstFactor = initialBurstFactor;
  }

  /**
   * 补充令牌（按时间流逝）
   */
  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerMs);
      this.lastRefill = now;
    }
    return this.tokens;
  }

  /**
   * 尝试消费令牌
   * @param {number} amount - 需要消费的令牌数
   * @returns {boolean} 是否成功消费
   */
  tryConsume(amount) {
    this.refill();
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }
    return false;
  }

  /**
   * 计算等待所需时间（毫秒）
   * @param {number} amount - 需要的令牌数
   * @returns {number} 等待毫秒数
   */
  waitTimeFor(amount) {
    this.refill();
    if (this.tokens >= amount) return 0;
    const needed = amount - this.tokens;
    return Math.ceil(needed / this.refillRatePerMs);
  }

  /**
   * 重置桶（429 惩罚时使用）
   */
  penalize() {
    this.tokens = 0;
    this.lastRefill = Date.now();
  }

  /**
   * 热更新容量和速率
   */
  updateConfig(capacity, refillRatePerMs) {
    const ratio = this.tokens / this.capacity;
    this.capacity = Math.max(1, Math.floor(capacity));
    this.refillRatePerMs = refillRatePerMs;
    this.tokens = Math.max(1, Math.floor(this.capacity * ratio));
  }

  /**
   * 获取当前状态
   */
  getState() {
    this.refill();
    return {
      tokens: Math.floor(this.tokens),
      capacity: this.capacity,
      refillRatePerMs: this.refillRatePerMs,
      utilizationPercent: Math.round((1 - this.tokens / this.capacity) * 100)
    };
  }
}

/**
 * 滑动窗口统计器
 * 用于 60 秒窗口内的实时 RPM/TPM 统计
 */
export class SlidingWindowTracker {
  constructor(windowMs = 60000) {
    this.windowMs = windowMs;
    this.requests = []; // { timestamp, tokens }
  }

  /**
   * 记录一次请求
   * @param {number} tokens - 消耗的 token 数
   */
  record(tokens = 0) {
    const now = Date.now();
    this.requests.push({ timestamp: now, tokens });
    this.prune(now);
  }

  /**
   * 清理过期记录
   */
  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.requests = this.requests.filter(r => r.timestamp > cutoff);
  }

  /**
   * 获取当前窗口统计
   */
  getStats(now = Date.now()) {
    this.prune(now);
    const count = this.requests.length;
    const tokens = this.requests.reduce((sum, r) => sum + r.tokens, 0);
    return { rpm: count, tpm: tokens };
  }

  /**
   * 重置统计
   */
  reset() {
    this.requests = [];
  }
}

/**
 * 日配额熔断器
 */
export class DailyQuotaBreaker {
  constructor(limit = 0, resetHour = 0) {
    this.limit = limit; // 0 表示无限制
    this.resetHour = resetHour; // UTC 小时
    this.count = 0;
    this.lastResetDate = this.getCurrentResetDate();
    this.warnThreshold = 0.95; // 95% 告警
  }

  getCurrentResetDate() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const date = new Date(now);
    if (utcHour < this.resetHour) {
      date.setUTCDate(date.getUTCDate() - 1);
    }
    date.setUTCHours(this.resetHour, 0, 0, 0);
    return date.getTime();
  }

  checkReset() {
    const now = Date.now();
    const currentResetDate = this.getCurrentResetDate();
    if (currentResetDate > this.lastResetDate) {
      this.count = 0;
      this.lastResetDate = currentResetDate;
    }
  }

  /**
   * 尝试消费配额
   * @returns {{allowed: boolean, remaining: number, warning: boolean, error?: string}}
   */
  tryConsume() {
    this.checkReset();
    
    if (this.limit <= 0) {
      return { allowed: true, remaining: Infinity, warning: false };
    }
    
    if (this.count >= this.limit) {
      return { 
        allowed: false, 
        remaining: 0, 
        warning: false, 
        error: 'ERR_RPD_EXCEEDED' 
      };
    }
    
    this.count++;
    const remaining = this.limit - this.count;
    const warning = (this.count / this.limit) >= this.warnThreshold;
    
    return { allowed: true, remaining, warning };
  }

  getState() {
    this.checkReset();
    return {
      used: this.count,
      limit: this.limit,
      remaining: this.limit > 0 ? this.limit - this.count : Infinity,
      warning: this.limit > 0 && (this.count / this.limit) >= this.warnThreshold
    };
  }
}

/**
 * 双维度限速器主类
 */
export class DualRateLimiter extends EventEmitter {
  constructor(providerId, config = {}) {
    super();
    this.providerId = providerId;
    this.config = {
      rpm: config.rpm || 60,
      tpm: config.tpm || 0,
      rpd: config.rpd || 0,
      enabled: config.enabled !== false,
      applyToFreeModelsOnly: config.applyToFreeModelsOnly || false,
      backoffStrategy: config.backoffStrategy || 'exponential',
      fixedBackoffSeconds: config.fixedBackoffSeconds || 60,
      ...config
    };
    
    // 子限速器映射（针对特定模型）
    this.subLimiters = new Map();
    // 子限速器创建 Promise 缓存（防止竞态）
    this._subLimiterPromises = new Map();
    
    // 初始化主令牌桶
    this.initBuckets();
    
    // FIFO 等待队列
    this.queue = [];
    this.processing = false;
    
    // 统计器 - 使用全局统一的 metricsTracker
    this.dailyQuota = new DailyQuotaBreaker(this.config.rpd, 0); // UTC 0点重置
  }

  initBuckets() {
    const rpmRefillRate = this.config.rpm / 60000; // tokens per ms
    const tpmRefillRate = this.config.tpm > 0 ? this.config.tpm / 60000 : 0;
    
    this.rpmBucket = new SmoothTokenBucket(this.config.rpm, rpmRefillRate);
    this.tpmBucket = this.config.tpm > 0 
      ? new SmoothTokenBucket(this.config.tpm, tpmRefillRate)
      : null;
  }

  /**
   * 获取或创建子限速器（特定模型）
   * 当探测到的限制比主配置更严格时（RPM 或 TPM 任一更低），创建子限速器
   * 使用 Promise 缓存防止并发创建竞态
   * @returns {Promise<DualRateLimiter|null>} 子限速器实例或 null
   */
  async getSubLimiter(modelId) {
    // 检查是否已有实例
    if (this.subLimiters.has(modelId)) {
      return this.subLimiters.get(modelId);
    }
    
    // 检查是否正在创建中（防止竞态）
    if (this._subLimiterPromises.has(modelId)) {
      return this._subLimiterPromises.get(modelId);
    }
    
    // 创建 Promise 并缓存
    const promise = this._createSubLimiter(modelId);
    this._subLimiterPromises.set(modelId, promise);
    
    return promise;
  }
  
  /**
   * 内部创建子限速器逻辑
   */
  async _createSubLimiter(modelId) {
    try {
      const probedLimits = this.getProbedLimits(modelId);
      if (!probedLimits) {
        this._subLimiterPromises.delete(modelId);
        return null;
      }
      
      // 检查探测值是否比主配置更严格
      const rpmMoreRestrictive = probedLimits.rpm > 0 && probedLimits.rpm < this.config.rpm;
      const tpmMoreRestrictive = probedLimits.tpm > 0 && this.config.tpm > 0 && probedLimits.tpm < this.config.tpm;
      // 如果主配置 TPM 为 0 (无限制) 但探测到有限制，也需要创建子限速器
      const tpmMainUnlimited = this.config.tpm === 0 && probedLimits.tpm > 0;
      
      if (rpmMoreRestrictive || tpmMoreRestrictive || tpmMainUnlimited) {
        const subConfig = {
          rpm: probedLimits.rpm > 0 ? probedLimits.rpm : this.config.rpm,
          tpm: probedLimits.tpm > 0 ? probedLimits.tpm : this.config.tpm,
          rpd: 0,
          enabled: true,
          applyToFreeModelsOnly: this.config.applyToFreeModelsOnly,
          backoffStrategy: this.config.backoffStrategy,
          fixedBackoffSeconds: this.config.fixedBackoffSeconds
        };
        const subLimiter = new DualRateLimiter(`${this.providerId}:${modelId}`, subConfig);
        this.subLimiters.set(modelId, subLimiter);
        this._subLimiterPromises.delete(modelId);
        return subLimiter;
      }
      
      this._subLimiterPromises.delete(modelId);
      return null;
    } catch (error) {
      this._subLimiterPromises.delete(modelId);
      throw error;
    }
  }
  
  /**
   * 获取探测到的模型限制
   */
  getProbedLimits(modelId) {
    try {
      const probedPath = join(CONFIG_DIR, 'probed_model_limits.json');
      if (existsSync(probedPath)) {
        const content = readFileSync(probedPath, 'utf-8');
        const data = JSON.parse(content);
        return data[this.providerId]?.[modelId] || null;
      }
    } catch {}
    return null;
  }

  /**
   * 核心请求入口 - 双重令牌校验 + FIFO 排队
   */
  async acquire(request) {
    const { modelId, messages, max_tokens, isFreeModel, signal, _skipRateLimit } = request;
    
    // _skipRateLimit: 用于 NVCF 轮询等特殊请求，跳过限速扣减但仍记录统计
    if (_skipRateLimit) {
      return { allowed: true, skipped: true };
    }
    
    // applyToFreeModelsOnly: 仅对免费模型限速，付费模型直接放行
    if (this.config.applyToFreeModelsOnly && !isFreeModel) {
      return { allowed: true, bypassed: true };
    }
    
    if (!this.config.enabled) {
      return { allowed: true };
    }
    
    // 1. 日配额熔断检查
    const dailyCheck = this.dailyQuota.tryConsume();
    if (!dailyCheck.allowed) {
      throw new Error('ERR_RPD_EXCEEDED');
    }
    if (dailyCheck.warning) {
      this.emit('dailyQuotaWarning', { 
        used: this.config.rpd - dailyCheck.remaining, 
        limit: this.config.rpd 
      });
    }
    
    // 2. Token 预估（使用统一的 tokenEstimator，支持模型特定校准）
    const estimatedTokens = estimateTokens(messages, modelId, max_tokens);
    
    // 3. 检查子限速器
    const subLimiter = await this.getSubLimiter(modelId);
    if (subLimiter) {
      // 双重校验：先通过子限速器，再通过主限速器
      await subLimiter.acquire(request);
    }
    
    // 4. FIFO 排队等待（免费模型优先级较低 = 数值较大）
    const priority = isFreeModel ? 10 : 0;
    await this.queueRequest(estimatedTokens, { priority, signal });
    
    // 5. 放行瞬间扣减
    this.rpmBucket.tryConsume(1);
    if (this.tpmBucket) {
      this.tpmBucket.tryConsume(estimatedTokens);
    }
    
    // 记录滑动窗口统计（使用全局统一的 metricsTracker）
    metricsTracker.recordRequest(this.providerId, estimatedTokens);
    
    return { 
      allowed: true, 
      estimatedTokens,
      rpmState: this.rpmBucket.getState(),
      tpmState: this.tpmBucket?.getState() || null
    };
  }

  /**
   * FIFO 排队等待（支持取消、超时、优先级）
   * @param {number} estimatedTokens - 预估 token 数
   * @param {Object} options - 选项
   * @param {number} options.priority - 优先级（数值越小优先级越高，默认 0）
   * @param {number} options.timeoutMs - 最大等待超时毫秒（默认 300000 = 5 分钟）
   * @param {AbortSignal} options.signal - 可选的取消信号
   * @returns {Promise<{waitTime: number}>}
   */
  async queueRequest(estimatedTokens, options = {}) {
    const { priority = 0, timeoutMs = 300000, signal } = options;
    
    return new Promise((resolve, reject) => {
      const waitItem = {
        estimatedTokens,
        priority,
        timestamp: Date.now(),
        resolve,
        reject,
        timeoutMs,
        abortHandler: null
      };
      
      // 处理取消信号
      if (signal) {
        if (signal.aborted) {
          reject(new Error('Request aborted before queueing'));
          return;
        }
        waitItem.abortHandler = () => {
          this.removeFromQueue(waitItem);
          reject(new Error('Request aborted'));
        };
        signal.addEventListener('abort', waitItem.abortHandler, { once: true });
      }
      
      // 处理超时
      if (timeoutMs > 0) {
        waitItem.timeoutId = setTimeout(() => {
          this.removeFromQueue(waitItem);
          reject(new Error(`Queue timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      
      // 按优先级插入（优先级小的在前，同优先级按时间戳 FIFO）
      let insertIndex = this.queue.length;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].priority < priority || 
            (this.queue[i].priority === priority && this.queue[i].timestamp <= waitItem.timestamp)) {
          insertIndex = i + 1;
          break;
        }
      }
      this.queue.splice(insertIndex, 0, waitItem);
      
      this.processQueue();
    });
  }
  
  /**
   * 从队列中移除指定项
   */
  removeFromQueue(waitItem) {
    const index = this.queue.indexOf(waitItem);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
    if (waitItem.timeoutId) {
      clearTimeout(waitItem.timeoutId);
    }
    if (waitItem.abortHandler && waitItem.signal) {
      waitItem.signal.removeEventListener('abort', waitItem.abortHandler);
    }
  }

  /**
   * 处理队列
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const item = this.queue[0];
      
      // 计算等待时间
      const rpmWait = this.rpmBucket.waitTimeFor(1);
      const tpmWait = this.tpmBucket ? this.tpmBucket.waitTimeFor(item.estimatedTokens) : 0;
      const waitMs = Math.max(rpmWait, tpmWait);
      
      if (waitMs <= 0) {
        // 可以立即放行
        this.queue.shift();
        if (item.timeoutId) clearTimeout(item.timeoutId);
        if (item.abortHandler && item.signal) {
          item.signal.removeEventListener('abort', item.abortHandler);
        }
        item.resolve({ waitTime: 0 });
      } else {
        // 需要等待
        await new Promise(r => setTimeout(r, waitMs));
        // 循环继续检查
      }
    }
    
    this.processing = false;
  }

  /**
   * 响应后结算 - 多退少补
   */
  settle(actualTokens, estimatedTokens) {
    if (!this.tpmBucket) return;
    
    const diff = actualTokens - estimatedTokens;
    if (diff !== 0) {
      // 多退少补
      const newTokens = this.tpmBucket.tokens - diff;
      this.tpmBucket.tokens = Math.max(0, Math.min(this.tpmBucket.capacity, newTokens));
    }
    
    // 子限速器也需要结算
    for (const subLimiter of this.subLimiters.values()) {
      subLimiter.settle(actualTokens, estimatedTokens);
    }
  }

  /**
   * 429 惩罚 - 清空双桶
   */
  penalizeOn429(modelId, actualRpm, actualTpm) {
    // 记录滑动窗口瞬时统计（使用全局统一的 metricsTracker）
    const stats = metricsTracker.getCurrentStats(this.providerId);
    
    // 清空主桶
    this.rpmBucket.penalize();
    if (this.tpmBucket) this.tpmBucket.penalize();
    
    // 清空子桶
    for (const subLimiter of this.subLimiters.values()) {
      subLimiter.rpmBucket.penalize();
      if (subLimiter.tpmBucket) subLimiter.tpmBucket.penalize();
    }
    
    // 记录历史 - 委托给统一的 historyTracker
    historyTracker.record429(this.providerId, stats.rpm, stats.tpm, modelId);
    
    this.emit('penalized', { providerId: this.providerId, modelId, actualRpm: stats.rpm, actualTpm: stats.tpm });
  }

  /**
   * 获取历史建议值 - 委托给统一的 historyTracker
   */
  getHistorySuggestion() {
    return historyTracker.getSuggestion(this.providerId);
  }

  /**
   * 清空历史 - 委托给统一的 historyTracker
   */
  clearHistory() {
    historyTracker.clearHistory(this.providerId);
  }

  /**
   * 热更新配置（同时传播给子限速器）
   */
  updateConfig(newConfig) {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };
    this.initBuckets();
    this.dailyQuota = new DailyQuotaBreaker(this.config.rpd, 0);
    
    // 传播配置变更到子限速器
    for (const [modelId, subLimiter] of this.subLimiters) {
      const subConfig = {
        rpm: subLimiter.config.rpm,
        tpm: subLimiter.config.tpm,
        backoffStrategy: this.config.backoffStrategy,
        fixedBackoffSeconds: this.config.fixedBackoffSeconds,
        applyToFreeModelsOnly: this.config.applyToFreeModelsOnly
      };
      subLimiter.updateConfig(subConfig);
    }
    
    this.emit('configUpdated', this.config);
  }

  /**
   * 获取实时监控状态
   */
  getMonitorState() {
    const windowStats = metricsTracker.getCurrentStats(this.providerId);
    const dailyState = this.dailyQuota.getState();
    
    return {
      providerId: this.providerId,
      queueLength: this.queue.length,
      rpm: windowStats.rpm,
      rpmLimit: this.config.rpm,
      tpm: windowStats.tpm,
      tpmLimit: this.config.tpm,
      dailyUsed: dailyState.used,
      dailyLimit: dailyState.limit,
      rpmBucket: this.rpmBucket.getState(),
      tpmBucket: this.tpmBucket?.getState() || null,
      config: this.config
    };
  }
}

/**
 * 限速器管理器 - 管理多个 Provider 的限速器实例
 */
export class RateLimiterManager extends EventEmitter {
  constructor() {
    super();
    this.limiters = new Map();
  }

  getLimiter(providerId, config) {
    if (!this.limiters.has(providerId)) {
      const limiter = new DualRateLimiter(providerId, config);
      this.limiters.set(providerId, limiter);
      
      // 转发事件
      limiter.on('penalized', (data) => this.emit('penalized', data));
      limiter.on('dailyQuotaWarning', (data) => this.emit('dailyQuotaWarning', data));
      limiter.on('configUpdated', (data) => this.emit('configUpdated', { providerId, ...data }));
    }
    return this.limiters.get(providerId);
  }

  getAllLimiters() {
    return Array.from(this.limiters.values());
  }

  removeLimiter(providerId) {
    this.limiters.delete(providerId);
  }
}

export default {
  DualRateLimiter,
  RateLimiterManager,
  SmoothTokenBucket,
  SlidingWindowTracker,
  DailyQuotaBreaker
};