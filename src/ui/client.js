/**
 * dsh-plugin-smart-ratelimit — Web UI half.
 *
 * 在 Settings 页左侧菜单（settings.section 插槽，order 100 = 最底部）注册
 * 「智能限速中心」，并渲染其内容。面板与宿主半部通过同源 RPC 路由通信：
 *   POST /api/dsh-plugin-smart-ratelimit/rpc   { method, args } -> { ok, value } | { ok:false, error }
 *
 * 纯 JavaScript：模块加载器的 factory 不能依赖构建步骤，也不能依赖 React 以外的 npm 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-smart-ratelimit',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /** 面板 id（设置页 section id）。 */
    const PANEL_ID = 'smart-ratelimit'
    /** 同源 RPC 路由（服务端注册）。 */
    const RPC_PATH = '/api/dsh-plugin-smart-ratelimit/rpc'
    /** 设置页排序：内置项最大 15，彩虹皮肤 90，这里取 100 → 最底部。 */
    const SECTION_ORDER = 100
    /** 监控轮询间隔。 */
    const POLL_MS = 5000

    /** 面板样式。 */
    const CSS = `
.rate-limit-settings-view {
  max-width: 720px;
  padding: 4px 0 8px;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1a1a2e;
  -webkit-font-smoothing: antialiased;
}
.rl-group-title {
  font-size: 12px;
  font-weight: 500;
  color: #9a9a9a;
  letter-spacing: 0.02em;
  margin: 22px 0 4px;
}
.rl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 11px 0;
}
.rl-row-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  margin: 6px 0 12px;
  border: 1px solid #ebe6db;
  border-radius: 14px;
  background: #fffdf8;
}
.rl-provider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.rl-provider-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}
.rl-provider-error {
  flex: 1 1 auto; min-width: 0;
  font-size: 12px; color: #c0392b;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rl-row-main { flex: 1 1 auto; min-width: 0; }
.rl-row-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; font-weight: 400; color: #1a1a2e; margin: 0;
}
/* 标题后的问号提示：悬停/聚焦显示浮动说明，替代行内浅灰描述。 */
.rl-help {
  display: inline-flex; align-items: center; justify-content: center;
  width: 15px; height: 15px; border-radius: 50%;
  border: 1px solid #d4d4d4; background: #fff; color: #9a9a9a;
  font-size: 10px; font-weight: 600; line-height: 1; cursor: help;
  flex-shrink: 0; outline: none; user-select: none;
}
.rl-help:hover, .rl-help:focus-visible { border-color: #4a7dff; color: #4a7dff; }
.rl-tooltip {
  position: fixed; z-index: 1000; width: 260px; padding: 8px 10px;
  border-radius: 8px; background: #2a2a2e; color: #fff;
  font-size: 12px; line-height: 1.55; text-align: left; white-space: normal;
  box-shadow: 0 8px 24px rgba(0,0,0,0.22); pointer-events: none;
}
.rl-row-control {
  flex: 0 0 280px;
  width: 280px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding-top: 1px;
}
.rl-switch {
  position: relative; width: 42px; height: 24px; border-radius: 12px;
  border: none; padding: 0; background: #e3e3e3; cursor: pointer;
  transition: background-color 0.18s ease; flex-shrink: 0;
  margin-left: auto;
}
.rl-switch:disabled { opacity: 0.45; cursor: not-allowed; }
.rl-switch[data-on='true'] { background: #1f1f1f; }
.rl-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.18);
  transition: transform 0.18s ease;
}
.rl-switch[data-on='true'] .rl-switch-knob { transform: translateX(18px); }
.rl-number {
  flex: 0 0 160px; width: 160px;
  padding: 6px 10px; font-size: 13px; font-family: inherit;
  color: inherit; border: 1px solid #e3e3e3; border-radius: 8px; background: #fff;
  text-align: right; font-variant-numeric: tabular-nums; outline: none;
  transition: border-color 0.15s ease;
}
.rl-number:focus { border-color: #4a7dff; }
.rl-number:disabled { opacity: 0.45; cursor: not-allowed; }
.rl-unit { font-size: 12px; color: #8b8b8b; min-width: 56px; }
.rl-select {
  width: 280px; max-width: 280px; padding: 6px 28px 6px 10px;
  font-size: 13px; font-family: inherit; color: inherit;
  border: 1px solid #e3e3e3; border-radius: 8px; background-color: #fff;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238b8b8b' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 8px center;
  appearance: none; -webkit-appearance: none; outline: none; cursor: pointer;
}
.rl-select:focus { border-color: #4a7dff; }
.rl-select:disabled { opacity: 0.45; cursor: not-allowed; }
.rl-add-form {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 0 0 10px 4px;
}
.rl-input {
  padding: 6px 10px; font-size: 13px; font-family: inherit; color: inherit;
  border: 1px solid #e3e3e3; border-radius: 8px; background: #fff;
  outline: none; min-width: 170px; transition: border-color 0.15s ease;
}
.rl-input:focus { border-color: #4a7dff; }
.rl-input::placeholder { color: #b0b0b0; }
.rl-banner {
  display: flex; gap: 10px; padding: 10px 12px; margin: 8px 0 4px;
  border-radius: 10px; background: #fff8e6; border: 1px solid #ffe1a6;
}
.rl-banner-icon { width: 16px; height: 16px; color: #d9930a; flex-shrink: 0; margin-top: 2px; }
.rl-banner-body { flex: 1 1 auto; min-width: 0; }
.rl-banner-title { font-size: 13px; font-weight: 500; color: #8a5a00; }
.rl-banner-text { font-size: 12px; color: #8a5a00; margin-top: 2px; line-height: 1.55; }
.rl-banner-actions { display: flex; gap: 8px; margin-top: 8px; }
.rl-monitor { margin-top: 12px; padding-top: 10px; border-top: 1px solid #f0f0f0; }
.rl-monitor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-top: 4px; }
.rl-monitor-item { display: flex; flex-direction: column; gap: 4px; }
.rl-monitor-label { font-size: 11px; color: #9a9a9a; }
.rl-monitor-value { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.rl-monitor-bar { height: 4px; border-radius: 2px; background: #f0f0f0; overflow: hidden; }
.rl-monitor-fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, #4a7dff, #7aa2ff); transition: width 0.3s ease; }
.rl-badge {
  display: inline-block; padding: 3px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 500; background: #f4f4f4; color: #666;
  margin-left: auto;
}
.rl-badge[data-priority='user_custom'] { background: #eaf1ff; color: #2f6bff; }
.rl-badge[data-priority='history_calibrated'] { background: #fff4e0; color: #b06d00; }
.rl-badge[data-priority='system_auto'] { background: #eef0ff; color: #4b4fd6; }
.rl-badge[data-priority='global_fallback'] { background: #ffecec; color: #c0392b; }
.rl-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  margin-top: 16px; padding-top: 12px; border-top: 1px solid #f0f0f0;
}
.rl-btn {
  padding: 6px 14px; font-size: 13px; font-family: inherit; color: #333;
  background: #fff; border: 1px solid #e3e3e3; border-radius: 8px; cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease; white-space: nowrap;
}
.rl-btn:hover:not(:disabled) { background: #f7f7f7; }
.rl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rl-btn[data-variant='primary'] { color: #1a1a2e; font-weight: 500; background: #fff; border-color: #dcd7cc; }
.rl-btn[data-variant='primary']:hover:not(:disabled) { background: #f6f3ec; }
.rl-btn[data-variant='danger'] { color: #e5484d; background: transparent; border-color: transparent; padding-left: 8px; padding-right: 8px; }
.rl-btn[data-variant='danger']:hover:not(:disabled) { background: #fff0f0; }
.rl-status { margin-top: 10px; font-size: 12px; line-height: 1.5; padding: 7px 10px; border-radius: 8px; }
.rl-status[data-kind='success'] { background: #eefaf1; color: #1e7a3c; }
.rl-status[data-kind='error'] { background: #fff2f1; color: #c0392b; }
.rl-status[data-kind='info'] { background: #eef4ff; color: #2f6bff; }
@media (prefers-color-scheme: dark) {
  .rate-limit-settings-view { color: #e8e8ea; }
  .rl-row-title { color: #e8e8ea; }
  .rl-unit, .rl-monitor-label, .rl-group-title { color: #9a9aa0; }
  .rl-help { background: #2a2a2e; border-color: #3a3a40; color: #9a9aa0; }
  .rl-tooltip { background: #f0f0f2; color: #1a1a2e; }
  .rl-row-card { background: #232327; border-color: #33333a; }
  .rl-number, .rl-select, .rl-btn { background: #2a2a2e; color: #e8e8ea; border-color: #3a3a40; }
  .rl-btn[data-variant='primary'] { background: #4a7dff; border-color: #4a7dff; color: #fff; }
  .rl-switch { background: #3a3a40; }
  .rl-switch[data-on='true'] { background: #f0f0f0; }
  .rl-switch[data-on='true'] .rl-switch-knob { background: #1f1f1f; }
  .rl-monitor-bar { background: #3a3a40; }
  .rl-footer, .rl-monitor { border-color: #33333a; }
  .rl-badge { background: #3a3a40; color: #b8b8be; }
}
`

    /** 中英文文案。 */
    const DICT = {
      zh: {
        nav: '速率设置',
        provider: '服务商',
        providerDesc: '选择要配置限速策略的服务商，列表来自 DSH 当前已配置的 provider。',
        loading: '加载中…',
        providersFailed: '服务商列表加载失败',
        retry: '重试',
        noProviders: '未发现已配置的服务商',
        addProvider: '新增',
        removeProvider: '删除',
        newProviderId: 'provider id（如 my-provider）',
        newProviderName: '显示名（可选）',
        confirm: '确定',
        cancel: '取消',
        adding: '添加中…',
        removing: '删除中…',
        providerAdded: '已新增服务商',
        providerRemoved: '已移除该服务商的限速配置',
        addFailed: '新增失败',
        removeFailed: '移除失败',
        confirmRemove: '确定移除「{id}」的限速配置吗？之后它不会再出现在列表中。',
        enabled: '启用限速控制',
        enabledDesc: '关闭后该服务商的所有请求将不再受限速器约束。',
        sectionLimits: '限速参数',
        sectionBackoff: '退避与生效范围',
        rpm: '每分钟最大请求数',
        rpmDesc: 'RPM，范围 1–10000。免费档建议：NVIDIA 40，Agnes 20。',
        rpmUnit: '次/分',
        tpm: '每分钟最大 Token 数',
        tpmDesc: 'TPM，0 表示不限制。建议：Agnes 40000，NVIDIA 可设 100000。',
        tpmUnit: 'Token/分',
        rpd: '每日请求配额',
        rpdDesc: 'RPD，NVIDIA 免费档硬性限制 10000 次/天（UTC 自然日重置）。0 表示不限制。',
        rpdUnit: '次/天',
        backoff: '429 退避策略',
        backoffDesc: 'NVIDIA 不返回 Retry-After，推荐固定 15s；Agnes 推荐指数退避；其他优先读取 Retry-After。',
        backoffAuto: '自动适配',
        backoffFixed: '固定 15s + 抖动',
        backoffExp: '指数退避',
        fixedSeconds: '固定退避等待时间',
        fixedSecondsDesc: '默认 NVIDIA 15 秒，批处理模式可设 60 秒。',
        secondsUnit: '秒',
        freeOnly: '仅对免费档模型生效',
        freeOnlyDesc: '开启后，付费/高配额模型将不受此限速器约束。',
        priority: '配置优先级',
        priorityDesc: '用户自定义 > 历史校准 > 系统自动配置 > 默认预设 > 全局兜底。',
        historyTitle: '历史限流预警',
        historyBody: '曾在 {rpm} RPM / {tpm} TPM（模型 {model}）触发 429。建议安全上限 ≤ {safeRpm} RPM / {safeTpm} TPM。',
        rpdWarningTitle: '日配额预警',
        rpdWarningBody: '今日已用 {used} / {limit} 次（{percent}%），接近每日限额。建议检查配置或升级套餐。',
        applySuggestion: '一键应用建议值',
        applying: '应用中…',
        dismiss: '暂不调整',
        monitor: '实时监控',
        queueLength: '排队请求',
        rpmUsed: '近 1 分钟请求',
        tpmUsed: '近 1 分钟消耗',
        rpdUsed: '今日已用',
        save: '保存并生效',
        saving: '保存中…',
        reset: '恢复默认',
        clear: '清空 429 历史',
        clearing: '清空中…',
        probe: '探测模型阈值',
        probing: '探测中…',
        saved: '设置已保存并立即生效',
        resetDone: '已恢复默认预设',
        suggestionApplied: '已应用历史建议值',
        historyCleared: '429 历史已清空',
        probeStarted: '探测已启动，结果将在完成后显示',
        saveFailed: '保存失败',
        resetFailed: '恢复失败',
        applyFailed: '应用失败',
        clearFailed: '清空失败',
        probeFailed: '探测失败',
        unknownModel: '未知模型',
        confirmReset: '确定要恢复默认预设吗？这将覆盖当前所有自定义设置。',
        confirmClear: '确定要清空该服务商的所有 429 历史记录吗？此操作不可撤销。',
        priorityUser: '用户自定义',
        priorityHistory: '历史校准',
        prioritySystem: '系统自动',
        priorityDefault: '默认预设',
        priorityFallback: '全局兜底',
      },
      en: {
        nav: 'Rate Settings',
        provider: 'Provider',
        providerDesc: 'Pick the provider whose rate limit you want to configure; the list comes from DSH configured providers.',
        loading: 'Loading…',
        providersFailed: 'Failed to load providers',
        retry: 'Retry',
        noProviders: 'No configured provider found',
        addProvider: 'Add',
        removeProvider: 'Remove',
        newProviderId: 'provider id (e.g. my-provider)',
        newProviderName: 'Display name (optional)',
        confirm: 'OK',
        cancel: 'Cancel',
        adding: 'Adding…',
        removing: 'Removing…',
        providerAdded: 'Provider added',
        providerRemoved: 'Provider rate-limit config removed',
        addFailed: 'Add failed',
        removeFailed: 'Remove failed',
        confirmRemove: 'Remove the rate-limit config of "{id}"? It will no longer appear in the list.',
        enabled: 'Enable rate limiting',
        enabledDesc: 'When off, requests to this provider are no longer throttled.',
        sectionLimits: 'Rate limits',
        sectionBackoff: 'Backoff and scope',
        rpm: 'Max requests per minute',
        rpmDesc: 'RPM, range 1-10000. Free tier: NVIDIA 40, Agnes 20.',
        rpmUnit: 'req/min',
        tpm: 'Max tokens per minute',
        tpmDesc: 'TPM, 0 means unlimited. Suggested: Agnes 40000, NVIDIA 100000.',
        tpmUnit: 'tokens/min',
        rpd: 'Daily request quota',
        rpdDesc: 'RPD, NVIDIA free tier caps at 10000/day (UTC reset). 0 means unlimited.',
        rpdUnit: 'req/day',
        backoff: '429 backoff strategy',
        backoffDesc: 'NVIDIA omits Retry-After (fixed 15s works best); Agnes prefers exponential; others honor Retry-After.',
        backoffAuto: 'Automatic',
        backoffFixed: 'Fixed 15s + jitter',
        backoffExp: 'Exponential',
        fixedSeconds: 'Fixed backoff',
        fixedSecondsDesc: 'Default 15s for NVIDIA; 60s works better for batch jobs.',
        secondsUnit: 's',
        freeOnly: 'Apply to free-tier models only',
        freeOnlyDesc: 'Paid / high-quota models bypass this limiter.',
        priority: 'Configuration priority',
        priorityDesc: 'User custom > history calibrated > system auto > default preset > global fallback.',
        historyTitle: 'Rate-limit warning',
        historyBody: 'Hit 429 at {rpm} RPM / {tpm} TPM (model {model}). Suggested ceiling: {safeRpm} RPM / {safeTpm} TPM.',
        rpdWarningTitle: 'Daily quota warning',
        rpdWarningBody: 'Used {used} / {limit} requests today ({percent}%), approaching daily limit. Check config or upgrade plan.',
        applySuggestion: 'Apply suggested values',
        applying: 'Applying…',
        dismiss: 'Not now',
        monitor: 'Live monitor',
        queueLength: 'Queued',
        rpmUsed: 'Last minute requests',
        tpmUsed: 'Last minute tokens',
        rpdUsed: 'Used today',
        save: 'Save and apply',
        saving: 'Saving…',
        reset: 'Restore defaults',
        clear: 'Clear 429 history',
        clearing: 'Clearing…',
        probe: 'Probe thresholds',
        probing: 'Probing…',
        saved: 'Settings saved and applied',
        resetDone: 'Defaults restored',
        suggestionApplied: 'Suggested values applied',
        historyCleared: '429 history cleared',
        probeStarted: 'Probe started; results appear when it finishes',
        saveFailed: 'Save failed',
        resetFailed: 'Restore failed',
        applyFailed: 'Apply failed',
        clearFailed: 'Clear failed',
        probeFailed: 'Probe failed',
        unknownModel: 'unknown model',
        confirmReset: 'Restore defaults? This overwrites all custom settings.',
        confirmClear: 'Clear all 429 history for this provider? This cannot be undone.',
        priorityUser: 'User custom',
        priorityHistory: 'History calibrated',
        prioritySystem: 'System auto',
        priorityDefault: 'Default preset',
        priorityFallback: 'Global fallback',
      },
    }

    /**
     * 面板文案。DSH 桌面端进程带 --lang=en-US，navigator.language 因此是 en-US，
     * 但界面以中文为主，这里默认中文；仅在明确的中文之外语言偏好下才用英文。
     */
    const pickDict = () => DICT.zh

    /** 警示字形。 */
    const WarnIcon = ({ className }) =>
      h('svg', { className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
        h('path', { d: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }),
        h('line', { x1: 12, y1: 9, x2: 12, y2: 13 }),
        h('line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }),
      )

    /** 优先级 → 文案键。 */
    const PRIORITY_LABEL = {
      user_custom: 'priorityUser',
      history_calibrated: 'priorityHistory',
      system_auto: 'prioritySystem',
      default_preset: 'priorityDefault',
      global_fallback: 'priorityFallback',
    }

    /** 表单默认值。 */
    const DEFAULT_FORM = {
      enabled: true,
      rpm: 40,
      tpm: 0,
      rpd: 10000,
      backoffStrategy: 'auto',
      fixedBackoffSeconds: 15,
      applyToFreeModelsOnly: true,
      priority: 'default_preset',
    }

    /** 只保留可编辑字段，避免把 RPC 附带字段回写。 */
    const toForm = (settings) => {
      const next = { ...DEFAULT_FORM }
      if (settings && typeof settings === 'object') {
        for (const key of Object.keys(DEFAULT_FORM)) {
          if (settings[key] !== undefined && settings[key] !== null) next[key] = settings[key]
        }
      }
      return next
    }

    /** 标题后的问号提示：悬停或聚焦时显示浮动说明。 */
    function HelpTip({ text }) {
      const [tip, setTip] = useState(null)
      const ref = useRef(null)

      const show = () => {
        const el = ref.current
        if (!el || !text) return
        const rect = el.getBoundingClientRect()
        const width = 260
        const margin = 8
        const left = Math.min(
          Math.max(rect.left + rect.width / 2, width / 2 + margin),
          window.innerWidth - width / 2 - margin,
        )
        // 上方空间不足时改为向下展开，避免贴顶被裁掉。
        const above = rect.top > 120
        setTip({ left, top: above ? rect.top - 8 : rect.bottom + 8, above })
      }
      const hide = () => setTip(null)

      return h('span', {
        className: 'rl-help',
        ref,
        tabIndex: 0,
        role: 'button',
        'aria-label': text,
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
      },
        '?',
        tip
          ? h('span', {
              className: 'rl-tooltip',
              style: {
                left: tip.left + 'px',
                top: tip.top + 'px',
                transform: tip.above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
              },
            }, text)
          : null,
      )
    }

    /** 单行设置项：左标题（带问号提示），右控件。 */
    function Row({ title, desc, children }) {
      return h('div', { className: 'rl-row' },
        h('div', { className: 'rl-row-main' },
          h('div', { className: 'rl-row-title' }, title, desc ? h(HelpTip, { text: desc }) : null),
        ),
        h('div', { className: 'rl-row-control' }, children),
      )
    }

    /** iOS 风格开关。 */
    function Switch({ checked, onChange, disabled }) {
      return h('button', {
        type: 'button',
        className: 'rl-switch',
        'data-on': checked ? 'true' : 'false',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        disabled: !!disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
      }, h('span', { className: 'rl-switch-knob' }))
    }

    /** 数字输入框。直接返回输入框 + 单位，由外层 .rl-row-control 统一排布。 */
    function NumberField({ value, min, max, step, onChange, disabled, unit }) {
      return h(React.Fragment, null,
        h('input', {
          type: 'number',
          className: 'rl-number',
          value,
          min,
          max,
          step,
          disabled: !!disabled,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        unit ? h('span', { className: 'rl-unit' }, unit) : null,
      )
    }

    /** 设置页主体。 */
    function RateLimitSettingsView({ dict }) {
      const [providers, setProviders] = useState([])
      const [providerId, setProviderId] = useState('')
      const [loadingProviders, setLoadingProviders] = useState(false)
      const [providerError, setProviderError] = useState('')
      const [form, setForm] = useState(DEFAULT_FORM)
      const [suggestion, setSuggestion] = useState(null)
      const [monitor, setMonitor] = useState(null)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [adding, setAdding] = useState(false)
      const [newId, setNewId] = useState('')
      const [newName, setNewName] = useState('')

      const showStatus = useCallback((message, kind) => {
        setStatus({ message, kind: kind || 'info' })
        if (kind !== 'error') {
          window.setTimeout(
            () => setStatus((cur) => (cur && cur.message === message ? null : cur)),
            4200,
          )
        }
      }, [])

      /** 调服务端 RPC。返回 { ok, value, error }，错误不抛进渲染。 */
      const call = useCallback((method, ...args) => {
        if (typeof fetch !== 'function') {
          return Promise.resolve({ ok: false, error: 'fetch unavailable' })
        }
        return fetch(RPC_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args }),
        })
          .then((res) => res
            .json()
            .catch(() => ({ ok: false, error: 'invalid JSON (HTTP ' + res.status + ')' }))
            .then((payload) => {
              if (payload && payload.ok) return { ok: true, value: payload.value }
              return { ok: false, error: (payload && payload.error) || ('HTTP ' + res.status) }
            }))
          .catch((error) => ({ ok: false, error: error.message || String(error) }))
      }, [])

      /**
       * 加载 provider 列表。
       * 由插件服务端提供：它扫描 DSH 的 cordis 配置得到全部已配置 provider，
       * 再叠加手动新增（__customProviders）、减去手动移除（__removedProviders）。
       */
      const loadProviders = useCallback(() => {
        setLoadingProviders(true)
        setProviderError('')

        const applyList = (list, rpcResult) => {
          setLoadingProviders(false)
          setProviders(list)
          if (list.length > 0) {
            // 当前选中的 provider 若已被移除，自动落到第一项
            setProviderId((current) => (list.some((p) => p.id === current) ? current : list[0].id))
          } else if (rpcResult && !rpcResult.ok) {
            setProviderError(rpcResult.error || 'unknown error')
          }
        }

        // 服务端是本插件的权威列表：它扫描 DSH 配置得到全部已配置 provider，
        // 再叠加手动新增、减去手动移除，因此增删能立即反映。
        return call('getProviders').then((result) => {
          const list = result.ok && Array.isArray(result.value) ? result.value : []
          applyList(list, result)
        })
      }, [call])

      /** 加载某 provider 的设置。 */
      const loadSettings = useCallback((id) => {
        if (!id) return Promise.resolve()
        return call('getSettings', id).then((result) => {
          if (!result.ok || !result.value) return
          setForm(toForm(result.value))
          setSuggestion(result.value.historySuggestion || null)
        })
      }, [call])

      /** 刷新监控数据。 */
      const refreshMonitor = useCallback((id) => {
        if (!id) return Promise.resolve()
        return call('getMonitorData', id).then((result) => {
          if (result.ok && result.value) setMonitor(result.value)
        })
      }, [call])

      // 首次挂载：加载 provider 列表。
      useEffect(() => {
        loadProviders()
      }, [loadProviders])

      // provider 变化：加载设置 + 启动监控轮询。
      useEffect(() => {
        if (!providerId) return
        loadSettings(providerId)
        refreshMonitor(providerId)
        const timer = window.setInterval(() => refreshMonitor(providerId), POLL_MS)
        return () => window.clearInterval(timer)
      }, [providerId, loadSettings, refreshMonitor])

      const patch = useCallback((next) => setForm((prev) => ({ ...prev, ...next })), [])

      const save = useCallback(() => {
        if (!providerId) return
        setBusy('save')
        call('saveSettings', providerId, form).then((result) => {
          setBusy('')
          if (result.ok && result.value && result.value.success) {
            showStatus(dict.saved, 'success')
            refreshMonitor(providerId)
          } else {
            showStatus(dict.saveFailed + '：' + (result.error || 'unknown'), 'error')
          }
        })
      }, [providerId, form, call, dict, showStatus, refreshMonitor])

      const resetToDefault = useCallback(() => {
        if (!providerId || !window.confirm(dict.confirmReset)) return
        const presets = {
          nvidia: { rpm: 40, tpm: 0, rpd: 10000, backoffStrategy: 'auto', fixedBackoffSeconds: 15, applyToFreeModelsOnly: true },
          agnes: { rpm: 20, tpm: 40000, rpd: 0, backoffStrategy: 'auto', fixedBackoffSeconds: 60, applyToFreeModelsOnly: true },
          default: { rpm: 60, tpm: 0, rpd: 0, backoffStrategy: 'auto', fixedBackoffSeconds: 60, applyToFreeModelsOnly: true },
        }
        const preset = presets[providerId] || presets.default
        const next = { ...form, ...preset, priority: 'default_preset' }
        setForm(next)
        setBusy('reset')
        call('saveSettings', providerId, next).then((result) => {
          setBusy('')
          if (result.ok && result.value && result.value.success) showStatus(dict.resetDone, 'success')
          else showStatus(dict.resetFailed + '：' + (result.error || 'unknown'), 'error')
          loadSettings(providerId)
        })
      }, [providerId, form, call, dict, showStatus, loadSettings])

      const applySuggestion = useCallback(() => {
        if (!providerId) return
        setBusy('apply')
        call('applySuggestion', providerId).then((result) => {
          setBusy('')
          if (result.ok && result.value && result.value.success && result.value.suggestion) {
            const s = result.value.suggestion
            setForm((prev) => ({
              ...prev,
              rpm: s.suggestedSafeRpm,
              tpm: s.suggestedSafeTpm,
              priority: 'history_calibrated',
            }))
            showStatus(dict.suggestionApplied, 'success')
            loadSettings(providerId)
          } else if (!result.ok) {
            showStatus(dict.applyFailed + '：' + result.error, 'error')
          }
        })
      }, [providerId, call, dict, showStatus, loadSettings])

      const clearHistory = useCallback(() => {
        if (!providerId || !window.confirm(dict.confirmClear)) return
        setBusy('clear')
        call('clearHistory', providerId).then((result) => {
          setBusy('')
          if (result.ok) {
            setSuggestion(null)
            showStatus(dict.historyCleared, 'success')
          } else {
            showStatus(dict.clearFailed + '：' + result.error, 'error')
          }
        })
      }, [providerId, call, dict, showStatus])

      const runProbe = useCallback(() => {
        if (!providerId) return
        setBusy('probe')
        call('runProbe', providerId).then((result) => {
          setBusy('')
          if (result.ok) showStatus(dict.probeStarted, 'info')
          else showStatus(dict.probeFailed + '：' + result.error, 'error')
        })
      }, [providerId, call, dict, showStatus])

      /** 新增自定义 provider。 */
      const submitAdd = useCallback(() => {
        const id = newId.trim().toLowerCase()
        if (!id) {
          showStatus(dict.addFailed + '：provider id 不能为空', 'error')
          return
        }
        setBusy('add')
        call('addProvider', { id, displayName: newName.trim() || id }).then((result) => {
          setBusy('')
          const payload = result.ok ? (result.value || {}) : {}
          if (result.ok && payload.success) {
            setAdding(false)
            setNewId('')
            setNewName('')
            showStatus(dict.providerAdded, 'success')
            loadProviders().then(() => setProviderId(id))
          } else {
            const reason = payload.error || result.error || 'unknown'
            showStatus(dict.addFailed + '：' + reason, 'error')
          }
        })
      }, [newId, newName, call, dict, showStatus, loadProviders])

      /** 移除当前 provider 的限速配置。 */
      const removeCurrent = useCallback(() => {
        if (!providerId) return
        if (!window.confirm(dict.confirmRemove.replace('{id}', providerId))) return
        setBusy('remove')
        call('removeProvider', providerId).then((result) => {
          setBusy('')
          const payload = result.ok ? (result.value || {}) : {}
          if (result.ok && payload.success) {
            showStatus(dict.providerRemoved, 'success')
            setProviderId('')
            setMonitor(null)
            setSuggestion(null)
            setForm(DEFAULT_FORM)
            loadProviders()
          } else {
            const reason = payload.error || result.error || 'unknown'
            showStatus(dict.removeFailed + '：' + reason, 'error')
          }
        })
      }, [providerId, call, dict, showStatus, loadProviders])

      const ratio = (used, limit) => (limit > 0 ? Math.min(100, (used / limit) * 100) : 0)
      const disabled = !form.enabled
      const priorityKey = PRIORITY_LABEL[form.priority] || 'priorityDefault'

      // 服务商选择行
      const providerOptions = providers.length > 0
        ? providers.map((p) => h('option', { key: p.id, value: p.id }, p.displayName + '（' + p.id + '）'))
        : [h('option', { key: '__empty', value: '' }, loadingProviders ? dict.loading : dict.noProviders)]

      const providerControl = providerError
        ? h('div', { className: 'rl-provider-actions' },
            h('span', { className: 'rl-provider-error', title: providerError }, dict.providersFailed + '：' + providerError),
            h('button', { type: 'button', className: 'rl-btn', onClick: loadProviders }, dict.retry),
          )
        : h('div', { className: 'rl-provider-actions' },
            h('select', {
              className: 'rl-select',
              value: providerId,
              disabled: loadingProviders || providers.length === 0,
              onChange: (event) => setProviderId(event.target.value),
            }, providerOptions),
            h('button', {
              type: 'button', className: 'rl-btn',
              disabled: loadingProviders || adding, onClick: () => setAdding(true),
            }, dict.addProvider),
            h('button', {
              type: 'button', className: 'rl-btn', 'data-variant': 'danger',
              disabled: !!busy || !providerId, onClick: removeCurrent,
            }, busy === 'remove' ? dict.removing : dict.removeProvider),
          )

      // 服务商卡片：标题（带问号提示）与操作同一行。
      const providerRow = h('div', { className: 'rl-row-card' },
        h('div', { className: 'rl-provider-head' },
          h('div', { className: 'rl-row-title' }, dict.provider, h(HelpTip, { text: dict.providerDesc })),
          providerControl,
        ),
      )

      // 新增 provider 的内联表单
      const addForm = adding
        ? h('div', { className: 'rl-add-form' },
            h('input', {
              className: 'rl-input',
              placeholder: dict.newProviderId,
              value: newId,
              onChange: (event) => setNewId(event.target.value),
            }),
            h('input', {
              className: 'rl-input',
              placeholder: dict.newProviderName,
              value: newName,
              onChange: (event) => setNewName(event.target.value),
            }),
            h('button', {
              type: 'button', className: 'rl-btn', 'data-variant': 'primary',
              disabled: busy === 'add', onClick: submitAdd,
            }, busy === 'add' ? dict.adding : dict.confirm),
            h('button', {
              type: 'button', className: 'rl-btn',
              onClick: () => { setAdding(false); setNewId(''); setNewName('') },
            }, dict.cancel),
          )
        : null

      // 历史预警横幅
      const banner = suggestion && suggestion.hasHistory
        ? h('div', { className: 'rl-banner' },
            h(WarnIcon, { className: 'rl-banner-icon' }),
            h('div', { className: 'rl-banner-body' },
              h('div', { className: 'rl-banner-title' }, dict.historyTitle),
              h('div', { className: 'rl-banner-text' },
                dict.historyBody
                  .replace('{rpm}', String(suggestion.triggeredAtRpm))
                  .replace('{tpm}', Number(suggestion.triggeredAtTpm || 0).toLocaleString())
                  .replace('{model}', suggestion.model || dict.unknownModel)
                  .replace('{safeRpm}', suggestion.suggestedSafeRpm == null ? '-' : String(suggestion.suggestedSafeRpm))
                  .replace('{safeTpm}', Number(suggestion.suggestedSafeTpm || 0).toLocaleString()),
              ),
              h('div', { className: 'rl-banner-actions' },
                h('button', {
                  type: 'button', className: 'rl-btn', 'data-variant': 'primary',
                  disabled: busy === 'apply', onClick: applySuggestion,
                }, busy === 'apply' ? dict.applying : dict.applySuggestion),
                h('button', {
                  type: 'button', className: 'rl-btn', onClick: () => setSuggestion(null),
                }, dict.dismiss),
              ),
            ),
          )
        : null

      // RPD 告警横幅（95% 阈值）
      const rpdBanner = monitor && monitor.dailyQuotaWarning && monitor.dailyLimit > 0
        ? h('div', { className: 'rl-banner' },
            h(WarnIcon, { className: 'rl-banner-icon' }),
            h('div', { className: 'rl-banner-body' },
              h('div', { className: 'rl-banner-title' }, dict.rpdWarningTitle),
              h('div', { className: 'rl-banner-text' },
                dict.rpdWarningBody
                  .replace('{used}', String(monitor.dailyUsed))
                  .replace('{limit}', String(monitor.dailyLimit))
                  .replace('{percent}', Math.round((monitor.dailyUsed / monitor.dailyLimit) * 100)),
              ),
            ),
          )
        : null

      // 限速参数
      const limitRows = [
        h(Row, { key: 'rpm', title: dict.rpm, desc: dict.rpmDesc },
          h(NumberField, {
            value: form.rpm, min: 1, max: 10000, step: 1, disabled,
            unit: dict.rpmUnit,
            onChange: (v) => patch({ rpm: Math.min(10000, Math.max(1, v || 1)) }),
          }),
        ),
        h(Row, { key: 'tpm', title: dict.tpm, desc: dict.tpmDesc },
          h(NumberField, {
            value: form.tpm, min: 0, step: 1000, disabled,
            unit: dict.tpmUnit,
            onChange: (v) => patch({ tpm: Math.max(0, v || 0) }),
          }),
        ),
      ]

      if (providerId === 'nvidia') {
        limitRows.push(
          h(Row, { key: 'rpd', title: dict.rpd, desc: dict.rpdDesc },
            h(NumberField, {
              value: form.rpd, min: 0, step: 100, disabled,
              unit: dict.rpdUnit,
              onChange: (v) => patch({ rpd: Math.max(0, v || 0) }),
            }),
          ),
        )
      }

      // 退避策略
      const backoffRow = h(Row, { key: 'backoff', title: dict.backoff, desc: dict.backoffDesc },
        h('select', {
          className: 'rl-select',
          value: form.backoffStrategy,
          disabled,
          onChange: (event) => patch({ backoffStrategy: event.target.value }),
        },
          h('option', { value: 'auto' }, dict.backoffAuto),
          h('option', { value: 'fixed' }, dict.backoffFixed),
          h('option', { value: 'exponential' }, dict.backoffExp),
        ),
      )

      const fixedRow = form.backoffStrategy === 'fixed' && form.enabled
        ? h(Row, { key: 'fixed', title: dict.fixedSeconds, desc: dict.fixedSecondsDesc },
            h(NumberField, {
              value: form.fixedBackoffSeconds, min: 1, max: 300, step: 1,
              unit: dict.secondsUnit,
              onChange: (v) => patch({ fixedBackoffSeconds: Math.min(300, Math.max(1, v || 1)) }),
            }),
          )
        : null

      // 开关行
      const enabledRow = h(Row, { key: 'enabled', title: dict.enabled, desc: dict.enabledDesc },
        h(Switch, { checked: form.enabled, onChange: (v) => patch({ enabled: v }) }),
      )

      const freeOnlyRow = h(Row, { key: 'freeOnly', title: dict.freeOnly, desc: dict.freeOnlyDesc },
        h(Switch, { checked: form.applyToFreeModelsOnly, disabled, onChange: (v) => patch({ applyToFreeModelsOnly: v }) }),
      )

      // 优先级行
      const priorityRow = h(Row, { key: 'priority', title: dict.priority, desc: dict.priorityDesc },
        h('span', { className: 'rl-badge', 'data-priority': form.priority }, dict[priorityKey]),
      )

      // 监控
      const monitorBlock = monitor
        ? h('div', { className: 'rl-monitor' },
            h('div', { className: 'rl-group-title' }, dict.monitor),
            h('div', { className: 'rl-monitor-grid' },
              h('div', { className: 'rl-monitor-item' },
                h('span', { className: 'rl-monitor-label' }, dict.queueLength),
                h('span', { className: 'rl-monitor-value' }, String(monitor.queueLength == null ? 0 : monitor.queueLength)),
              ),
              h('div', { className: 'rl-monitor-item' },
                h('span', { className: 'rl-monitor-label' }, dict.rpmUsed),
                h('span', { className: 'rl-monitor-value' }, monitor.rpm + ' / ' + monitor.rpmLimit),
                h('div', { className: 'rl-monitor-bar' },
                  h('div', { className: 'rl-monitor-fill', style: { width: ratio(monitor.rpm, monitor.rpmLimit) + '%' } }),
                ),
              ),
              h('div', { className: 'rl-monitor-item' },
                h('span', { className: 'rl-monitor-label' }, dict.tpmUsed),
                h('span', { className: 'rl-monitor-value' },
                  Number(monitor.tpm || 0).toLocaleString() + ' / ' + Number(monitor.tpmLimit || 0).toLocaleString()),
                monitor.tpmLimit > 0
                  ? h('div', { className: 'rl-monitor-bar' },
                      h('div', { className: 'rl-monitor-fill', style: { width: ratio(monitor.tpm, monitor.tpmLimit) + '%' } }),
                    )
                  : null,
              ),
              monitor.dailyLimit > 0
                ? h('div', { className: 'rl-monitor-item' },
                    h('span', { className: 'rl-monitor-label' }, dict.rpdUsed),
                    h('span', { className: 'rl-monitor-value' }, monitor.dailyUsed + ' / ' + monitor.dailyLimit),
                    h('div', { className: 'rl-monitor-bar' },
                      h('div', { className: 'rl-monitor-fill', style: { width: ratio(monitor.dailyUsed, monitor.dailyLimit) + '%' } }),
                    ),
                  )
                : null,
            ),
          )
        : null

      // 底部操作
      const footer = h('div', { className: 'rl-footer' },
        h('button', {
          type: 'button', className: 'rl-btn', 'data-variant': 'danger',
          disabled: busy === 'clear' || !providerId, onClick: clearHistory,
        }, busy === 'clear' ? dict.clearing : dict.clear),
        h('button', {
          type: 'button', className: 'rl-btn',
          disabled: busy === 'probe' || !providerId, onClick: runProbe,
        }, busy === 'probe' ? dict.probing : dict.probe),
        h('button', {
          type: 'button', className: 'rl-btn',
          disabled: busy === 'reset' || !providerId, onClick: resetToDefault,
        }, dict.reset),
        h('button', {
          type: 'button', className: 'rl-btn', 'data-variant': 'primary',
          disabled: busy === 'save' || !providerId, onClick: save,
        }, busy === 'save' ? dict.saving : dict.save),
      )

      return h('div', { className: 'rate-limit-settings-view' },
        providerRow,
        addForm,
        banner,
        rpdBanner,
        enabledRow,
        h('div', { className: 'rl-group-title' }, dict.sectionLimits),
        limitRows,
        h('div', { className: 'rl-group-title' }, dict.sectionBackoff),
        backoffRow,
        fixedRow,
        freeOnlyRow,
        priorityRow,
        monitorBlock,
        footer,
        status
          ? h('div', { className: 'rl-status', 'data-kind': status.kind }, status.message)
          : null,
      )
    }

    function apply(ctx) {
      const dict = pickDict()

      // 样式：随插件激活插入一次，随 fiber 销毁移除。
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-smart-ratelimit'
      style.textContent = CSS
      document.head.append(style)
      ctx.effect(() => () => style.remove())

      // 注册到设置页左侧菜单。order 100 保证排在内置项（≤15）与彩虹皮肤（90）之后。
      ctx.effect(() =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: PANEL_ID,
              order: SECTION_ORDER,
              label: () => dict.nav,
            },
            () => h(RateLimitSettingsView, { dict }),
          ),
        ),
      )
    }

    const exports = { apply, inject: ['slots'] }
    return exports
  },
})
