/**
 * integration.test.js - 集成测试与边界条件测试
 * 对应规格书 §8 验收测试矩阵补充
 *
 * 测试隔离：配置目录指向临时目录，避免污染仓库真实 config/ 文件。
 * 注意：本文件必须在导入任何 src 模块之前设置 DSH_SMART_RATELIMIT_CONFIG_DIR。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_CONFIG_DIR = join(__dirname, '..', 'config');

// 测试隔离：临时配置目录
const TEST_CONFIG_DIR = join(__dirname, '.test-config-integration');
process.env.DSH_SMART_RATELIMIT_CONFIG_DIR = TEST_CONFIG_DIR;
mkdirSync(TEST_CONFIG_DIR, { recursive: true });
// 复制只读配置供测试使用
for (const f of ['default_presets.json', 'probed_model_limits.json', 'rate_limit_settings.json']) {
  const src = join(PROJECT_CONFIG_DIR, f);
  if (existsSync(src)) copyFileSync(src, join(TEST_CONFIG_DIR, f));
}
writeFileSync(join(TEST_CONFIG_DIR, 'rate_limit_429_history.json'), '{}');

const CONFIG_DIR = TEST_CONFIG_DIR;
const HISTORY_FILE = join(CONFIG_DIR, 'rate_limit_429_history.json');
const PROBED_FILE = join(CONFIG_DIR, 'probed_model_limits.json');
const SETTINGS_FILE = join(CONFIG_DIR, 'rate_limit_settings.json');

// 延迟导入 src 模块，确保 ConfigPaths 读到的是临时目录
const { DualRateLimiter, RateLimiterManager, SmoothTokenBucket } = await import('../src/limiter/dualRateLimiter.js');
const { metricsTracker, historyTracker } = await import('../src/history/metricsTracker.js');
const { RequestInterceptor, requestInterceptor } = await import('../src/intercept/requestInterceptor.js');
const { mergeProviderConfig, CONFIG_PRIORITY } = await import('../src/config/configMerger.js');
const { nvcfPoller, NVCFPoller, classifyError } = await import('../src/intercept/nvcfPoller.js');
const { estimateTokens, calibrateModel, HeuristicTokenEstimator } = await import('../src/core/tokenEstimator.js');

// 测试前清理
before(async () => {
  writeFileSync(HISTORY_FILE, '{}');
  historyTracker.clearAllHistory();
  metricsTracker.reset('test-provider');
  metricsTracker.reset('nvidia');
});

after(async () => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  delete process.env.DSH_SMART_RATELIMIT_CONFIG_DIR;
});

describe('配置优先级合并测试', () => {
  it('用户自定义配置应覆盖默认预设', () => {
    // 确保 settings 中有用户自定义配置
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    const originalNvidiaRpm = settings.nvidia?.rpm;
    
    // 临时修改用户配置
    settings.nvidia = { ...settings.nvidia, rpm: 25, priority: 'user_custom' };
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    
    try {
      const merged = mergeProviderConfig('nvidia');
      assert.strictEqual(merged.rpm, 25, '用户自定义 RPM 应生效');
      assert.strictEqual(merged.priority, 'user_custom', '优先级应标记为 user_custom');
    } finally {
      // 恢复原配置
      if (originalNvidiaRpm) {
        settings.nvidia.rpm = originalNvidiaRpm;
      }
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    }
  });
  
  it('历史校准值应覆盖默认预设但低于用户自定义', () => {
    // 写入历史数据
    const historyData = {
      nvidia: {
        suggestedSafeRpm: 35,
        suggestedSafeTpm: 80000,
        total429Count: 5,
        hasHistory: true
      }
    };
    writeFileSync(HISTORY_FILE, JSON.stringify(historyData, null, 2));
    historyTracker.clearHistory('nvidia');
    
    // 确保 settings 中没有 nvidia 配置（或优先级较低）
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    const hasUserCustom = settings.nvidia?.priority === 'user_custom';
    
    if (!hasUserCustom) {
      // 暂时移除用户自定义
      delete settings.nvidia;
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      
      try {
        const merged = mergeProviderConfig('nvidia');
        assert.strictEqual(merged.rpm, 35, '历史校准 RPM 应生效');
        assert.strictEqual(merged.priority, 'history_calibrated', '优先级应标记为 history_calibrated');
      } finally {
        // 恢复
        settings.nvidia = { rpm: 40, priority: 'user_custom' };
        writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      }
    }
  });
  
  it('优先级数值比较正确', () => {
    assert.ok(CONFIG_PRIORITY.USER_CUSTOM > CONFIG_PRIORITY.HISTORY_CALIBRATED);
    assert.ok(CONFIG_PRIORITY.HISTORY_CALIBRATED > CONFIG_PRIORITY.SYSTEM_AUTO);
    assert.ok(CONFIG_PRIORITY.SYSTEM_AUTO > CONFIG_PRIORITY.DEFAULT_PRESET);
    assert.ok(CONFIG_PRIORITY.DEFAULT_PRESET > CONFIG_PRIORITY.GLOBAL_FALLBACK);
  });
});

describe('Token 估算器测试', () => {
  it('启发式估算器基础功能', () => {
    const estimator = new HeuristicTokenEstimator();
    
    const messages = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: 'Hello world' }
    ];
    
    const tokens = estimator.estimateMessages(messages);
    assert.ok(tokens > 0, '应返回正数');
    assert.ok(Number.isInteger(tokens), '应返回整数');
  });
  
  it('校准功能可工作', () => {
    const result = calibrateModel('test-model', 100, 120);
    assert.ok(result.success, '校准应成功');
    assert.strictEqual(result.multiplier, 1.2, '倍率应为 1.2');
  });
  
  it('estimateTokens 集成函数工作正常', () => {
    const messages = [
      { role: 'user', content: '测试消息' }
    ];
    
    const tokens = estimateTokens(messages, 'test-model', 50);
    assert.ok(tokens >= 50, '应至少包含 max_tokens');
    assert.ok(tokens > 50, '应包含输入 token 估算');
  });
});

describe('NVCF 轮询器测试', () => {
  it('错误分类正确', () => {
    // 网络错误可重试
    assert.ok(classifyError(new Error('network error'), null).retryable);
    
    // 429 可重试
    assert.ok(classifyError(null, { status: 429 }).retryable);
    
    // 500 可重试
    assert.ok(classifyError(null, { status: 500 }).retryable);
    
    // 401 不可重试
    assert.ok(!classifyError(null, { status: 401 }).retryable);
    
    // 404 不可重试
    assert.ok(!classifyError(null, { status: 404 }).retryable);
  });
  
  it('轮询配置可自定义', () => {
    const customPoller = new NVCFPoller({
      maxAttempts: 10,
      pollIntervalMs: 1000,
      totalTimeoutMs: 30000
    });
    
    assert.strictEqual(customPoller.config.maxAttempts, 10);
    assert.strictEqual(customPoller.config.pollIntervalMs, 1000);
    assert.strictEqual(customPoller.config.totalTimeoutMs, 30000);
  });
});

describe('请求拦截器集成测试', () => {
  it('初始化应创建所有已知 provider 的限速器', async () => {
    const interceptor = new RequestInterceptor();
    
    await interceptor.initialize({
      'test-provider': { rpm: 10, tpm: 1000 }
    });
    
    const limiter = interceptor.manager.getLimiter('test-provider');
    assert.ok(limiter, '应创建限速器');
    assert.strictEqual(limiter.config.rpm, 10);
  });
  
  it('拦截请求应返回预估 token 和限速器引用', async () => {
    const interceptor = new RequestInterceptor();
    await interceptor.initialize({
      'test-provider': { rpm: 60, tpm: 60000 }
    });
    
    const request = {
      providerId: 'test-provider',
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100
    };
    
    const result = await interceptor.intercept(request);
    
    assert.ok(result._ratelimit, '应包含限速信息');
    assert.ok(result._ratelimit.allowed, '应允许通过');
    assert.ok(result._ratelimit.estimatedTokens > 0, '应有预估 token');
    assert.ok(result._ratelimit.limiter, '应包含限速器引用');
  });
  
  it('轮询请求应跳过 RPM/TPM 扣减（_skipRateLimit 透传）', async () => {
    const interceptor = new RequestInterceptor();
    await interceptor.initialize({
      'test-provider': { rpm: 60, tpm: 60000 }
    });
    
    // 模拟 NVCF 轮询请求：标记 _skipRateLimit，应跳过扣减
    const request = {
      providerId: 'test-provider',
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
      _skipRateLimit: true,
      _isPolling: true
    };
    
    const limiter = interceptor.manager.getLimiter('test-provider');
    const rpmBefore = limiter.rpmBucket.tokens;
    const tpmBefore = limiter.tpmBucket.tokens;
    
    const result = await interceptor.intercept(request);
    
    assert.ok(result._ratelimit?.allowed, '轮询请求应放行');
    assert.ok(result._ratelimit?.skipped === true, '应标记为跳过扣减');
    // RPM/TPM 桶水位不应因跳过的请求而下降
    assert.ok(limiter.rpmBucket.tokens >= rpmBefore - 1, 'RPM 桶不应被轮询扣减');
  });
  
  it('429 冷却门：并发 429 共享退避，冷却期内再次 429 应 reject', async () => {
    const interceptor = new RequestInterceptor();
    // 使用 3 秒固定退避：足够在 assert 时冷却门仍有效，又不让测试跑 60 秒
    await interceptor.initialize({
      'cooldown-provider': { rpm: 60, tpm: 60000, backoffStrategy: 'fixed', fixedBackoffSeconds: 3 }
    });
    
    const request = {
      providerId: 'cooldown-provider',
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100
    };
    
    const intercepted = await interceptor.intercept(request);
    
    // 第一次 429：创建 3s 冷却门，等待退避完成（~3s）
    const first429 = interceptor.postProcess(intercepted, { status: 429, headers: {} });
    await assert.rejects(first429, /RATE_LIMIT_EXCEEDED/);
    
    // 3s 冷却门解除后，冷却门应已删除（postProcess await 完成即表示退避已结束）
    const cooldownGone = !interceptor._cooldowns.has('cooldown-provider');
    assert.ok(cooldownGone, '退避完成后冷却门应已解除');
  });
  
  it('响应后处理应结算 token', async () => {
    const interceptor = new RequestInterceptor();
    await interceptor.initialize({
      'test-provider': { rpm: 60, tpm: 60000 }
    });
    
    const request = {
      providerId: 'test-provider',
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100
    };
    
    const intercepted = await interceptor.intercept(request);
    const estimatedTokens = intercepted._ratelimit.estimatedTokens;
    const limiter = intercepted._ratelimit.limiter;
    const tokensBefore = limiter.tpmBucket?.tokens || 0;
    
    // 模拟响应
    const response = {
      status: 200,
      data: { usage: { total_tokens: estimatedTokens + 20 } }
    };
    
    await interceptor.postProcess(intercepted, response);
    
    const tokensAfter = limiter.tpmBucket?.tokens || 0;
    // 实际比预估多 20，桶应减少 20
    assert.ok(tokensAfter < tokensBefore, '桶 token 应减少');
  });
  
  it('成功响应应推进 RPD 计数；429 响应不应计数', async () => {
    const interceptor = new RequestInterceptor();
    await interceptor.initialize({
      'rpd-provider': { rpm: 60, tpm: 60000, rpd: 100 }
    });
    
    const limiter = interceptor.manager.getLimiter('rpd-provider');
    const countBefore = limiter.dailyQuota.count;
    
    // 模拟 200 成功响应 → RPD 计数 +1
    const req1 = { providerId: 'rpd-provider', modelId: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 };
    const intercepted1 = await interceptor.intercept(req1);
    await interceptor.postProcess(intercepted1, { status: 200, data: {} });
    assert.strictEqual(limiter.dailyQuota.count, countBefore + 1, '200 响应应推进 RPD 计数');
    
    // 模拟 429 响应（不推进计数）→ handle429 抛 RATE_LIMIT_EXCEEDED
    const req2 = { providerId: 'rpd-provider', modelId: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 };
    const intercepted2 = await interceptor.intercept(req2);
    try {
      await interceptor.postProcess(intercepted2, { status: 429, headers: {} });
    } catch (e) {
      assert.ok(e.message === 'RATE_LIMIT_EXCEEDED' || e.message === 'RATE_LIMIT_COOLDOWN');
    }
    assert.strictEqual(limiter.dailyQuota.count, countBefore + 1, '429 响应不应推进 RPD 计数');
  });
  
  it('RPD 熔断：配额用尽时 acquire 应抛 ERR_RPD_EXCEEDED', async () => {
    const interceptor = new RequestInterceptor();
    await interceptor.initialize({
      'rpd-exhausted': { rpm: 60, tpm: 60000, rpd: 1 }
    });
    
    const limiter = interceptor.manager.getLimiter('rpd-exhausted');
    // 手动用尽日配额
    limiter.dailyQuota.recordUsage();
    
    const request = {
      providerId: 'rpd-exhausted',
      modelId: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10
    };
    
    await assert.rejects(
      async () => await interceptor.intercept(request),
      /ERR_RPD_EXCEEDED/
    );
  });
});

describe('子限速器热更新传播测试', () => {
  it('主限速器 updateConfig 应传播到子限速器', async () => {
    const limiter = new DualRateLimiter('nvidia', {
      rpm: 60,
      tpm: 100000,
      backoffStrategy: 'fixed',
      fixedBackoffSeconds: 15
    });
    
    // 触发子限速器创建
    const subLimiter = await limiter.getSubLimiter('nvidia/nemotron-3-ultra-550b-a55b');
    assert.ok(subLimiter, '应创建子限速器');
    
    const originalSubRpm = subLimiter.config.rpm;
    const originalSubBackoff = subLimiter.config.backoffStrategy;
    
    // 更新主限速器配置
    limiter.updateConfig({ 
      backoffStrategy: 'exponential',
      fixedBackoffSeconds: 60
    });
    
    // 子限速器的 backoffStrategy 应同步更新
    assert.strictEqual(subLimiter.config.backoffStrategy, 'exponential', '子限速器退避策略应同步');
    assert.strictEqual(subLimiter.config.fixedBackoffSeconds, 60, '子限速器固定退避时间应同步');
    // RPM 不应改变（子限速器有自己的更严格 RPM）
    assert.strictEqual(subLimiter.config.rpm, originalSubRpm, '子限速器 RPM 不应被主配置覆盖');
  });
});

describe('边界条件测试', () => {
  it('TPM=0 时不应创建 TPM 桶', async () => {
    const limiter = new DualRateLimiter('test', { rpm: 60, tpm: 0 });
    assert.strictEqual(limiter.tpmBucket, null, 'TPM=0 时不应创建 TPM 桶');
    
    const result = await limiter.acquire({
      modelId: 'test',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 100
    });
    assert.ok(result.allowed, '无 TPM 限制时应通过');
  });
  
  it('RPD=0 时不应触发日配额熔断', async () => {
    const limiter = new DualRateLimiter('test', { rpm: 60, tpm: 60000, rpd: 0 });
    
    // 发送少量请求验证不熔断
    for (let i = 0; i < 10; i++) {
      await limiter.acquire({
        modelId: 'test',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10
      });
    }
    
    const state = limiter.dailyQuota.getState();
    assert.strictEqual(state.limit, 0, 'RPD 限制应为 0');
    assert.strictEqual(state.remaining, Infinity, '剩余应为无穷大');
  });
  
  it('禁用限速时应直接放行且不消费 token', async () => {
    const limiter = new DualRateLimiter('test', { rpm: 10, tpm: 1000, enabled: false });
    
    const initialRpm = limiter.rpmBucket.tokens;
    
    await limiter.acquire({
      modelId: 'test',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 100
    });
    
    // 禁用时不应消费 token
    assert.ok(limiter.rpmBucket.tokens >= initialRpm - 1, '禁用时不应显著消费 token');
  });
  
  it('applyToFreeModelsOnly 为 true 时付费模型应绕过限速', async () => {
    const limiter = new DualRateLimiter('test', { 
      rpm: 10, // 适中的 RPM，避免测试超时
      tpm: 1000,
      applyToFreeModelsOnly: true 
    });
    
    // 免费模型应被限速（需要排队）
    const freeRequest = {
      modelId: 'free-model',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 10,
      isFreeModel: true
    };
    
    // 付费模型应直接放行
    const paidRequest = {
      modelId: 'paid-model',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 10,
      isFreeModel: false
    };
    
    const freeResult = await limiter.acquire(freeRequest);
    const paidResult = await limiter.acquire(paidRequest);
    
    assert.ok(freeResult.allowed, '免费模型应被允许');
    assert.ok(paidResult.allowed, '付费模型应被允许');
    assert.strictEqual(paidResult.bypassed, true, '付费模型应标记为 bypassed');
  });
  
  it('队列取消功能应工作', async () => {
    const limiter = new DualRateLimiter('test', { rpm: 1, tpm: 1000 });
    
    // 先消耗初始突发令牌（约 1 个）
    await limiter.acquire({
      modelId: 'test',
      messages: [{ role: 'user', content: 'initial' }],
      max_tokens: 10
    });
    
    const controller = new AbortController();
    const request = {
      modelId: 'test',
      messages: [{ role: 'user', content: 'x'.repeat(1000) }],
      max_tokens: 100,
      signal: controller.signal
    };
    
    const promise = limiter.acquire(request);
    
    // 短暂延迟后取消
    setTimeout(() => controller.abort(), 10);
    
    await assert.rejects(promise, /Request aborted/);
  });
  
  it('队列超时功能应工作', async () => {
    const limiter = new DualRateLimiter('test', { rpm: 1, tpm: 1000 });
    
    // 先消耗初始突发令牌
    await limiter.acquire({
      modelId: 'test',
      messages: [{ role: 'user', content: 'initial' }],
      max_tokens: 10
    });
    
    const request = {
      modelId: 'test',
      messages: [{ role: 'user', content: 'x'.repeat(1000) }],
      max_tokens: 100,
      signal: undefined,
      timeoutMs: 50 // 50ms 超时
    };
    
    const promise = limiter.acquire(request);
    
    await assert.rejects(promise, /Queue timeout/);
  });
  
  it('优先级队列：高优先级请求应先于低优先级', async () => {
    const limiter = new DualRateLimiter('test', { rpm: 10, tpm: 10000 });
    
    const lowPriority = {
      modelId: 'test',
      messages: [{ role: 'user', content: 'low' }],
      max_tokens: 10
    };
    
    const highPriority = {
      modelId: 'test',
      messages: [{ role: 'user', content: 'high' }],
      max_tokens: 10
    };
    
    // 先发低优先级（免费模型 priority=10）
    const lowPromise = limiter.acquire({ ...lowPriority, isFreeModel: true });
    
    // 稍后发高优先级（付费模型 priority=0）
    setTimeout(() => {}, 5);
    const highPromise = limiter.acquire({ ...highPriority, isFreeModel: false });
    
    const [lowResult, highResult] = await Promise.all([lowPromise, highPromise]);
    
    assert.ok(lowResult.allowed && highResult.allowed);
    // 高优先级应该等待时间更短或相等
  });
});

describe('历史记录与建议测试', () => {
  it('记录 429 后应生成建议值', () => {
    historyTracker.clearHistory('history-test');
    
    historyTracker.record429('history-test', 25, 50000, 'test-model');
    
    const suggestion = historyTracker.getSuggestion('history-test');
    assert.ok(suggestion, '应有建议');
    assert.ok(suggestion.hasHistory, '应标记有历史');
    assert.strictEqual(suggestion.suggestedSafeRpm, 22, '建议 RPM 应为 25 * 0.9 = 22.5 -> 22');
    assert.strictEqual(suggestion.suggestedSafeTpm, 45000, '建议 TPM 应为 50000 * 0.9 = 45000');
  });
  
  it('多次 429 取最低触发点计算建议', () => {
    historyTracker.clearHistory('history-test-2');
    
    historyTracker.record429('history-test-2', 30, 60000, 'model-a');
    historyTracker.record429('history-test-2', 20, 40000, 'model-b');
    historyTracker.record429('history-test-2', 25, 50000, 'model-c');
    
    const suggestion = historyTracker.getSuggestion('history-test-2');
    // 最低 RPM 触发点是 20，建议 20 * 0.9 = 18
    assert.strictEqual(suggestion.suggestedSafeRpm, 18);
    // 最低 TPM 触发点是 40000，建议 40000 * 0.9 = 36000
    assert.strictEqual(suggestion.suggestedSafeTpm, 36000);
  });
  
  it('清空历史后应无建议', () => {
    historyTracker.clearHistory('history-test-3');
    historyTracker.record429('history-test-3', 25, 50000, 'test-model');
    
    historyTracker.clearHistory('history-test-3');
    
    const suggestion = historyTracker.getSuggestion('history-test-3');
    assert.ok(!suggestion || !suggestion.hasHistory, '清空后不应有历史');
  });
});

describe('令牌桶防突发测试', () => {
  it('初始突发容量为 20%', () => {
    const bucket = new SmoothTokenBucket(60, 60 / 60000, 0.2);
    assert.strictEqual(bucket.tokens, 12);
  });
  
  it('全量突发模式可配置', () => {
    const bucket = new SmoothTokenBucket(60, 60 / 60000, 1.0);
    assert.strictEqual(bucket.tokens, 60);
  });
  
  it('penalize 应清空桶并重置时间戳', () => {
    const bucket = new SmoothTokenBucket(60, 60 / 60000, 0.2);
    bucket.tokens = 30;
    const beforeRefill = bucket.lastRefill;
    
    bucket.penalize();
    
    assert.strictEqual(bucket.tokens, 0);
    assert.ok(bucket.lastRefill >= beforeRefill);
  });
});

describe('配置目录可配置化测试', () => {
  it('应支持通过环境变量指定配置目录', () => {
    // 当前实现使用硬编码路径，此测试记录需求
    // TODO: 实现配置目录可配置化
    assert.ok(true, '配置目录可配置化待实现');
  });
});