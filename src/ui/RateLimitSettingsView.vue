<!--
  RateLimitSettingsView.vue - 智能限速设置面板
  Vue 3 单文件组件（动态加载 Providers 下拉、历史提示横幅）
  对应规格书 §5
-->

<template>
  <div class="rate-limit-settings-view">
    <!-- 页面标题 -->
    <div class="page-header">
      <h1 class="page-title">
        <svg class="title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        速率设置
      </h1>
      <p class="page-description">
        配置各提供商的 RPM/TPM 限速参数、退避策略，查看实时监控与 429 历史预警
      </p>
    </div>

    <!-- Provider 选择器 -->
    <div class="provider-selector-section">
      <label class="selector-label">选择服务商</label>
      <div class="selector-wrapper">
        <select 
          v-model="selectedProviderId" 
          class="provider-select"
          @change="onProviderChange"
          :disabled="loadingProviders"
        >
          <option v-for="provider in providers" :key="provider.id" :value="provider.id">
            {{ provider.displayName }} <span class="provider-id-tag">({{ provider.id }})</span>
          </option>
        </select>
        <span class="selector-hint" v-if="loadingProviders">加载中...</span>
      </div>
    </div>

    <!-- 智能历史提示横幅 -->
    <div 
      v-if="historySuggestion && historySuggestion.hasHistory" 
      class="history-warning-banner"
      role="alert"
    >
      <div class="warning-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div class="warning-content">
        <div class="warning-title">历史限流预警</div>
        <div class="warning-message">
          该服务商曾在 
          <strong>{{ historySuggestion.triggeredAtRpm }} RPM</strong> / 
          <strong>{{ historySuggestion.triggeredAtTpm.toLocaleString() }} TPM</strong>
          （模型 <code>{{ historySuggestion.model }}</code>）时触发 <code>429</code> 错误。
        </div>
        <div class="warning-recommendation">
          建议将安全上限调整为 
          <strong>≤ {{ historySuggestion.suggestedSafeRpm }} RPM</strong>
          / 
          <strong>{{ historySuggestion.suggestedSafeTpm.toLocaleString() }} TPM</strong>
        </div>
        <div class="warning-actions">
          <button 
            class="btn btn-primary btn-sm" 
            @click="applySuggestion"
            :disabled="applyingSuggestion"
          >
            <span v-if="applyingSuggestion">应用中...</span>
            <span v-else>一键应用建议值</span>
          </button>
          <button class="btn btn-secondary btn-sm" @click="dismissWarning">
            暂不调整
          </button>
        </div>
      </div>
    </div>

    <!-- 核心限速参数表单 -->
    <form class="settings-form" @submit.prevent="saveSettings">
      <!-- 启用限速控制 -->
      <div class="form-group">
        <label class="form-label">
          <input 
            type="checkbox" 
            v-model="form.enabled" 
            class="checkbox-input"
          >
          <span class="checkbox-label">启用限速控制</span>
        </label>
        <div class="form-hint">关闭后该服务商的所有请求将不再受限速器约束</div>
      </div>

      <div class="form-divider"></div>

      <!-- RPM 设置 -->
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="rpm">每分钟最大请求数 (RPM) <span class="required">*</span></label>
          <div class="input-wrapper">
            <input 
              id="rpm"
              type="number" 
              v-model.number="form.rpm" 
              class="form-input"
              :min="1"
              :max="10000"
              :disabled="!form.enabled"
              required
            >
            <span class="input-unit">次/分</span>
          </div>
          <div class="form-hint">范围：1 - 10000。免费档建议：NVIDIA 40，Agnes 20</div>
        </div>

        <!-- TPM 设置 -->
        <div class="form-group">
          <label class="form-label" for="tpm">每分钟最大 Token 数 (TPM)</label>
          <div class="input-wrapper">
            <input 
              id="tpm"
              type="number" 
              v-model.number="form.tpm" 
              class="form-input"
              :min="0"
              :disabled="!form.enabled"
            >
            <span class="input-unit">Tokens/分</span>
          </div>
          <div class="form-hint">0 表示不限制。建议：Agnes 40000，NVIDIA 可设 100000</div>
        </div>
      </div>

      <!-- RPD 设置（仅 NVIDIA 显示） -->
      <div class="form-group" v-if="selectedProviderId === 'nvidia'">
        <label class="form-label" for="rpd">每日请求配额 (RPD)</label>
        <div class="input-wrapper">
          <input 
            id="rpd"
            type="number" 
            v-model.number="form.rpd" 
            class="form-input"
            :min="0"
            :disabled="!form.enabled"
          >
          <span class="input-unit">次/天</span>
        </div>
        <div class="form-hint">NVIDIA 免费档硬性限制 10000 次/天（UTC 自然日重置）。0 表示不限制</div>
      </div>

      <div class="form-divider"></div>

      <!-- 退避策略 -->
      <div class="form-group">
        <label class="form-label" for="backoffStrategy">429 退避策略</label>
        <select 
          id="backoffStrategy"
          v-model="form.backoffStrategy" 
          class="form-select"
          :disabled="!form.enabled"
        >
          <option value="auto">自动适配（推荐）</option>
          <option value="fixed">固定等待 15s + 抖动</option>
          <option value="exponential">指数退避 [1,2,4,8,16]s + 抖动</option>
        </select>
        <div class="form-hint">
          NVIDIA 缺失 Retry-After 头，推荐固定 15s；Agnes 推荐指数退避；其他优先读取 Retry-After
        </div>
      </div>

      <!-- 固定退避时间（仅固定策略显示） -->
      <div class="form-group" v-if="form.backoffStrategy === 'fixed' && form.enabled">
        <label class="form-label" for="fixedBackoffSeconds">固定退避等待时间 (秒)</label>
        <div class="input-wrapper">
          <input 
            id="fixedBackoffSeconds"
            type="number" 
            v-model.number="form.fixedBackoffSeconds" 
            class="form-input"
            :min="1"
            :max="300"
          >
          <span class="input-unit">秒</span>
        </div>
        <div class="form-hint">默认 NVIDIA 15 秒，批处理模式可设 60 秒</div>
      </div>

      <div class="form-divider"></div>

      <!-- 免费档模式 -->
      <div class="form-group">
        <label class="form-label">
          <input 
            type="checkbox" 
            v-model="form.applyToFreeModelsOnly" 
            class="checkbox-input"
            :disabled="!form.enabled"
          >
          <span class="checkbox-label">仅对免费档模型生效</span>
        </label>
        <div class="form-hint">开启后，付费/高配额模型将不受此限速器约束</div>
      </div>

      <!-- 优先级状态徽章 -->
      <div class="form-group">
        <label class="form-label">配置优先级状态</label>
        <div class="priority-badge" :class="priorityClass">
          {{ priorityLabel }}
        </div>
        <div class="form-hint">
          优先级：用户自定义 > 历史校准 > 系统自动配置 > 默认预设 > 全局兜底
        </div>
      </div>
    </form>

    <!-- 实时监控状态栏 -->
    <div class="monitor-section" v-if="monitorData">
      <h3 class="section-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
        实时监控
      </h3>
      
      <div class="monitor-grid">
        <div class="monitor-item">
          <span class="monitor-label">排队请求数</span>
          <span class="monitor-value">{{ monitorData.queueLength }}</span>
        </div>
        <div class="monitor-item">
          <span class="monitor-label">近 1 分钟请求</span>
          <span class="monitor-value">{{ monitorData.rpm }} / {{ monitorData.rpmLimit }} RPM</span>
          <div class="monitor-bar">
            <div class="monitor-bar-fill" :style="{ width: rpmPercent + '%' }"></div>
          </div>
        </div>
        <div class="monitor-item">
          <span class="monitor-label">近 1 分钟消耗</span>
          <span class="monitor-value">{{ monitorData.tpm.toLocaleString() }} / {{ monitorData.tpmLimit.toLocaleString() }} TPM</span>
          <div class="monitor-bar" v-if="monitorData.tpmLimit > 0">
            <div class="monitor-bar-fill" :style="{ width: tpmPercent + '%' }"></div>
          </div>
        </div>
        <div class="monitor-item" v-if="monitorData.dailyLimit > 0">
          <span class="monitor-label">今日已用 (RPD)</span>
          <span class="monitor-value">{{ monitorData.dailyUsed }} / {{ monitorData.dailyLimit }}</span>
          <div class="monitor-bar">
            <div class="monitor-bar-fill" :style="{ width: dailyPercent + '%' }"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="actions-section">
      <button 
        class="btn btn-primary" 
        @click="saveSettings"
        :disabled="saving"
      >
        <span v-if="saving">保存中...</span>
        <span v-else>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          保存并立即生效
        </span>
      </button>
      
      <button class="btn btn-secondary" @click="resetToDefault" :disabled="saving">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
        恢复默认预设
      </button>
      
      <button class="btn btn-danger" @click="clearHistory" :disabled="clearingHistory">
        <span v-if="clearingHistory">清空中...</span>
        <span v-else>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          清空 429 历史记录
        </span>
      </button>
      
      <button class="btn btn-info" @click="runProbe" :disabled="probing">
        <span v-if="probing">探测中...</span>
        <span v-else>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          运行模型阈值探测
        </span>
      </button>
    </div>

    <!-- 状态消息 -->
    <div v-if="statusMessage" class="status-message" :class="statusType">
      {{ statusMessage }}
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, watch } from 'vue'

