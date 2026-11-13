/**
 * NVCF Poller - NVCF 异步轮询处理器
 * 对应规格书 §3.2, §7
 * 
 * 特性：
 * - 可配置的最大轮询次数、轮询间隔、总超时时间
 * - 错误分类：可重试 vs 不可重试
 * - 通过拦截器发送轮询请求（但标记为 skipRateLimit 避免重复扣减）
 * - 支持 AbortSignal 取消
 */

// 仅导入单例 requestInterceptor（轮询请求通过它标记 _skipRateLimit 跳过扣减）
// 不导入 RequestInterceptor 类（本模块不实例化），避免死导入
// 注意：requestInterceptor.js 反向导入 nvcfPoller，形成循环依赖；
// 这里只取单例（模块加载完成后才使用），node ESM 对循环依赖的导出绑定是延迟求值的，可正常工作
import { requestInterceptor } from './requestInterceptor.js';

/**
 * 默认轮询配置
 */
export const DEFAULT_POLL_CONFIG = {
  maxAttempts: 60,           // 最大轮询次数
  pollIntervalMs: 5000,      // 轮询间隔（毫秒）
  totalTimeoutMs: 300000,    // 总超时时间（5分钟）
  retryableStatuses: [202, 429, 500, 502, 503, 504], // 可重试的 HTTP 状态码
  nonRetryableStatuses: [400, 401, 403, 404, 409],   // 不可重试的 HTTP 状态码
};

/**
 * 错误分类工具
 */
export function classifyError(error, response) {
  // 网络错误通常可重试
  if (error && !response) {
    return { retryable: true, reason: 'network_error' };
  }
  
  if (!response) {
    return { retryable: true, reason: 'unknown_error' };
  }
  
  const status = response.status;
  
  // 显式可重试状态
  if (DEFAULT_POLL_CONFIG.retryableStatuses.includes(status)) {
    return { retryable: true, reason: `status_${status}` };
  }
  
  // 显式不可重试状态
  if (DEFAULT_POLL_CONFIG.nonRetryableStatuses.includes(status)) {
    return { retryable: false, reason: `status_${status}` };
  }
  
  // 其他 5xx 错误视为可重试
  if (status >= 500 && status < 600) {
    return { retryable: true, reason: `status_${status}` };
  }
  
  // 其他 4xx 错误视为不可重试
  if (status >= 400 && status < 500) {
    return { retryable: false, reason: `status_${status}` };
  }
  
  // 默认可重试
  return { retryable: true, reason: 'default_retryable' };
}

/**
 * NVCF 异步轮询处理器
 */
export class NVCFPoller {
  constructor(config = {}) {
    this.config = { ...DEFAULT_POLL_CONFIG, ...config };
  }
  
