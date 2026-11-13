#!/usr/bin/env node
/**
 * clean-config.mjs - 清理配置目录中的测试/预置数据
 * 用于在接入真实环境前重置配置目录
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');

const FILES_TO_CLEAN = [
  'probed_model_limits.json',
  'rate_limit_429_history.json',
  'rate_limit_settings.json',
  'route-status.json'
];

const FILES_TO_KEEP = [
  'default_presets.json'
];

function cleanConfig() {
  console.log('🧹 清理配置目录测试数据...\n');
  
  let cleaned = 0;
  let kept = 0;
  let errors = 0;
  
  for (const file of FILES_TO_CLEAN) {
    const filePath = join(CONFIG_DIR, file);
    if (existsSync(filePath)) {
      try {
        rmSync(filePath);
        console.log(`  ✅ 已删除: ${file}`);
        cleaned++;
      } catch (e) {
        console.log(`  ❌ 删除失败: ${file} - ${e.message}`);
        errors++;
      }
    } else {
      console.log(`  ⏭️  不存在: ${file}`);
    }
  }
  
  for (const file of FILES_TO_KEEP) {
    const filePath = join(CONFIG_DIR, file);
    if (existsSync(filePath)) {
      console.log(`  🔒 保留: ${file} (默认预设)`);
      kept++;
    }
  }
  
  console.log(`\n📊 完成: 删除 ${cleaned} 个, 保留 ${kept} 个, 错误 ${errors} 个`);
  console.log('\n💡 提示: 重启 DSH 后插件会自动重新生成所需配置文件');
  
  if (errors > 0) {
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  cleanConfig();
}

export { cleanConfig };