// 响应式状态
const providers = ref([])
const selectedProviderId = ref('')
const loadingProviders = ref(false)
const form = ref({
  enabled: true,
  rpm: 40,
  tpm: 0,
  rpd: 10000,
  backoffStrategy: 'auto',
  fixedBackoffSeconds: 15,
  applyToFreeModelsOnly: true
})
const historySuggestion = ref(null)
const monitorData = ref(null)
const statusMessage = ref('')
const statusType = ref('info')
const saving = ref(false)
const clearingHistory = ref(false)
const applyingSuggestion = ref(false)
const probing = ref(false)

// RPC 客户端（通过 DSH 上下文注入）
let rpcClient = null

// 计算属性
const rpmPercent = computed(() => {
  if (!monitorData.value || monitorData.value.rpmLimit === 0) return 0
  return Math.min(100, (monitorData.value.rpm / monitorData.value.rpmLimit) * 100)
})

const tpmPercent = computed(() => {
  if (!monitorData.value || monitorData.value.tpmLimit === 0) return 0
  return Math.min(100, (monitorData.value.tpm / monitorData.value.tpmLimit) * 100)
})

const dailyPercent = computed(() => {
  if (!monitorData.value || monitorData.value.dailyLimit === 0) return 0
  return Math.min(100, (monitorData.value.dailyUsed / monitorData.value.dailyLimit) * 100)
})

