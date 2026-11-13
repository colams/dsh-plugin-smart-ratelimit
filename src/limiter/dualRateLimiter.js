/**
 * Dual Rate Limiter - 核心引擎
 * RPM + TPM 双维度令牌桶与 FIFO 队列、RPD 熔断、热更新
 * 对应规格书 §3, §3.1, §3.2
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyTracker, metricsTracker } from '../history/metricsTracker.js';
import { estimateTokens } from '../core/tokenEstimator.js';
import { ConfigPaths } from '../config/configPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = ConfigPaths.dir;

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

  /**
   * 请求前检查日配额是否已熔断（不推进计数；计数由 recordDailyQuotaUsage 在响应成功后推进）
   * @returns {{allowed: boolean, error?: string, warning: boolean, remaining: number}}
   */
  checkDailyQuota() {
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
    
    const remaining = this.limit - this.count;
    const warning = (this.count / this.limit) >= this.warnThreshold;
    return { allowed: true, remaining, warning };
  }

  /**
   * 响应成功后推进日配额计数（仅成功请求才消耗配额）
   * @returns {{warning: boolean, remaining: number}}
   */
  recordUsage() {
    this.checkReset();
    if (this.limit <= 0) return { warning: false, remaining: Infinity };
    
    this.count++;
    const remaining = this.limit - this.count;
    const warning = (this.count / this.limit) >= this.warnThreshold;
    return { warning, remaining };
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
      // 默认开启：只对免费档模型限速。显式传 false 才关闭。
      applyToFreeModelsOnly: config.applyToFreeModelsOnly !== false,
      backoffStrategy: config.backoffStrategy || 'auto',
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
   * @param {Object} request
   * @param {boolean} [request._skipMetrics] - 子限速器 acquire 时传入，
   *   避免同一请求在子桶与主桶各向 metricsTracker 记录一次导致滑动窗口 RPM 翻倍。
   */
  async acquire(request) {
    const { modelId, messages, max_tokens, isFreeModel, signal, _skipRateLimit, timeoutMs, _skipMetrics } = request;
    
    // _skipRateLimit: 用于 NVCF 轮询等特殊请求，跳过限速扣减但不记录统计
    // （规格书 §3：轮询请求不重复扣减 RPM/TPM）
    if (_skipRateLimit) {
      return { allowed: true, skipped: true };
    }
    
    // applyToFreeModelsOnly: 仅对免费模型限速，付费模型直接放行。
    // 只有调用方明确标记 isFreeModel === false（付费/高配额）才绕过；
    // 未标记的请求按限速处理，避免默认开启后误放行。
    if (this.config.applyToFreeModelsOnly && isFreeModel === false) {
      return { allowed: true, bypassed: true };
    }
    
    if (!this.config.enabled) {
      return { allowed: true };
    }
    
    // 1. 日配额熔断检查（只检查是否已耗尽，不推进计数；
    // 计数由拦截器在响应成功后调用 dailyQuota.recordUsage() 推进，
    // 避免 429/失败请求虚高 RPD 计数）
    const dailyCheck = this.dailyQuota.checkDailyQuota();
    if (!dailyCheck.allowed) {
      throw new Error('ERR_RPD_EXCEEDED');
    }
    if (dailyCheck.warning) {
      this.emit('dailyQuotaWarning', { 
        used: this.dailyQuota.count, 
        limit: this.config.rpd 
      });
    }
    
    // 2. Token 预估（使用统一的 tokenEstimator，支持模型特定校准）
    const estimatedTokens = estimateTokens(messages, modelId, max_tokens);
    
    // 3. 检查子限速器
    const subLimiter = await this.getSubLimiter(modelId);
    if (subLimiter) {
      // 双重校验：先通过子限速器，再通过主限速器
      // 标记 _skipMetrics：子桶放行后不重复记录滑动窗口统计（由主限速器统一记录一次）
      await subLimiter.acquire({ ...request, _skipMetrics: true });
    }
    
    // 4. FIFO 排队等待（免费模型优先级较低 = 数值较大）
    const priority = isFreeModel ? 10 : 0;
    await this.queueRequest(estimatedTokens, { priority, signal, timeoutMs });
    
    // 5. 放行瞬间扣减
    this.rpmBucket.tryConsume(1);
    if (this.tpmBucket) {
      this.tpmBucket.tryConsume(estimatedTokens);
    }
    
    // 记录滑动窗口统计（使用全局统一的 metricsTracker）
    // 仅由调用链的顶层（主限速器）记录一次；子限速器以 _skipMetrics 调用时跳过，
    // 避免同一请求在子桶与主桶各记一次导致 60s 窗口 RPM/TPM 翻倍
    if (!_skipMetrics) {
      metricsTracker.recordRequest(this.providerId, estimatedTokens);
    }
    
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
   * 真正的优先级调度：每轮取队列中优先级最高（数值最小）的一项处理；
   * 高优先级请求入队后会"插队"到正在等待的低优先级请求前面，
   * 等待中的低优先级请求不会独占调度循环，分段 sleep 唤醒后重新评估队首
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    const POLL_INTERVAL = 100; // 100ms 轮询间隔，允许快速响应取消/超时
    const TICK_INTERVAL = 20;   // 20ms 一次调度重评估，让新入队的高优先级请求尽快插队
    
    while (this.queue.length > 0) {
      // 按优先级 + 时间戳选出队首（高优先级先处理；同优先级 FIFO）
      let headIndex = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[headIndex];
        if (a.priority < b.priority ||
            (a.priority === b.priority && a.timestamp <= b.timestamp)) {
          headIndex = i;
        }
      }
      const item = this.queue[headIndex];
      
      // 检查当前项是否已被取消/超时（从队列移除）
      if (!this.queue.includes(item)) {
        continue; // 已被移除，重新评估队首
      }
      
      // 计算等待时间
      const rpmWait = this.rpmBucket.waitTimeFor(1);
      const tpmWait = this.tpmBucket ? this.tpmBucket.waitTimeFor(item.estimatedTokens) : 0;
      const waitMs = Math.max(rpmWait, tpmWait);
      
      if (waitMs <= 0) {
        // 可以立即放行：按当前位置移除队首（而非 shift，保持相对顺序）
        this.queue.splice(headIndex, 1);
        if (item.timeoutId) clearTimeout(item.timeoutId);
        if (item.abortHandler && item.signal) {
          item.signal.removeEventListener('abort', item.abortHandler);
        }
        item.resolve({ waitTime: 0 });
      } else {
        // 需要等待 - 分段等待，每 TICK_INTERVAL 重新评估一次调度
        // （新入队的高优先级请求会在下个 tick 插队；当前项若被取消/超时则自动出列）
        let remainingMs = waitMs;
        while (remainingMs > 0 && this.queue.includes(item)) {
          const sleepMs = Math.min(remainingMs, TICK_INTERVAL);
          await new Promise(r => setTimeout(r, sleepMs));
          remainingMs -= sleepMs;
        }
        // 循环继续，重新选队首（item 可能已不再是队首或已被移除）
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
   * @param {Object} options
   * @param {string} options.modelId - 触发 429 的模型
   * @param {boolean} [options.recordHistory=true] - 是否记录 429 历史。
   *   调用方（requestInterceptor.handle429）若已在外部调用 historyTracker.record429，
   *   应传 false 避免同一次 429 被重复写入历史、total429Count 翻倍。
   */
  penalizeOn429(modelId, actualRpm, actualTpm, options = {}) {
    const { recordHistory = true } = options;
    
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
    
    // 记录历史 - 委托给统一的 historyTracker（仅当调用方未自行记录时）
    if (recordHistory) {
      historyTracker.record429(this.providerId, stats.rpm, stats.tpm, modelId);
    }
    
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
   * 注意：保留现有日配额计数与滑动窗口统计，避免保存设置一次就清零 RPD 计数，
   * 导致 NVIDIA 日配额保护失效。
   */
  updateConfig(newConfig) {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };
    
    // 令牌桶热更新：按容量比例保留当前水位，而非重建（重建会使初始突发 20% 规则生效，
    // 把刚用掉的桶水位错误重置）
    const rpmRefillRate = this.config.rpm / 60000;
    const tpmRefillRate = this.config.tpm > 0 ? this.config.tpm / 60000 : 0;
    
    if (this.rpmBucket) {
      this.rpmBucket.updateConfig(this.config.rpm, rpmRefillRate);
    } else {
      this.rpmBucket = new SmoothTokenBucket(this.config.rpm, rpmRefillRate);
    }
    
    if (this.config.tpm > 0) {
      if (this.tpmBucket) {
        this.tpmBucket.updateConfig(this.config.tpm, tpmRefillRate);
      } else {
        this.tpmBucket = new SmoothTokenBucket(this.config.tpm, tpmRefillRate);
      }
    } else {
      this.tpmBucket = null;
    }
    
    // 日配额：limit 变化时同步上限，但保留已用计数（仅当 limit 变大或相等时保留；
    // limit 变小且已用超出新上限时按新上限裁剪，避免负数 remaining）
    if (this.config.rpd !== this.dailyQuota.limit) {
      const used = Math.min(this.dailyQuota.count, this.config.rpd);
      this.dailyQuota.limit = this.config.rpd;
      this.dailyQuota.count = used;
    }
    
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