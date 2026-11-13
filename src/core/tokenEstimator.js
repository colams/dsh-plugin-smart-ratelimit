/**
 * Token Estimator - Token 预估器
 * 对应规格书 §3.2
 * 
 * 提供可插拔的 Token 估算策略，支持不同模型的 tokenizer 差异
 * 默认使用启发式算法，可扩展为精确 tokenizer 适配
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');

/**
 * 预估策略类型
 */
export const ESTIMATION_STRATEGY = {
  HEURISTIC: 'heuristic',        // 启发式（默认）
  TIKTOKEN: 'tiktoken',          // tiktoken 精确编码（需额外依赖）
  MODEL_SPECIFIC: 'model_specific' // 模型特定校准值
};

/**
 * 默认启发式参数
 */
const DEFAULT_HEURISTICS = {
  // 字符级估算系数
  chineseCharMultiplier: 1.5,    // 中文字符 ~1.5 tokens
  englishWordMultiplier: 0.3,    // 英文单词 ~0.3 tokens
  punctuationMultiplier: 0.5,    // 标点符号 ~0.5 tokens
  digitMultiplier: 0.5,          // 数字 ~0.5 tokens
  whitespaceMultiplier: 0,       // 空白不计 token
  // 代码块额外开销
  codeBlockOverhead: 10,
  // 系统消息额外开销
  systemMessageOverhead: 5,
  // 消息格式开销（role 标记等）
  messageFormatOverhead: 3
};

/**
 * 模型特定校准表（基于实测数据）
 * 可从 probed_model_limits.json 或单独配置加载
 */
let MODEL_CALIBRATIONS = null;

/**
 * 加载模型校准数据
 */
function loadModelCalibrations() {
  if (MODEL_CALIBRATIONS !== null) return MODEL_CALIBRATIONS;
  
  try {
    const calibrationPath = join(CONFIG_DIR, 'model_token_calibrations.json');
    if (existsSync(calibrationPath)) {
      MODEL_CALIBRATIONS = JSON.parse(readFileSync(calibrationPath, 'utf-8'));
    } else {
      MODEL_CALIBRATIONS = {};
    }
  } catch {
    MODEL_CALIBRATIONS = {};
  }
  return MODEL_CALIBRATIONS;
}

/**
 * 启发式 Token 估算器（默认实现）
 * 基于字符/单词统计的快速估算
 */
export class HeuristicTokenEstimator {
  constructor(options = {}) {
    this.options = { ...DEFAULT_HEURISTICS, ...options };
  }
  