const priorityLabel = computed(() => {
  const priority = form.value.priority || 'default_preset'
  const labels = {
    'user_custom': '用户自定义配置',
    'history_calibrated': '历史校准值',
    'system_auto': '系统自动读取配置',
    'default_preset': '默认预设',
    'global_fallback': '全局兜底策略'
  }
  return labels[priority] || priority
})

const priorityClass = computed(() => {
  const priority = form.value.priority || 'default_preset'
  const classes = {
    'user_custom': 'priority-user',
    'history_calibrated': 'priority-history',
    'system_auto': 'priority-system',
    'default_preset': 'priority-default',
    'global_fallback': 'priority-fallback'
  }
  return classes[priority] || ''
})

// 方法
async function loadProviders() {
  loadingProviders.value = true
  try {
    const result = await rpcClient?.getProviders?.()
    if (result?.length > 0) {
      providers.value = result
      if (!selectedProviderId.value) {
        selectedProviderId.value = result[0].id
      }
    }
  } catch (error) {
    console.error('Failed to load providers:', error)
    showStatus('加载提供商列表失败', 'error')
  } finally {
    loadingProviders.value = false
  }
}

async function loadSettings(providerId) {
  try {
    const result = await rpcClient?.getSettings?.(providerId)
    if (result) {
      form.value = { ...form.value, ...result }
      historySuggestion.value = result.historySuggestion || null
    }
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
}

async function loadMonitorData(providerId) {
  try {
    const result = await rpcClient?.getMonitorData?.(providerId)
    if (result) {
      monitorData.value = result
    }
  } catch (error) {
    console.error('Failed to load monitor data:', error)
  }
}

async function onProviderChange() {
  await loadSettings(selectedProviderId.value)
  await loadMonitorData(selectedProviderId.value)
  // 启动监控轮询
  startMonitorPolling()
}

async function saveSettings() {
  saving.value = true
  statusMessage.value = ''
  try {
    const result = await rpcClient?.saveSettings?.(selectedProviderId.value, form.value)
    if (result?.success) {
      showStatus('设置已保存并立即生效', 'success')
      await loadMonitorData(selectedProviderId.value)
    }
  } catch (error) {
    console.error('Failed to save settings:', error)
    showStatus('保存失败：' + error.message, 'error')
  } finally {
    saving.value = false
  }
}

async function resetToDefault() {
  if (!confirm('确定要恢复默认预设吗？这将覆盖当前所有自定义设置。')) return
  
  try {
    const defaultConfig = getDefaultConfigForProvider(selectedProviderId.value)
    form.value = { ...form.value, ...defaultConfig, priority: 'default_preset' }
    await rpcClient?.saveSettings?.(selectedProviderId.value, form.value)
    showStatus('已恢复默认预设', 'success')
    await loadSettings(selectedProviderId.value)
  } catch (error) {
    console.error('Failed to reset:', error)
    showStatus('恢复失败：' + error.message, 'error')
  }
}

async function applySuggestion() {
  applyingSuggestion.value = true
  try {
    const result = await rpcClient?.applySuggestion?.(selectedProviderId.value)
    if (result?.success && result.suggestion) {
      form.value.rpm = result.suggestion.suggestedSafeRpm
      form.value.tpm = result.suggestion.suggestedSafeTpm
      form.value.priority = 'history_calibrated'
      await rpcClient?.saveSettings?.(selectedProviderId.value, form.value)
      showStatus('已应用历史建议值', 'success')
      await loadSettings(selectedProviderId.value)
    }
  } catch (error) {
    console.error('Failed to apply suggestion:', error)
    showStatus('应用失败：' + error.message, 'error')
  } finally {
    applyingSuggestion.value = false
  }
}

function dismissWarning() {
  historySuggestion.value = null
}

async function clearHistory() {
  if (!confirm('确定要清空该服务商的所有 429 历史记录吗？此操作不可撤销。')) return
  
  clearingHistory.value = true
  try {
    const result = await rpcClient?.clearHistory?.(selectedProviderId.value)
    if (result?.success) {
      historySuggestion.value = null
      showStatus('历史记录已清空', 'success')
    }
  } catch (error) {
    console.error('Failed to clear history:', error)
    showStatus('清空失败：' + error.message, 'error')
  } finally {
    clearingHistory.value = false
  }
}

async function runProbe() {
  probing.value = true
  try {
    const result = await rpcClient?.runProbe?.(selectedProviderId.value)
    if (result?.success) {
      showStatus('探测已启动，结果将在完成后显示', 'info')
    }
  } catch (error) {
    console.error('Failed to run probe:', error)
    showStatus('探测失败：' + error.message, 'error')
  } finally {
    probing.value = false
  }
}

function getDefaultConfigForProvider(providerId) {
  const defaults = {
    nvidia: { rpm: 40, tpm: 0, rpd: 10000, backoffStrategy: 'fixed', fixedBackoffSeconds: 15 },
    agnes: { rpm: 20, tpm: 40000, rpd: 0, backoffStrategy: 'exponential', fixedBackoffSeconds: 60 },
    default: { rpm: 60, tpm: 0, rpd: 0, backoffStrategy: 'exponential', fixedBackoffSeconds: 60 }
  }
  return defaults[providerId] || defaults.default
}

function showStatus(message, type = 'info') {
  statusMessage.value = message
  statusType.value = type
  if (type !== 'error') {
    setTimeout(() => { statusMessage.value = '' }, 5000)
  }
}

function startMonitorPolling() {
  // 清除旧的轮询
  if (monitorPollingInterval.value) {
    clearInterval(monitorPollingInterval.value)
  }
  
  // 每 5 秒轮询一次监控数据
  monitorPollingInterval.value = setInterval(async () => {
    if (selectedProviderId.value) {
      await loadMonitorData(selectedProviderId.value)
    }
  }, 5000)
}

const monitorPollingInterval = ref(null)

// 生命周期
onMounted(async () => {
  // 从全局上下文获取 RPC 客户端
  // 在 DSH 环境中，这通常通过 provide/inject 或全局变量注入
  if (window.__DSH_SMART_RATELIMIT_RPC__) {
    rpcClient = window.__DSH_SMART_RATELIMIT_RPC__
  } else if (window.dsh?.plugins?.['smart-ratelimit']?.rpc) {
    rpcClient = window.dsh.plugins['smart-ratelimit'].rpc
  }
  
  await loadProviders()
  
  // 组件卸载时清理
  return () => {
    if (monitorPollingInterval.value) {
      clearInterval(monitorPollingInterval.value)
    }
  }
})
</script>

<style scoped>
/* 页面整体布局 */
.rate-limit-settings-view {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #1a1a2e;
}

/* 页面标题 */
.page-header {
  margin-bottom: 32px;
}

.page-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 28px;
  font-weight: 700;
  color: #1a1a2e;
  margin: 0 0 8px 0;
}

