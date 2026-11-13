/**
 * Provider Discovery Module
 * 自动扫描 DSH 配置，提取 Provider 列表与显示名
 * 对应规格书 §2.1, §5.1
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { ConfigPaths } from './configPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 获取可能的 DSH 配置文件路径列表
 * 优先级：环境变量 > 桌面端配置 > 兼容旧版路径
 */
function getCandidateConfigPaths() {
  const paths = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  
  // 1. 环境变量指定的路径（最高优先级）
  if (process.env.DSH_CONFIG_PATH) {
    paths.push(process.env.DSH_CONFIG_PATH);
  }
  
  // 2. 标准桌面端配置
  paths.push(join(homeDir, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'));
  
  // 3. 兼容：旧版配置路径
  paths.push(join(homeDir, '.dsh', 'cordis.patch.yml'));
  paths.push(join(homeDir, '.config', 'dsh', 'profiles', 'desktop', 'cordis.patch.yml'));
  
  // 4. Linux/macOS 标准配置目录
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homeDir, '.config');
  paths.push(join(xdgConfig, 'dsh', 'profiles', 'desktop', 'cordis.patch.yml'));
  
  return paths;
}

/**
 * 从 DSH 配置文件中解析所有已配置的 Provider
 * @returns {Promise<Array<{id: string, displayName: string, baseUrl: string}>>}
 */
export async function discoverProviders() {
  const providers = [];
  
  try {
    // 尝试读取所有候选配置路径，取第一个存在的
    const candidatePaths = getCandidateConfigPaths();
    let configContent = '';
    let usedPath = null;
    
    for (const path of candidatePaths) {
      if (existsSync(path)) {
        try {
          configContent = readFileSync(path, 'utf-8');
          usedPath = path;
          break;
        } catch (e) {
          // 读取失败，尝试下一个
          continue;
        }
      }
    }
    
    if (!configContent) {
      console.log('[ProviderDiscovery] No config file found, using defaults');
      return getDefaultProviders();
    }
    
    console.log('[ProviderDiscovery] Using config:', usedPath);
    
    // 使用 js-yaml 正规解析 YAML
    const parsed = load(configContent);
    
    if (!Array.isArray(parsed)) {
      console.warn('[ProviderDiscovery] Unexpected YAML structure, using defaults');
      return getDefaultProviders();
    }
    
    const seen = new Set();

    // 只收集 llm-pi-ai 下配置的 provider。DSH 内置的 DeepSeek 账号 / DeepSeek 直连
    // 由官方插件自己管理限速，本插件不再把它们列入服务商列表。
    for (const entry of parsed) {
      if (!entry || entry.id !== 'llm-pi-ai' || !entry.config || !entry.config.providers) continue;
      for (const [providerId, providerConfig] of Object.entries(entry.config.providers)) {
        if (!providerConfig || typeof providerConfig !== 'object') continue;
        const id = providerId.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        providers.push({
          id,
          displayName: providerConfig.displayName || providerId,
          baseUrl: providerConfig.baseURL || inferBaseUrl(providerId)
        });
      }
    }

    // 没有发现任何 provider 时回退到默认预设
    if (providers.length === 0) {
      return getDefaultProviders();
    }

    return providers;
  } catch (error) {
    console.warn('[ProviderDiscovery] Failed to discover providers, using defaults:', error.message);
    return getDefaultProviders();
  }
}

/**
 * 根据 provider ID 推断显示名称
 */
function formatDisplayName(id) {
  const displayNames = {
    'nvidia': 'NVIDIA NIM',
    'nvidia-nim': 'NVIDIA NIM',
    'build.nvidia.com': 'NVIDIA NIM',
    'integrate.api.nvidia.com': 'NVIDIA NIM',
    'agnes': 'Agnes AI 官方站',
    'agnes-ai': 'Agnes AI 官方站',
    'api.agnes-ai.cn': 'Agnes AI 官方站',
    'sensenova-me': 'SenseNova ME',
    'siliconflow': 'SiliconFlow',
    'opencode-go': 'OpenCode Go',
    'deepseek': 'DeepSeek API',
    'deepseek-account': 'DeepSeek 账号'
  };
  
  return displayNames[id.toLowerCase()] || id;
}

/**
 * 根据 provider ID 推断基础 URL
 */
function inferBaseUrl(id) {
  const baseUrls = {
    'nvidia': 'https://integrate.api.nvidia.com/v1',
    'nvidia-nim': 'https://integrate.api.nvidia.com/v1',
    'build.nvidia.com': 'https://integrate.api.nvidia.com/v1',
    'integrate.api.nvidia.com': 'https://integrate.api.nvidia.com/v1',
    'agnes': 'https://api.agnes-ai.cn/v1',
    'agnes-ai': 'https://api.agnes-ai.cn/v1',
    'api.agnes-ai.cn': 'https://api.agnes-ai.cn/v1',
    'sensenova-me': 'https://token.sensenova.cn',
    'siliconflow': 'https://api.siliconflow.cn/v1',
    'opencode-go': '',
    'deepseek': 'https://api.deepseek.com/v1',
    'deepseek-account': 'https://api.deepseek.com/v1'
  };
  
  return baseUrls[id.toLowerCase()] || '';
}

/**
 * 获取默认预设中的 Provider 列表
 */
function getDefaultProviders() {
  const defaultPresets = readDefaultPresets();
  return Object.entries(defaultPresets).map(([id, preset]) => ({
    id,
    displayName: preset.displayName,
    baseUrl: ''
  })).filter(p => p.id !== 'default');
}

/**
 * 读取默认预设配置
 */
function readDefaultPresets() {
  try {
    const content = readFileSync(ConfigPaths.presets, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * 获取指定 Provider 的默认配置
 * @param {string} providerId 
 * @returns {Object|null}
 */
export function getDefaultConfig(providerId) {
  const defaultPresets = readDefaultPresets();
  return defaultPresets[providerId.toLowerCase()] || defaultPresets.default || null;
}

/**
 * 获取所有默认预设
 */
export function getAllDefaultPresets() {
  return readDefaultPresets();
}

export default {
  discoverProviders,
  getDefaultConfig,
  getAllDefaultPresets
};