  /**
   * 执行轮询
   * @param {Object} request - 原始请求对象
   * @param {Object} response - 初始 202 响应
   * @param {Object} options - 选项
   * @param {AbortSignal} options.signal - 取消信号
   * @returns {Promise<Object>} 最终响应
   */
  async poll(request, response, options = {}) {
    const { signal } = options;
    const pollUrl = response.headers?.['nvcf-poll-url'] || response.data?.poll_url;
    const pollSeconds = response.headers?.['nvcf-poll-seconds'] || response.data?.poll_seconds;
    
    if (!pollUrl) {
      return response;
    }
    
    const pollIntervalMs = pollSeconds ? pollSeconds * 1000 : this.config.pollIntervalMs;
    const maxAttempts = this.config.maxAttempts;
    const totalTimeoutMs = this.config.totalTimeoutMs;
    
    // 从原始请求获取授权头
    const authHeader = request.headers?.authorization || request.headers?.Authorization;
    const pollHeaders = {
      'Accept': 'application/json',
      ...(authHeader && { 'Authorization': authHeader })
    };
    
    const startTime = Date.now();
    let attempts = 0;
    let lastError = null;
    
    // 创建轮询请求对象（标记 skipRateLimit = true，避免重复扣减）
    const pollRequest = {
      ...request,
      method: 'GET',
      url: pollUrl,
      headers: pollHeaders,
      _skipRateLimit: true,  // 标记跳过限速
      _isPolling: true
    };
    
    while (attempts < maxAttempts) {
      // 检查总超时
      if (Date.now() - startTime > totalTimeoutMs) {
        return this.createTimeoutResponse(response, attempts, totalTimeoutMs);
      }
      
      // 检查取消信号
      if (signal?.aborted) {
        return this.createAbortedResponse(response, attempts);
      }
      
      // 等待轮询间隔
      await this.sleep(pollIntervalMs, signal);
      
      // 再次检查取消（睡眠后）
      if (signal?.aborted) {
        return this.createAbortedResponse(response, attempts);
      }
      
      attempts++;
      
      try {
        // 通过拦截器发送轮询请求（但会跳过限速扣减）
        const pollResponse = await requestInterceptor.intercept(pollRequest);
        
        // 实际发送 HTTP 请求
        const httpResponse = await this.sendPollRequest(pollUrl, pollHeaders);
        const pollData = await httpResponse.json().catch(() => ({}));
        
        // 分类错误
        const errorClass = classifyError(null, httpResponse);
        
        if (httpResponse.ok && pollData && Object.keys(pollData).length > 0) {
          // 轮询成功，返回最终结果
          return this.createSuccessResponse(response, httpResponse, pollData, attempts);
        }
        
        // 202 继续轮询
        if (httpResponse.status === 202) {
          continue;
        }
        
        // 其他状态码
        if (!errorClass.retryable) {
          // 不可重试错误，直接返回
          return this.createErrorResponse(response, httpResponse, pollData, attempts, false);
        }
        
        // 可重试错误，记录并继续
        lastError = new Error(`Polling failed with status ${httpResponse.status}`);
        continue;
        
      } catch (error) {
        // 网络错误等
        const errorClass = classifyError(error, null);
        lastError = error;
        
        if (!errorClass.retryable) {
          return this.createExceptionResponse(response, error, attempts, false);
        }
        
        // 可重试，继续下一次
        continue;
      }
    }
    
    // 达到最大尝试次数
    return this.createTimeoutResponse(response, attempts, totalTimeoutMs, lastError);
  }
  
  /**
   * 发送轮询 HTTP 请求
   */
  async sendPollRequest(pollUrl, headers) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 单次请求 30s 超时
    
    try {
      const response = await fetch(pollUrl, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
  
  /**
   * 带取消支持的睡眠
   */
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(resolve, ms);
      
      if (signal) {
        const abortHandler = () => {
          clearTimeout(timeoutId);
          reject(new Error('Aborted'));
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }
  
  /**
   * 创建成功响应
   */
  createSuccessResponse(originalResponse, httpResponse, data, attempts) {
    return {
      ...originalResponse,
      status: httpResponse.status,
      statusText: httpResponse.statusText,
      headers: Object.fromEntries(httpResponse.headers.entries()),
      data,
      _polling: true,
      _pollAttempts: attempts,
      _pollCompleted: true
    };
  }
  
  /**
   * 创建错误响应（HTTP 错误状态）
   */
  createErrorResponse(originalResponse, httpResponse, data, attempts, completed) {
    return {
      ...originalResponse,
      status: httpResponse.status,
      statusText: httpResponse.statusText,
      headers: Object.fromEntries(httpResponse.headers.entries()),
      data,
      _polling: true,
      _pollAttempts: attempts,
      _pollCompleted: completed,
      _pollError: `Polling failed with status ${httpResponse.status}`
    };
  }
  
  /**
   * 创建异常响应（网络错误等）
   */
  createExceptionResponse(originalResponse, error, attempts, completed) {
    return {
      ...originalResponse,
      _polling: true,
      _pollAttempts: attempts,
      _pollCompleted: completed,
      _pollError: error.message
    };
  }
  
  /**
   * 创建超时响应
   */
  createTimeoutResponse(originalResponse, attempts, timeoutMs, lastError = null) {
    return {
      ...originalResponse,
      _polling: true,
      _pollAttempts: attempts,
      _pollCompleted: false,
      _pollError: lastError 
        ? `Polling timeout after ${timeoutMs}ms: ${lastError.message}`
        : `Polling timeout after ${timeoutMs}ms (${attempts} attempts)`
    };
  }
  
  /**
   * 创建取消响应
   */
  createAbortedResponse(originalResponse, attempts) {
    return {
      ...originalResponse,
      _polling: true,
      _pollAttempts: attempts,
      _pollCompleted: false,
      _pollError: 'Polling aborted'
    };
  }
}

/**
 * 默认实例
 */
export const nvcfPoller = new NVCFPoller();

export default {
  NVCFPoller,
  nvcfPoller,
  DEFAULT_POLL_CONFIG,
  classifyError
};