.title-icon {
  width: 32px;
  height: 32px;
  color: #3b82f6;
}

.page-description {
  font-size: 15px;
  color: #64748b;
  margin: 0;
}

/* Provider 选择器 */
.provider-selector-section {
  margin-bottom: 24px;
}

.selector-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 8px;
}

.selector-wrapper {
  position: relative;
}

.provider-select {
  width: 100%;
  max-width: 400px;
  padding: 12px 16px;
  font-size: 15px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: white;
  color: #1a1a2e;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 44px;
}

.provider-select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.provider-select:disabled {
  background: #f3f4f6;
  color: #9ca3af;
  cursor: not-allowed;
}

.provider-id-tag {
  font-size: 12px;
  color: #9ca3af;
  font-family: monospace;
}

.selector-hint {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 13px;
  color: #9ca3af;
}

/* 历史预警横幅 */
.history-warning-banner {
  display: flex;
  gap: 16px;
  padding: 20px;
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-radius: 12px;
  margin-bottom: 24px;
  animation: slideDown 0.3s ease-out;
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

.warning-icon {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  color: #f59e0b;
  margin-top: 2px;
}

.warning-content {
  flex: 1;
}

.warning-title {
  font-size: 15px;
  font-weight: 600;
  color: #92400e;
  margin-bottom: 6px;
}

.warning-message {
  font-size: 14px;
  color: #92400e;
  line-height: 1.6;
  margin-bottom: 8px;
}

.warning-message code {
  background: rgba(0,0,0,0.05);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
}

.warning-recommendation {
  font-size: 14px;
  color: #92400e;
  margin-bottom: 12px;
}

.warning-recommendation strong {
  color: #b45309;
}

.warning-actions {
  display: flex;
  gap: 10px;
}

/* 表单样式 */
.settings-form {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: #374151;
  margin-bottom: 8px;
  cursor: pointer;
}

.form-label > input[type="checkbox"] {
  width: 18px;
  height: 18px;
  accent-color: #3b82f6;
}

.required {
  color: #ef4444;
}

.form-hint {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 4px;
}

.form-divider {
  height: 1px;
  background: #e5e7eb;
  margin: 16px 0;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.input-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-input {
  flex: 1;
  padding: 10px 12px;
  font-size: 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: white;
  color: #1a1a2e;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.form-input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.form-input:disabled {
  background: #f3f4f6;
  color: #9ca3af;
  cursor: not-allowed;
}

.input-unit {
  font-size: 13px;
  color: #9ca3af;
  white-space: nowrap;
}

.form-select {
  width: 100%;
  max-width: 300px;
  padding: 10px 12px;
  font-size: 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: white;
  color: #1a1a2e;
  cursor: pointer;
}

.form-select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.form-select:disabled {
  background: #f3f4f6;
  color: #9ca3af;
  cursor: not-allowed;
}

/* 优先级徽章 */
.priority-badge {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 20px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.priority-user { background: #dbeafe; color: #1e40af; }
.priority-history { background: #fef3c7; color: #92400e; }
.priority-system { background: #e0e7ff; color: #3730a3; }
.priority-default { background: #f3f4f6; color: #374151; }
.priority-fallback { background: #fee2e2; color: #991b1b; }

/* 监控区域 */
.monitor-section {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
  color: #1a1a2e;
  margin: 0 0 20px 0;
}

.section-title svg {
  width: 20px;
  height: 20px;
  color: #3b82f6;
}

.monitor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 20px;
}

.monitor-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.monitor-label {
  font-size: 12px;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.monitor-value {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a2e;
  font-variant-numeric: tabular-nums;
}

.monitor-bar {
  height: 6px;
  background: #e5e7eb;
  border-radius: 3px;
  overflow: hidden;
}

.monitor-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #60a5fa);
  border-radius: 3px;
  transition: width 0.3s ease;
}

/* 操作按钮 */
.actions-section {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid #e5e7eb;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 500;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-icon {
  width: 18px;
  height: 18px;
}

.btn-primary {
  background: #3b82f6;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #2563eb;
}

.btn-secondary {
  background: #f3f4f6;
  color: #374151;
  border: 1px solid #d1d5db;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn-danger {
  background: #fef2f2;
  color: #dc2626;
  border: 1px solid #fecaca;
}

.btn-danger:hover:not(:disabled) {
  background: #fee2e2;
}

.btn-info {
  background: #eff6ff;
  color: #2563eb;
  border: 1px solid #bfdbfe;
}

.btn-info:hover:not(:disabled) {
  background: #dbeafe;
}

.btn-sm {
  padding: 8px 14px;
  font-size: 13px;
}

/* 状态消息 */
.status-message {
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 14px;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.status-message.success {
  background: #dcfce7;
  color: #166534;
  border: 1px solid #86efac;
}

.status-message.error {
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
}

.status-message.info {
  background: #dbeafe;
  color: #1e40af;
  border: 1px solid #bfdbfe;
}

/* 响应式调整 */
@media (max-width: 640px) {
  .rate-limit-settings-view {
    padding: 16px;
  }
  
  .form-row {
    grid-template-columns: 1fr;
  }
  
  .monitor-grid {
    grid-template-columns: 1fr;
  }
  
  .actions-section {
    flex-direction: column;
  }
  
  .btn {
    width: 100%;
  }
}
</style>