#!/usr/bin/env node
/**
 * probeModels.mjs - CLI 自动化探测脚本
 * 支持 NVIDIA/Agnes 等所有兼容端点的模型真实极限探测
 * 对应规格书 §2.1, §5.2
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');
const SETTINGS_FILE = join(CONFIG_DIR, 'rate_limit_settings.json');
const PROBED_FILE = join(CONFIG_DIR, 'probed_model_limits.json');
const PRESETS_FILE = join(CONFIG_DIR, 'default_presets.json');

/**
 * 解析命令行参数
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    provider: null,
    model: null,
    apiKey: null,
    baseUrl: null,
    maxRpm: 100,
    step: 5,
    timeout: 30000,
    dryRun: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--provider':
      case '-p':
        options.provider = args[++i];
        break;
      case '--model':
      case '-m':
        options.model = args[++i];
        break;
      case '--api-key':
      case '-k':
        options.apiKey = args[++i];
        break;
      case '--base-url':
      case '-u':
        options.baseUrl = args[++i];
        break;
      case '--max-rpm':
        options.maxRpm = parseInt(args[++i], 10);
        break;
      case '--step':
        options.step = parseInt(args[++i], 10);
        break;
      case '--timeout':
        options.timeout = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
probeModels - DSH 智能限速插件模型阈值探测工具

用法:
  node scripts/probeModels.mjs [选项]

选项:
  -p, --provider <id>       提供商 ID (nvidia, agnes, 或自定义)
  -m, --model <id>          要探测的模型 ID
  -k, --api-key <key>       API Key（必需）
  -u, --base-url <url>      API 基础 URL（可选，有默认值）
  --max-rpm <n>             最大探测 RPM 上限 (默认: 100)
  --step <n>                探测步长 RPM (默认: 5)
  --timeout <ms>            单次请求超时毫秒 (默认: 30000)
  --dry-run                 仅模拟运行，不发送实际请求
  -h, --help                显示帮助信息

示例:
  # 探测 NVIDIA nemotron-3-ultra
  node scripts/probeModels.mjs -p nvidia -m nvidia/nemotron-3-ultra-550b-a55b -k \$NVIDIA_API_KEY

  # 探测 Agnes vision-3k
  node scripts/probeModels.mjs -p agnes -m agnes-vision-3k -k \$AGNES_API_KEY

  # 自定义端点
  node scripts/probeModels.mjs -p custom -m my-model -k \$API_KEY -u https://api.example.com/v1
`);
}

/**
 * 获取提供商默认配置
 */
function getProviderDefaults(providerId) {
  try {
    const presets = JSON.parse(readFileSync(PRESETS_FILE, 'utf-8'));
    return presets[providerId] || presets.default;
  } catch {
    return {
      baseUrl: '',
      rpm: 60,
      tpm: 0,
      backoffStrategy: 'exponential'
    };
  }
}

/**
 * 发送测试请求
 */
async function sendTestRequest(baseUrl, apiKey, model, maxTokens = 16, timeout = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: maxTokens,
        temperature: 0
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await response.json().catch(() => ({}));
    
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      data,
      error: null
    };
  } catch (error) {
    clearTimeout(timeoutId);
    return {
      status: 0,
      headers: {},
      data: null,
      error: error.message
    };
  }
}

/**
 * 二分法探测最大 RPM
 */
async function probeMaxRpm(baseUrl, apiKey, model, options) {
  console.log(`\n[探测] 开始探测 ${options.provider}/${model} 的最大 RPM...`);
  console.log(`[配置] 最大测试 RPM: ${options.maxRpm}, 步长: ${options.step} RPM`);
  
  let low = options.step;
  let high = options.maxRpm;
  let lastSuccessRpm = 0;
  let last429Rpm = null;
  let consecutive429 = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const testRpm = Math.max(options.step, Math.floor(mid / options.step) * options.step);
    
    console.log(`\n[测试] 尝试 RPM: ${testRpm}`);
    
    // 计算发送间隔
    const intervalMs = 60000 / testRpm;
    const requestCount = Math.min(10, testRpm); // 每次测试发送最多 10 个请求
    
    let successCount = 0;
    let error429Count = 0;
    let otherErrorCount = 0;

    // 并发发送请求测试
    const promises = [];
    for (let i = 0; i < requestCount; i++) {
      const delay = i * intervalMs;
      promises.push(
        new Promise(resolve => setTimeout(() => resolve(sendTestRequest(baseUrl, apiKey, model, 16, options.timeout)), delay))
      );
    }

    const results = await Promise.all(promises);
    
    for (const result of results) {
      if (result.status === 200) {
        successCount++;
      } else if (result.status === 429) {
        error429Count++;
        // 记录 429 触发时的 RPM
        if (last429Rpm === null || testRpm < last429Rpm) {
          last429Rpm = testRpm;
        }
      } else if (result.status > 0) {
        otherErrorCount++;
      }
    }

    console.log(`[结果] 成功: ${successCount}, 429: ${error429Count}, 其他错误: ${otherErrorCount}`);

    if (error429Count > 0) {
      // 触发了 429，降低上限
      high = testRpm - options.step;
      consecutive429++;
      if (consecutive429 >= 2) {
        console.log(`[判定] 连续 ${consecutive429} 次触发 429，确认上限`);
        break;
      }
    } else if (successCount >= requestCount * 0.8) {
      // 成功率 >= 80%，尝试更高
      lastSuccessRpm = testRpm;
      low = testRpm + options.step;
      consecutive429 = 0;
    } else {
      // 成功率不足，可能有其他问题
      console.log(`[警告] 成功率过低 (${successCount}/${requestCount})，可能存在网络或配额问题`);
      high = testRpm - options.step;
    }
  }

  const safeRpm = last429Rpm ? Math.max(1, Math.floor(last429Rpm * 0.9)) : lastSuccessRpm;
  
  console.log(`\n[探测完成]`);
  console.log(`  最后成功 RPM: ${lastSuccessRpm}`);
  console.log(`  首次触发 429 RPM: ${last429Rpm || '未触发'}`);
  console.log(`  建议安全 RPM: ${safeRpm}`);

  return {
    rpm: safeRpm,
    triggeredAtRpm: last429Rpm,
    lastSuccessRpm,
    confidence: last429Rpm ? 0.8 : 0.5
  };
}

