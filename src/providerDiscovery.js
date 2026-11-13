/**
 * Provider Discovery Module
 * 自动扫描 DSH 配置，提取 Provider 列表与显示名
 * 对应规格书 §2.1, §5.1
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');

/**
 * 从 DSH 配置文件中解析所有已配置的 Provider
 * @returns {Promise<Array<{id: string, displayName: string, baseUrl: string}>>}
 */
export async function discoverProviders() {
  const providers = [];
  
  try {
    // 尝试读取 DSH 桌面端配置
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const cordisConfigPath = join(homeDir, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    
    let configContent = '';
    try {
      configContent = readFileSync(cordisConfigPath, 'utf-8');
    } catch {
      // 如果读取失败，返回默认预设中的 providers
      return getDefaultProviders();
    }
    
    // 使用 js-yaml 正规解析 YAML
    const parsed = load(configContent);
    
    if (!Array.isArray(parsed)) {
      console.warn('[ProviderDiscovery] Unexpected YAML structure, using defaults');
      return getDefaultProviders();
    }
    
    // 查找 llm-pi-ai 插件配置中的 providers
    for (const entry of parsed) {
      if (entry && entry.id === 'llm-pi-ai' && entry.config && entry.config.providers) {
        const providerConfigs = entry.config.providers;
        
        for (const [providerId, providerConfig] of Object.entries(providerConfigs)) {
          if (providerConfig && typeof providerConfig === 'object') {
            providers.push({
              id: providerId.toLowerCase(),
              displayName: providerConfig.displayName || formatDisplayName(providerId),
              baseUrl: providerConfig.baseURL || inferBaseUrl(providerId)
            });
          }
        }
        
        // 找到 llm-pi-ai 配置后即可返回，不再继续查找
        if (providers.length > 0) {
          return providers;
        }
      }
    }
    
    // 如果没在 llm-pi-ai 中找到，回退到默认预设
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
    const presetPath = join(CONFIG_DIR, 'default_presets.json');
    const content = readFileSync(presetPath, 'utf-8');
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