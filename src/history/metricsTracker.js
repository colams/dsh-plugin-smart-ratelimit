/**
 * Metrics Tracker - 滑动窗口实时统计器 & 429 历史记录器
 * 对应规格书 §4
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigPaths } from '../config/configPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = ConfigPaths.history;

/**
 * 滑动窗口指标追踪器
 * 维护 60 秒窗口内的请求数和 Token 消耗
 */
export class MetricsTracker {
  constructor(windowMs = 60000) {
    this.windowMs = windowMs;
    this.windows = new Map(); // providerId -> { requests: [], tokens: [] }
  }

  /**
   * 记录请求
   * @param {string} providerId 
   * @param {number} tokens 
   */
  recordRequest(providerId, tokens = 0) {
    const now = Date.now();
    if (!this.windows.has(providerId)) {
      this.windows.set(providerId, { requests: [], tokens: [] });
    }
    
    const window = this.windows.get(providerId);
    window.requests.push({ timestamp: now, count: 1 });
    window.tokens.push({ timestamp: now, tokens });
    
    this.prune(window, now);
  }

  /**
   * 清理过期数据
   */
  prune(window, now) {
    const cutoff = now - this.windowMs;
    window.requests = window.requests.filter(r => r.timestamp > cutoff);
    window.tokens = window.tokens.filter(t => t.timestamp > cutoff);
  }

  /**
   * 获取当前窗口统计
   * @param {string} providerId 
   * @returns {{rpm: number, tpm: number}}
   */
  getCurrentStats(providerId) {
    const window = this.windows.get(providerId);
    if (!window) return { rpm: 0, tpm: 0 };
    
    const now = Date.now();
    this.prune(window, now);
    
    const rpm = window.requests.reduce((sum, r) => sum + r.count, 0);
    const tpm = window.tokens.reduce((sum, t) => sum + t.tokens, 0);
    
    return { rpm, tpm };
  }

  /**
   * 获取所有 Provider 的统计
   */
  getAllStats() {
    const stats = {};
    for (const providerId of this.windows.keys()) {
      stats[providerId] = this.getCurrentStats(providerId);
    }
    return stats;
  }

  /**
   * 重置指定 Provider 的统计
   */
  reset(providerId) {
    this.windows.delete(providerId);
  }
}

/**
 * 429 历史追踪器
 * 负责记录 429 触发历史、计算安全值推荐
 */
export class HistoryTracker {
  constructor(historyFile = HISTORY_FILE) {
    this.historyFile = historyFile;
    this.history = this.loadHistory();
  }

  loadHistory() {
    try {
      if (existsSync(this.historyFile)) {
        return JSON.parse(readFileSync(this.historyFile, 'utf-8'));
      }
    } catch (error) {
      console.warn('[HistoryTracker] Failed to load history:', error.message);
    }
    return {};
  }

  saveHistory() {
    try {
      writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    } catch (error) {
      console.error('[HistoryTracker] Failed to save history:', error.message);
    }
  }

  /**
   * 记录 429 触发事件
   * @param {string} providerId 
   * @param {number} triggeredRpm - 触发时的瞬时 RPM
   * @param {number} triggeredTpm - 触发时的瞬时 TPM
   * @param {string} modelId - 触发的模型
   */
  record429(providerId, triggeredRpm, triggeredTpm, modelId) {
    if (!this.history[providerId]) {
      this.history[providerId] = {
        lastTriggeredAt: null,
        triggeredAtRpm: null,
        triggeredAtTpm: null,
        model: null,
        suggestedSafeRpm: null,
        suggestedSafeTpm: null,
        total429Count: 0,
        records: []
      };
    }

    const providerHistory = this.history[providerId];
    const timestamp = new Date().toISOString();
    
    providerHistory.lastTriggeredAt = timestamp;
    providerHistory.triggeredAtRpm = triggeredRpm;
    providerHistory.triggeredAtTpm = triggeredTpm;
    providerHistory.model = modelId;
    providerHistory.total429Count++;

    // 添加到记录列表
    providerHistory.records.push({
      timestamp,
      rpm: triggeredRpm,
      tpm: triggeredTpm,
      model: modelId
    });

    // 保留最近 20 条记录
    if (providerHistory.records.length > 20) {
      providerHistory.records.shift();
    }

    // 重新计算安全值
    this.recalculateSafeValues(providerId);

    this.saveHistory();
    return this.getSuggestion(providerId);
  }

  /**
   * 重新计算安全值
   * 公式：历史最低触发阈值 * 0.9
   */
  recalculateSafeValues(providerId) {
    const providerHistory = this.history[providerId];
    if (!providerHistory || providerHistory.records.length === 0) return;

    const minRpm = Math.min(...providerHistory.records.map(r => r.rpm));
    const minTpm = Math.min(...providerHistory.records.map(r => r.tpm));

    providerHistory.suggestedSafeRpm = Math.max(1, Math.floor(minRpm * 0.9));
    providerHistory.suggestedSafeTpm = Math.max(1, Math.floor(minTpm * 0.9));
  }

  /**
   * 获取安全值建议
   */
  getSuggestion(providerId) {
    const providerHistory = this.history[providerId];
    if (!providerHistory) return null;

    return {
      suggestedSafeRpm: providerHistory.suggestedSafeRpm,
      suggestedSafeTpm: providerHistory.suggestedSafeTpm,
      lastTriggeredAt: providerHistory.lastTriggeredAt,
      triggeredAtRpm: providerHistory.triggeredAtRpm,
      triggeredAtTpm: providerHistory.triggeredAtTpm,
      model: providerHistory.model,
      total429Count: providerHistory.total429Count,
      hasHistory: providerHistory.total429Count > 0
    };
  }

  /**
   * 获取完整历史
   */
  getHistory(providerId) {
    return this.history[providerId] || null;
  }

  /**
   * 获取所有历史
   */
  getAllHistory() {
    return this.history;
  }

  /**
   * 清空指定 Provider 的历史
   */
  clearHistory(providerId) {
    if (this.history[providerId]) {
      delete this.history[providerId];
      this.saveHistory();
      return true;
    }
    return false;
  }

  /**
   * 清空所有历史
   */
  clearAllHistory() {
    this.history = {};
    this.saveHistory();
  }

  /**
   * 判断是否应该显示历史提示
   * @returns {boolean}
   */
  shouldShowWarning(providerId) {
    const suggestion = this.getSuggestion(providerId);
    return suggestion?.hasHistory === true;
  }
}

/**
 * 统一导出实例（单例模式）
 */
export const metricsTracker = new MetricsTracker();
export const historyTracker = new HistoryTracker();

export default {
  MetricsTracker,
  HistoryTracker,
  metricsTracker,
  historyTracker
};