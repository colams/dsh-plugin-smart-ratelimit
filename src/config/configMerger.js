/**
 * Config Merger - 配置优先级合并器
 * 实现规格书 §2.1 定义的 5 层配置优先级合并链
 * 1. 用户自定义覆盖配置 (user_custom)
 * 2. 自动探测与历史校准值 (probed / history_calibrated)
 * 3. 系统自动配置中已声明的速率参数 (system_auto)
 * 4. 内置 Provider 默认规则 (default_preset)
 * 5. 全局兜底策略 (global_fallback)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { ConfigPaths } from './configPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 配置优先级常量（数值越大优先级越高）
 */
export const CONFIG_PRIORITY = {
  GLOBAL_FALLBACK: 1,      // 第5层：全局兜底策略
  DEFAULT_PRESET: 2,       // 第4层：内置默认预设
  SYSTEM_AUTO: 3,          // 第3层：系统自动配置
  HISTORY_CALIBRATED: 4,   // 第2层：历史校准值
  PROBED: 4,               // 第2层：自动探测值
  USER_CUSTOM: 5           // 第1层：用户自定义覆盖
};

/**
 * 获取全局兜底配置（第5层）
 */
export function getGlobalFallbackConfig() {
  return {
    rpm: 60,
    tpm: 0,
    rpd: 0,
    enabled: true,
    applyToFreeModelsOnly: true,
    backoffStrategy: 'auto',
    fixedBackoffSeconds: 60,
    priority: 'global_fallback'
  };
}

/**
 * 获取默认预设配置（第4层）
 */
export function getDefaultPresetConfig(providerId) {
  try {
    if (existsSync(ConfigPaths.presets)) {
      const presets = JSON.parse(readFileSync(ConfigPaths.presets, 'utf-8'));
      const preset = presets[providerId.toLowerCase()] || presets.default;
      if (preset) {
        return {
          ...preset,
          priority: 'default_preset'
        };
      }
    }
  } catch {}
  return null;
}

/**
 * 获取系统自动配置（第3层）- 从 DSH cordis 配置读取
 */
export function getSystemAutoConfig(providerId) {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const cordisConfigPath = join(homeDir, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    
    const configContent = readFileSync(cordisConfigPath, 'utf-8');
    const parsed = load(configContent);
    
    if (!Array.isArray(parsed)) return null;
    
    for (const entry of parsed) {
      if (entry && entry.id === 'llm-pi-ai' && entry.config && entry.config.providers) {
        const providerConfigs = entry.config.providers;
        const config = providerConfigs[providerId] || providerConfigs[providerId.toLowerCase()];
        if (config && typeof config === 'object') {
          return {
            rpm: config.rpm,
            tpm: config.tpm,
            rpd: config.rpd,
            enabled: config.enabled !== false,
            applyToFreeModelsOnly: config.applyToFreeModelsOnly,
            backoffStrategy: config.backoffStrategy,
            fixedBackoffSeconds: config.fixedBackoffSeconds,
            priority: 'system_auto'
          };
        }
      }
    }
  } catch {}
  return null;
}

/**
 * 获取探测/历史校准配置（第2层）
 */
