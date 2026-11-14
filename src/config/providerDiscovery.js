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
 * 优先级：环境变量（支持逗号分隔多路径）> 桌面端配置 > 兼容旧版路径
 * 返回数组，按优先级排序（越前越高）
 */
function getCandidateConfigPaths() {
  const paths = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  
  // 1. 环境变量指定的路径（最高优先级），支持逗号分隔多路径
  if (process.env.DSH_CONFIG_PATH) {
    const envPaths = process.env.DSH_CONFIG_PATH.split(',').map(p => p.trim()).filter(Boolean);
    paths.push(...envPaths);
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
 * 遍历所有存在的配置文件（按优先级），合并 provider 列表
 * 同一 providerId 以首次出现（优先级最高的文件）为准，标记来源文件
 * @returns {Promise<Array<{id: string, displayName: string, baseUrl: string, sourceFile?: string}>>}
 */
export async function discoverProviders() {
  const providers = [];
  const seen = new Set(); // 已见过的 providerId，用于去重
  
  try {
    // 获取所有候选路径，筛选存在的文件
    const candidatePaths = getCandidateConfigPaths();
    const existingPaths = candidatePaths.filter(p => existsSync(p));
    
    if (existingPaths.length === 0) {
      console.log('[ProviderDiscovery] No config file found, using defaults');
      return getDefaultProviders();
    }
    
    console.log('[ProviderDiscovery] Found configs:', existingPaths.join(', '));
    
    // 按优先级顺序遍历每个配置文件，合并 provider
    for (const configPath of existingPaths) {
      let configContent;
      try {
        configContent = readFileSync(configPath, 'utf-8');
      } catch (e) {
        console.warn('[ProviderDiscovery] Failed to read:', configPath, e.message);
        continue;
      }
      
      let parsed;
      try {
        parsed = load(configContent);
      } catch (e) {
        console.warn('[ProviderDiscovery] Failed to parse YAML:', configPath, e.message);
        continue;
      }
      
      if (!Array.isArray(parsed)) {
        console.warn('[ProviderDiscovery] Unexpected YAML structure:', configPath);
        continue;
      }
      
      // 解析该文件中的 provider
      for (const entry of parsed) {
        if (!entry || entry.id !== 'llm-pi-ai' || !entry.config || !entry.config.providers) continue;
        for (const [providerId, providerConfig] of Object.entries(entry.config.providers)) {
          if (!providerConfig || typeof providerConfig !== 'object') continue;
          const id = providerId.toLowerCase();
          if (seen.has(id)) continue; // 已在更高优先级文件中出现，跳过
          seen.add(id);
          providers.push({
            id,
            displayName: providerConfig.displayName || providerId,
            baseUrl: providerConfig.baseURL || inferBaseUrl(providerId),
            sourceFile: configPath // 标记来源文件，供 UI 展示
          });
        }
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
 * 读取 DSH 本地凭据库里的 refs 映射。
 * DSH 把 `apiKeyEnv` 当作 credential-ref，Web 的「模型」页面填写的 Key
 * 会落到 ~/.dsh/.credentials.yaml 的 refs 下（可能是明文，也可能是密文；
 * 读不到值时上层会回退到「让用户手填」）。
 * @returns {Record<string, string>}
 */
function readCredentialRefs() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return {};
    const path = process.env.DSH_CREDENTIALS_PATH || join(home, '.dsh', '.credentials.yaml');
    if (!existsSync(path)) return {};
    const doc = load(readFileSync(path, 'utf-8'));
    const refs = doc && typeof doc === 'object' ? doc.refs : null;
    if (!refs || typeof refs !== 'object') return {};
    return refs;
  } catch {
    return {};
  }
}

/**
 * 在 DSH 配置里查找某个 Provider 的原始定义（按候选路径优先级）。
 * @param {string} providerId
 * @returns {{providerConfig: object, configPath: string}|null}
 */
function findProviderConfig(providerId) {
  const id = String(providerId || '').toLowerCase();
  for (const configPath of getCandidateConfigPaths()) {
    if (!existsSync(configPath)) continue;
    let parsed;
    try {
      parsed = load(readFileSync(configPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (!entry || entry.id !== 'llm-pi-ai') continue;
      const providerConfigs = entry.config && entry.config.providers;
      if (!providerConfigs) continue;
      const providerConfig = providerConfigs[id];
      if (providerConfig && typeof providerConfig === 'object') {
        return { providerConfig, configPath };
      }
    }
  }
  return null;
}

/**
 * 从环境变量或 DSH 凭据库解析 Provider 的 API Key（Host 侧使用，不要外传）。
 * @param {string} providerId
 * @returns {string} 读不到时返回空字符串
 */
export function resolveProviderApiKey(providerId) {
  const found = findProviderConfig(providerId);
  const apiKeyEnv = found && typeof found.providerConfig.apiKeyEnv === 'string'
    ? found.providerConfig.apiKeyEnv
    : null;
  if (!apiKeyEnv) return '';

  const fromEnv = process.env[apiKeyEnv];
  if (typeof fromEnv === 'string' && fromEnv) return fromEnv;

  const stored = readCredentialRefs()[apiKeyEnv];
  return typeof stored === 'string' ? stored : '';
}

/**
 * 读取单个 Provider 的完整定义（模型列表、baseURL、apiKeyEnv），供探测表单自动填充。
 *
 * 只返回「环境变量名」与「是否已能取到密钥」，绝不把密钥明文传给前端；
 * 真正调用探测接口时由 Host 侧读取。
 *
 * @param {string} providerId
 * @returns {{providerId: string, displayName: string, baseUrl: string, apiKeyEnv: string|null,
 *            apiKeyAvailable: boolean, models: Array<{id: string, name: string}>,
 *            sourceFile: string|null}}
 */
export function getProviderDetail(providerId) {
  const id = String(providerId || '').toLowerCase();
  const found = findProviderConfig(id);

  if (found) {
    const { providerConfig, configPath } = found;
    const models = Array.isArray(providerConfig.models)
      ? providerConfig.models
          .filter((model) => model && typeof model.id === 'string')
          .map((model) => ({
            id: model.id,
            name: model.name || model.id,
            contextWindow: model.contextWindow ?? null,
            maxTokens: model.maxTokens ?? null
          }))
      : [];

    const apiKeyEnv = typeof providerConfig.apiKeyEnv === 'string' && providerConfig.apiKeyEnv
      ? providerConfig.apiKeyEnv
      : null;

    return {
      providerId: id,
      displayName: providerConfig.displayName || id,
      baseUrl: providerConfig.baseURL || inferBaseUrl(id),
      apiKeyEnv,
      apiKeyAvailable: Boolean(resolveProviderApiKey(id)),
      models,
      sourceFile: configPath
    };
  }

  // 回退到内置预设
  const preset = getDefaultConfig(id) || {};
  return {
    providerId: id,
    displayName: preset.displayName || id,
    baseUrl: preset.baseUrl || inferBaseUrl(id),
    apiKeyEnv: null,
    apiKeyAvailable: Boolean(preset.apiKeyEnv && process.env[preset.apiKeyEnv]),
    models: [],
    sourceFile: null
  };
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
  getProviderDetail,
  resolveProviderApiKey,
  getDefaultConfig,
  getAllDefaultPresets
};