/**
 * 探测 TPM 限制
 */
async function probeTpm(baseUrl, apiKey, model, safeRpm, options) {
  console.log(`\n[探测] 开始探测 TPM 限制...`);
  
  // 使用安全 RPM 发送大 token 请求
  const testTokens = [1000, 4000, 8000, 16000, 32000, 64000, 100000];
  let maxSafeTpm = 0;
  let triggeredAtTpm = null;

  for (const tokens of testTokens) {
    console.log(`[测试] 尝试 max_tokens: ${tokens}`);
    
    const result = await sendTestRequest(baseUrl, apiKey, model, tokens, options.timeout);
    
    if (result.status === 200) {
      const actualTokens = result.data?.usage?.total_tokens || tokens;
      maxSafeTpm = Math.max(maxSafeTpm, actualTokens * safeRpm);
      console.log(`[结果] 成功，实际消耗: ${actualTokens} tokens`);
    } else if (result.status === 429) {
      triggeredAtTpm = tokens * safeRpm;
      console.log(`[结果] 触发 429，TPM 约: ${triggeredAtTpm}`);
      break;
    } else {
      console.log(`[结果] 错误: ${result.status} - ${result.error || 'Unknown'}`);
    }
    
    // 避免触发限速，等待一下
    await new Promise(r => setTimeout(r, 2000));
  }

  const safeTpm = triggeredAtTpm ? Math.max(1, Math.floor(triggeredAtTpm * 0.9)) : maxSafeTpm;
  
  console.log(`\n[TPM 探测完成]`);
  console.log(`  最大安全 TPM: ${safeTpm}`);
  console.log(`  触发 429 TPM: ${triggeredAtTpm || '未触发'}`);

  return {
    tpm: safeTpm,
    triggeredAtTpm,
    confidence: triggeredAtTpm ? 0.8 : 0.5
  };
}

/**
 * 保存探测结果
 */
function saveProbedResults(providerId, modelId, results) {
  let probedData = {};
  if (existsSync(PROBED_FILE)) {
    probedData = JSON.parse(readFileSync(PROBED_FILE, 'utf-8'));
  }

  if (!probedData[providerId]) {
    probedData[providerId] = {};
  }

  probedData[providerId][modelId] = {
    rpm: results.rpm,
    tpm: results.tpm || 0,
    probedAt: new Date().toISOString(),
    probedRpm: results.triggeredAtRpm || null,
    probedTpm: results.triggeredAtTpm || null,
    confidence: Math.min(results.confidence || 0.5, results.tpmConfidence || 0.5)
  };

  writeFileSync(PROBED_FILE, JSON.stringify(probedData, null, 2));
  console.log(`\n[保存] 探测结果已保存至 ${PROBED_FILE}`);
}

/**
 * 主函数
 */
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (!options.provider || !options.model || !options.apiKey) {
    console.error('错误: 必须指定 --provider, --model, --api-key');
    showHelp();
    process.exit(1);
  }

  // 确保配置目录存在
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const providerDefaults = getProviderDefaults(options.provider);
  const baseUrl = options.baseUrl || providerDefaults.baseUrl;

  if (!baseUrl) {
    console.error('错误: 无法确定 API 基础 URL，请使用 --base-url 指定');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('DSH 智能限速插件 - 模型阈值探测工具');
  console.log('='.repeat(60));
  console.log(`提供商: ${options.provider}`);
  console.log(`模型: ${options.model}`);
  console.log(`API 端点: ${baseUrl}`);
  console.log(`干运行模式: ${options.dryRun ? '是' : '否'}`);

  if (options.dryRun) {
    console.log('\n[干运行] 模拟完成，未发送实际请求');
    process.exit(0);
  }

  try {
    // 探测 RPM
    const rpmResult = await probeMaxRpm(baseUrl, options.apiKey, options.model, options);
    
    // 探测 TPM
    const tpmResult = await probeTpm(baseUrl, options.apiKey, options.model, rpmResult.rpm, options);
    
    // 合并结果
    const results = {
      ...rpmResult,
      ...tpmResult,
      tpmConfidence: tpmResult.confidence
    };

    // 保存结果
    saveProbedResults(options.provider, options.model, results);

    console.log('\n' + '='.repeat(60));
    console.log('探测完成！建议配置:');
    console.log(`  RPM: ${results.rpm}`);
    console.log(`  TPM: ${results.tpm}`);
    console.log('='.repeat(60));

    // 同时更新 settings 文件（可选）
    const updateSettings = process.argv.includes('--update-settings');
    if (updateSettings) {
      let settings = {};
      if (existsSync(SETTINGS_FILE)) {
        settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
      }
      
      if (!settings[options.provider]) {
        settings[options.provider] = {};
      }
      
      settings[options.provider].rpm = results.rpm;
      if (results.tpm > 0) {
        settings[options.provider].tpm = results.tpm;
      }
      settings[options.provider].priority = 'probed';
      
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      console.log(`\n[更新] 已同步更新至 ${SETTINGS_FILE}`);
    }

  } catch (error) {
    console.error('\n[错误] 探测失败:', error.message);
    process.exit(1);
  }
}

// 运行主函数
main().catch(console.error);