export function getProbedAndHistoryConfig(providerId) {
  const result = {};
  let hasProbed = false;
  let hasHistory = false;
  
  // 读取探测结果
  try {
    if (existsSync(ConfigPaths.probed)) {
      const probedData = JSON.parse(readFileSync(ConfigPaths.probed, 'utf-8'));
      const providerProbed = probedData[providerId.toLowerCase()];
      if (providerProbed) {
        // 取所有模型中最严格的限制作为主配置
        let minRpm = Infinity;
        let minTpm = Infinity;
        for (const modelLimits of Object.values(providerProbed)) {
          if (modelLimits.rpm > 0) minRpm = Math.min(minRpm, modelLimits.rpm);
          if (modelLimits.tpm > 0) minTpm = Math.min(minTpm, modelLimits.tpm);
        }
        if (minRpm !== Infinity) {
          result.rpm = minRpm;
          hasProbed = true;
        }
        if (minTpm !== Infinity) {
          result.tpm = minTpm;
          hasProbed = true;
        }
      }
    }
  } catch {}
  
  // 读取历史建议值（优先级更高，因为基于真实 429 触发点）
  try {
    if (existsSync(ConfigPaths.history)) {
      const historyData = JSON.parse(readFileSync(ConfigPaths.history, 'utf-8'));
      const providerHistory = historyData[providerId.toLowerCase()];
      if (providerHistory && providerHistory.suggestedSafeRpm) {
        result.rpm = providerHistory.suggestedSafeRpm;
        result.tpm = providerHistory.suggestedSafeTpm || result.tpm;
        hasHistory = true;
      }
    }
  } catch {}
  
  if (hasHistory || hasProbed) {
    result.priority = hasHistory ? 'history_calibrated' : 'probed';
    return result;
  }
  return null;
}

/**
 * 获取用户自定义配置（第1层）
 */
export function getUserCustomConfig(providerId) {
  try {
    if (existsSync(ConfigPaths.settings)) {
      const settings = JSON.parse(readFileSync(ConfigPaths.settings, 'utf-8'));
      const config = settings[providerId.toLowerCase()];
      if (config) {
        return {
          ...config,
          priority: 'user_custom'
        };
      }
    }
  } catch {}
  return null;
}

/**
 * 合并配置 - 按优先级从低到高依次应用
 * @param {string} providerId 
 * @returns {Object} 合并后的完整配置
 */
/**
 * 只合并「已定义」的字段。
 * 上层配置经常只声明部分字段（例如 DSH 的 provider 只写了 retryPolicy，
 * 没有 rpm/tpm），若直接展开会把底层的兜底值覆盖成 undefined，
 * 导致限速器拿不到 RPM、退化成 bypass。
 */
function mergeDefined(base, layer) {
  if (!layer) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function mergeProviderConfig(providerId) {
  const id = providerId.toLowerCase();
  
  // 第5层：全局兜底（基础）
  let merged = getGlobalFallbackConfig();
  
  // 第4层：默认预设
  const defaultPreset = getDefaultPresetConfig(id);
  if (defaultPreset) {
    merged = mergeDefined(merged, defaultPreset);
  }
  
  // 第3层：系统自动配置
  const systemAuto = getSystemAutoConfig(id);
  if (systemAuto) {
    merged = mergeDefined(merged, systemAuto);
  }
  
  // 第2层：探测/历史校准
  const probedHistory = getProbedAndHistoryConfig(id);
  if (probedHistory) {
    merged = mergeDefined(merged, probedHistory);
  }
  
  // 第1层：用户自定义（最高优先级）
  const userCustom = getUserCustomConfig(id);
  if (userCustom) {
    merged = mergeDefined(merged, userCustom);
  }
  
  return merged;
}

/**
 * 获取配置来源说明（用于 UI 显示）
 */
export function getConfigSourceDescription(priority) {
  const descriptions = {
    'user_custom': '用户自定义配置',
    'history_calibrated': '历史校准值（基于 429 触发记录）',
    'probed': '自动探测值',
    'system_auto': '系统自动读取配置',
    'default_preset': '默认预设',
    'global_fallback': '全局兜底策略'
  };
  return descriptions[priority] || priority;
}

/**
 * 获取配置优先级数值（用于比较）
 */
export function getPriorityValue(priority) {
  return CONFIG_PRIORITY[priority.toUpperCase()] || 0;
}

export default {
  CONFIG_PRIORITY,
  mergeProviderConfig,
  getGlobalFallbackConfig,
  getDefaultPresetConfig,
  getSystemAutoConfig,
  getProbedAndHistoryConfig,
  getUserCustomConfig,
  getConfigSourceDescription,
  getPriorityValue
};