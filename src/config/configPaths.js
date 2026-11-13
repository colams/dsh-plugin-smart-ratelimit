/**
 * Config Paths - 配置路径管理
 * 支持通过环境变量自定义配置目录
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 获取配置目录（同步版本）
 * 优先级：环境变量 DSH_SMART_RATELIMIT_CONFIG_DIR > 插件目录/config > 用户目录/.dsh/smart-ratelimit
 */
function getConfigDirSync() {
  // 1. 环境变量指定
  if (process.env.DSH_SMART_RATELIMIT_CONFIG_DIR) {
    return process.env.DSH_SMART_RATELIMIT_CONFIG_DIR;
  }
  
  // 2. 插件目录下的 config（开发/默认） - 项目根目录的 config
  const pluginConfigDir = join(__dirname, '..', '..', 'config');
  
  // 3. 用户数据目录（生产环境）
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const userConfigDir = homeDir ? join(homeDir, '.dsh', 'smart-ratelimit') : null;
  
  // 检查插件目录是否存在配置文件
  if (existsSync(join(pluginConfigDir, 'default_presets.json'))) {
    return pluginConfigDir;
  }
  
  // 回退到用户目录或插件目录
  return userConfigDir || pluginConfigDir;
}

// 缓存配置目录
let _configDir = null;

export function getConfigDir() {
  if (_configDir) return _configDir;
  _configDir = getConfigDirSync();
  return _configDir;
}

export function getConfigDirSyncCached() {
  if (_configDir) return _configDir;
  _configDir = getConfigDirSync();
  return _configDir;
}

/**
 * 配置文件路径获取器
 */
export const ConfigPaths = {
  get dir() {
    return getConfigDirSyncCached();
  },
  
  get settings() {
    return join(this.dir, 'rate_limit_settings.json');
  },
  
  get history() {
    return join(this.dir, 'rate_limit_429_history.json');
  },
  
  get presets() {
    return join(this.dir, 'default_presets.json');
  },
  
  get probed() {
    return join(this.dir, 'probed_model_limits.json');
  },
  
  get calibrations() {
    return join(this.dir, 'model_token_calibrations.json');
  },
  
  /**
   * 确保配置目录存在
   */
  ensureDir() {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }
};

export default {
  getConfigDir,
  getConfigDirSync: getConfigDirSyncCached,
  ConfigPaths
};