  /**
   * 估算单条消息的 token 数
   */
  estimateMessage(message) {
    const content = message.content || '';
    const role = message.role || 'user';
    
    if (!content) return this.options.messageFormatOverhead;
    
    let tokens = this.options.messageFormatOverhead; // 基础格式开销
    
    // 统计各类字符
    const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = (content.match(/[a-zA-Z]+/g) || []).length;
    const punctuations = (content.match(/[，。！？、；：""''（）【】《》<>《》\u3000-\u303F]/g) || []).length;
    const digits = (content.match(/\d/g) || []).length;
    const asciiPunct = (content.match(/[.,!?;:'"()\[\]{}<>@#$%^&*+=|\\/~`-]/g) || []).length;
    const codeBlocks = (content.match(/```[\s\S]*?```/g) || []).length;
    
    tokens += chineseChars * this.options.chineseCharMultiplier;
    tokens += englishWords * this.options.englishWordMultiplier;
    tokens += (punctuations + asciiPunct) * this.options.punctuationMultiplier;
    tokens += digits * this.options.digitMultiplier;
    tokens += codeBlocks * this.options.codeBlockOverhead;
    
    // 系统消息额外开销
    if (role === 'system') {
      tokens += this.options.systemMessageOverhead;
    }
    
    return Math.ceil(tokens);
  }
  
  /**
   * 估算消息数组的总 token 数
   */
  estimateMessages(messages) {
    if (!Array.isArray(messages)) return 0;
    
    let total = 0;
    for (const msg of messages) {
      total += this.estimateMessage(msg);
    }
    return total;
  }
}

/**
 * 模型特定校准估算器
 * 使用实测校准系数调整启发式估算
 */
export class CalibratedTokenEstimator {
  constructor(baseEstimator = new HeuristicTokenEstimator()) {
    this.baseEstimator = baseEstimator;
    this.calibrations = loadModelCalibrations();
  }
  
  /**
   * 获取模型的校准系数
   */
  getCalibration(modelId) {
    // 尝试精确匹配
    if (this.calibrations[modelId]) {
      return this.calibrations[modelId];
    }
    
    // 尝试前缀匹配（如 nvidia/nemotron-3-ultra-550b-a55b -> nvidia/）
    for (const [prefix, cal] of Object.entries(this.calibrations)) {
      if (modelId.startsWith(prefix) && cal.isPrefix) {
        return cal;
      }
    }
    
    // 尝试提供商级匹配
    const provider = modelId.split('/')[0];
    if (this.calibrations[provider]) {
      return this.calibrations[provider];
    }
    
    return null;
  }
  
  /**
   * 估算消息 token（应用校准）
   */
  estimateMessages(messages, modelId) {
    const baseTokens = this.baseEstimator.estimateMessages(messages);
    const calibration = this.getCalibration(modelId);
    
    if (!calibration) return baseTokens;
    
    // 应用校准系数
    let calibrated = baseTokens * (calibration.multiplier || 1.0);
    calibrated += calibration.offset || 0;
    
    // 限制在合理范围内
    return Math.max(1, Math.ceil(calibrated));
  }
}

/**
 * Token 估算器工厂
 * 根据配置创建合适的估算器
 */
export class TokenEstimatorFactory {
  static create(strategy = ESTIMATION_STRATEGY.HEURISTIC, options = {}) {
    switch (strategy) {
      case ESTIMATION_STRATEGY.MODEL_SPECIFIC:
        return new CalibratedTokenEstimator(
          new HeuristicTokenEstimator(options.heuristicOptions)
        );
      case ESTIMATION_STRATEGY.TIKTOKEN:
        // 未来可扩展：动态导入 tiktoken
        console.warn('[TokenEstimator] tiktoken strategy not yet implemented, falling back to heuristic');
        return new HeuristicTokenEstimator(options.heuristicOptions);
      case ESTIMATION_STRATEGY.HEURISTIC:
      default:
        return new HeuristicTokenEstimator(options.heuristicOptions);
    }
  }
}

/**
 * 默认估算器实例（启发式）
 */
export const defaultTokenEstimator = new HeuristicTokenEstimator();

/**
 * 校准估算器实例（模型特定）
 */
export const calibratedTokenEstimator = new CalibratedTokenEstimator(defaultTokenEstimator);

/**
 * 便捷函数：估算消息 token
 */
export function estimateTokens(messages, modelId = null, maxTokens = 1024) {
  const estimator = modelId ? calibratedTokenEstimator : defaultTokenEstimator;
  const inputTokens = estimator.estimateMessages(messages, modelId);
  return inputTokens + maxTokens;
}

/**
 * 校准模型估算系数（用于根据实测数据调整）
 * @param {string} modelId - 模型 ID
 * @param {number} estimatedTokens - 预估 token 数
 * @param {number} actualTokens - 实际消耗 token 数
 * @returns {Object} 校准结果
 */
export function calibrateModel(modelId, estimatedTokens, actualTokens) {
  if (estimatedTokens <= 0 || actualTokens <= 0) {
    return { success: false, reason: 'Invalid token counts' };
  }
  
  const multiplier = actualTokens / estimatedTokens;
  
  // 更新校准表（仅内存，持久化需单独调用）
  const calibrations = loadModelCalibrations();
  calibrations[modelId] = {
    multiplier: Math.round(multiplier * 100) / 100, // 保留 2 位小数
    offset: 0,
    lastCalibrated: new Date().toISOString(),
    sampleCount: (calibrations[modelId]?.sampleCount || 0) + 1
  };
  
  return {
    success: true,
    multiplier: calibrations[modelId].multiplier,
    modelId
  };
}

export default {
  ESTIMATION_STRATEGY,
  HeuristicTokenEstimator,
  CalibratedTokenEstimator,
  TokenEstimatorFactory,
  defaultTokenEstimator,
  calibratedTokenEstimator,
  estimateTokens,
  calibrateModel,
  loadModelCalibrations
};