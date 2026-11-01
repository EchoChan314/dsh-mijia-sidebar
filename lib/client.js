// dsh-mijia-sidebar — browser half.
//
// Registers a sidebar rail icon (sidebar.panellist) and a central panel
// (main) addressed by the same id, so clicking the icon opens the panel.
// All device data comes from this package's own host half over the /mijia
// RPC channel — no model round-trip anywhere.
//
// Per device: expand fetches the spec (props) and ALL readable property
// states in one batched cloud call (host action "state"), so every control
// shows its current value without per-property read buttons.
//
// Hand-written classic-script bundle; no build step. Styling uses only
// --dsw-alias-* theme tokens; no Harness client package is imported.

window.__ModuleLoader__.load({
  id: 'dsh-mijia-sidebar',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    // ---------------------------------------------------- localized text --

    const DICT = {
      panelName: ['米家控制', 'Mijia Control'],
      refresh: ['刷新', 'Refresh'],
      refreshing: ['刷新中…', 'Refreshing…'],
      devicesTitle: ['设备', 'Devices'],
      scenesTitle: ['场景', 'Scenes'],
      actionsTitle: ['动作', 'Actions'],
      groupControl: ['控制', 'Controls'],
      groupState: ['状态', 'Status'],
      noDevices: ['没有可用设备（检查米家登录凭证 ~/.config/mijia-api/auth.json）', 'No devices (check ~/.config/mijia-api/auth.json)'],
      noProps: ['该设备没有属性', 'No properties'],
      on: ['开', 'On'],
      off: ['关', 'Off'],
      applyValue: ['设置', 'Set'],
      refreshState: ['刷新状态', 'Refresh state'],
      hideDevice: ['隐藏此设备（可在底部恢复）', 'Hide this device (restore below)'],
      hiddenTitle: ['已隐藏设备', 'Hidden devices'],
      updated: ['更新于', 'Updated'],
      // First-run guides. The host half classifies every failure into one of
      // six codes; the four setup codes get these steps instead of raw text.
      // Each step is a command the user can copy as-is.
      guidePythonMissingTitle: ['未找到 Python 解释器', 'No Python interpreter found'],
      guidePythonMissingStep1: [
        '安装 Python 3.10 或更新版本：https://www.python.org/downloads/',
        'Install Python 3.10 or newer: https://www.python.org/downloads/',
      ],
      guidePythonMissingStep2: [
        '确认 python3 / python 在 PATH 中，然后重启 DSH',
        'Make sure python3 / python is on PATH, then restart DSH',
      ],
      guidePythonMissingStep3: [
        '或设置环境变量 MIJIA_PYTHON 指向解释器的完整路径',
        'Or set MIJIA_PYTHON to the full path of the interpreter',
      ],
      guideDependencyMissingTitle: ['缺少 mijiaAPI 依赖', 'mijiaAPI dependency missing'],
      guideDependencyMissingStep1: [
        '安装依赖：python -m pip install mijiaAPI',
        'Install it: python -m pip install mijiaAPI',
      ],
      guideDependencyMissingStep2: ['重启 DSH 后点「刷新」', 'Restart DSH, then hit Refresh'],
      guideAuthMissingTitle: ['尚未登录米家账号', 'Not signed in to Mijia'],
      guideAuthMissingStep1: ['登录：python -m mijiaAPI login', 'Sign in: python -m mijiaAPI login'],
      guideAuthMissingStep2: [
        '用米家 APP 扫描终端里的二维码',
        'Scan the QR code printed in the terminal with the Mijia app',
      ],
      guideAuthMissingStep3: ['登录后点「刷新」', 'Then hit Refresh'],
      guideAuthExpiredTitle: ['米家登录已过期', 'Mijia sign-in expired'],
      guideAuthExpiredStep1: [
        '重新登录：python -m mijiaAPI login',
        'Sign in again: python -m mijiaAPI login',
      ],
      guideAuthExpiredStep2: [
        '用米家 APP 重新扫码，然后点「刷新」',
        'Scan the QR code again with the Mijia app, then hit Refresh',
      ],
      guideCredentialFile: ['凭证文件', 'Credentials'],
    }
    const LANG =
      String((typeof navigator !== 'undefined' && navigator.language) || 'zh').toLowerCase().indexOf('zh') === 0
        ? 0
        : 1
    const tr = (key) => (DICT[key] ? DICT[key][LANG] : key)

    // ------------------------------------------------------------ styles --

    const CSS = `
.dsh-mijia-root{height:100%;overflow-y:auto;box-sizing:border-box;padding:20px 24px 40px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dsh-mijia-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.dsh-mijia-title{font-size:16px;font-weight:600;flex:1}
.dsh-mijia-meta{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-mijia-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer}
.dsh-mijia-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dsh-mijia-btn:disabled{opacity:.55;cursor:default}
.dsh-mijia-error{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:6px;padding:8px 10px;margin-bottom:12px;white-space:pre-wrap;word-break:break-word}
.dsh-mijia-sectionTitle{color:var(--dsw-alias-label-secondary);font-size:12px;margin:10px 0 6px}
.dsh-mijia-loading{color:var(--dsw-alias-label-secondary);padding:8px 0}
.dsh-mijia-scenes{display:flex;flex-wrap:wrap;gap:8px}
.dsh-mijia-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;align-items:stretch}
.dsh-mijia-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-mijia-card.wide{grid-column:1/-1}
.dsh-mijia-tile{display:flex;align-items:center;gap:10px;width:100%;min-height:60px;padding:10px 12px;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;box-sizing:border-box}
.dsh-mijia-tile:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-mijia-glyph{width:38px;height:38px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box}
.dsh-mijia-tile:hover .dsh-mijia-glyph,.dsh-mijia-deviceHeadBtn:hover .dsh-mijia-glyph{color:var(--dsw-alias-brand-primary)}
.dsh-mijia-tileText{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsh-mijia-glyphImg{width:26px;height:26px;object-fit:contain}
.dsh-mijia-deviceHead{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px}
.dsh-mijia-deviceHeadBtn{display:flex;align-items:center;gap:8px;flex:1;min-width:0;background:none;border:0;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer;padding:2px 0}
.dsh-mijia-deviceHeadBtn:hover .dsh-mijia-deviceName{color:var(--dsw-alias-brand-primary)}
.dsh-mijia-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dsh-mijia-dot.on{background:var(--dsw-alias-state-success-primary)}
.dsh-mijia-deviceName{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-mijia-deviceModel{color:var(--dsw-alias-label-secondary);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mijia-chevron{color:var(--dsw-alias-label-secondary);flex:none}
.dsh-mijia-miniBtn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;width:26px;height:24px;font-size:13px;line-height:1;cursor:pointer;flex:none}
.dsh-mijia-miniBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dsh-mijia-miniBtn:disabled{opacity:.5;cursor:default}
.dsh-mijia-deviceBody{border-top:1px solid var(--dsw-alias-border-l1);padding:2px 12px 10px}
.dsh-mijia-groupTitle{color:var(--dsw-alias-label-secondary);font-size:11px;letter-spacing:.05em;margin:10px 0 2px}
.dsh-mijia-propRow{display:flex;align-items:center;gap:12px;min-height:38px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-mijia-propRow:last-child{border-bottom:0}
.dsh-mijia-propLabel{flex:0 0 190px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:default}
.dsh-mijia-propControls{flex:1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-mijia-chip{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
.dsh-mijia-chip:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dsh-mijia-chip:disabled{opacity:.55;cursor:default}
.dsh-mijia-chip.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dsh-mijia-switch{position:relative;appearance:none;width:36px;height:20px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;margin:0;flex:none}
.dsh-mijia-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsh-mijia-switch:disabled{opacity:.55;cursor:default}
.dsh-mijia-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s ease}
.dsh-mijia-switch[aria-checked="true"]::after{left:18px}
.dsh-mijia-slider{flex:1;min-width:120px;max-width:240px;height:20px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-mijia-input{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 8px;font-size:12px;width:110px}
.dsh-mijia-value{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:30px;text-align:right}
.dsh-mijia-readonly{color:var(--dsw-alias-label-secondary)}
.dsh-mijia-guide{padding:12px 14px;margin-bottom:12px}
.dsh-mijia-guideTitle{font-weight:600;margin-bottom:6px}
.dsh-mijia-guideSteps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px}
.dsh-mijia-guideHint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:8px;word-break:break-all}
.dsh-mijia-guide .dsh-mijia-btn{margin-top:10px}
`

    const stateKey = (did, prop) => `${did}|${prop}`
    const EMPTY_SPEC = { properties: [], actions: [] }

    // ------------------------------------------------------- error guides --

    // Known failure codes → the DICT keys that explain how to fix them.
    // Anything else keeps the host's own message, unedited.
    const GUIDE_KEYS = {
      'mijia/python-missing': {
        title: 'guidePythonMissingTitle',
        steps: ['guidePythonMissingStep1', 'guidePythonMissingStep2', 'guidePythonMissingStep3'],
        credentials: false,
      },
      'mijia/dependency-missing': {
        title: 'guideDependencyMissingTitle',
        steps: ['guideDependencyMissingStep1', 'guideDependencyMissingStep2'],
        credentials: false,
      },
      'mijia/auth-missing': {
        title: 'guideAuthMissingTitle',
        steps: ['guideAuthMissingStep1', 'guideAuthMissingStep2', 'guideAuthMissingStep3'],
        credentials: true,
      },
      'mijia/auth-expired': {
        title: 'guideAuthExpiredTitle',
        steps: ['guideAuthExpiredStep1', 'guideAuthExpiredStep2'],
        credentials: true,
      },
    }

    // The panel keeps errors as {code, message, details} rather than a string,
    // because a known code renders as a guide card and an unknown one does not.
    function toFailure(error, fallback) {
      const source = error || {}
      const failure = new Error(String(source.message || fallback || 'mijia RPC 调用失败'))
      failure.code = typeof source.code === 'string' && source.code ? source.code : 'mijia/error'
      failure.details = source.details && typeof source.details === 'object' ? source.details : {}
      return failure
    }

    function ErrorGuide({ error, onRetry, busy }) {
      const guide = GUIDE_KEYS[error.code]
      if (!guide) return h('div', { className: 'dsh-mijia-error' }, error.message)
      const authPath = guide.credentials ? error.details.auth_path : ''
      return h(
        'div',
        { className: 'dsh-mijia-card dsh-mijia-guide' },
        h('div', { className: 'dsh-mijia-guideTitle' }, tr(guide.title)),
        h(
          'ol',
          { className: 'dsh-mijia-guideSteps' },
          guide.steps.map((key) => h('li', { key }, tr(key))),
        ),
        authPath && h('div', { className: 'dsh-mijia-guideHint' }, `${tr('guideCredentialFile')}: ${authPath}`),
        h(
          'button',
          { className: 'dsh-mijia-btn', onClick: onRetry, disabled: busy },
          busy ? tr('refreshing') : tr('refresh'),
        ),
      )
    }

    // ------------------------------------------------------ device glyphs --

    // The mijia cloud payload carries no device icons, so each category gets
    // a small built-in stroke glyph, picked from the model string.
    const ICON_PATHS = {
      fan: [
        'M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2',
        'M9.6 4.6A2 2 0 1 1 11 8H2',
        'M12.6 19.4A2 2 0 1 0 14 16H2',
      ],
      cooker: [
        'M5 11h14v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6z',
        'M3.5 11h17',
        'M12 8V6',
        'M12 5h.01',
      ],
      router: [
        'M4 13.5h16a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18v-3a1.5 1.5 0 0 1 1.5-1.5z',
        'M12 13.5V7',
        'M9.5 7h5',
        'M17.2 17.2h.01',
        'M7 17.2h.01',
      ],
      light: [
        'M12 3a6 6 0 0 0-4 10.5c.9.8 1.4 1.6 1.6 2.5h4.8c.2-.9.7-1.7 1.6-2.5A6 6 0 0 0 12 3z',
        'M9.5 19h5',
        'M10.5 21.5h3',
      ],
      plug: [
        'M9 3v5',
        'M15 3v5',
        'M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8z',
        'M12 17v4',
      ],
      airconditioner: [
        'M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5z',
        'M6 10.5h12',
        'M7 16c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0',
      ],
      sensor: [
        'M5 12.5a10 10 0 0 1 14 0',
        'M8.5 15.5a5 5 0 0 1 7 0',
        'M12 18.8h.01',
      ],
      house: [
        'M4 11.4 12 4.8l8 6.6',
        'M6.3 10.6V19a1 1 0 0 0 1 1h9.4a1 1 0 0 0 1-1v-8.4',
        'M12 14.8h.01',
      ],
    }

    function categoryOf(model) {
      const m = String(model || '').toLowerCase()
      if (m.includes('fan')) return 'fan'
      if (m.includes('cooker') || m.includes('pot') || m.includes('rice')) return 'cooker'
      if (m.includes('router') || m.includes('wifi') || m.includes('gateway')) return 'router'
      if (m.includes('light') || m.includes('lamp') || m.includes('bulb') || m.includes('led')) return 'light'
      if (m.includes('plug') || m.includes('outlet') || m.includes('socket')) return 'plug'
      if (m.includes('aircondition') || m.includes('air-condition') || m.includes('ac.') || m.includes('airer')) return 'airconditioner'
      if (m.includes('sensor') || m.includes('detector') || m.includes('thermo') || m.includes('hygro')) return 'sensor'
      return 'house'
    }

    function DeviceGlyph({ device, size }) {
      const s = size || 24
      if (device.icon) {
        return h('img', {
          className: 'dsh-mijia-glyphImg',
          src: device.icon,
          width: s - 4,
          height: s - 4,
          alt: '',
        })
      }
      const paths = ICON_PATHS[categoryOf(device.model)] || ICON_PATHS.house
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        paths.map((d, index) =>
          h('path', {
            key: index,
            d,
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      )
    }

    // -------------------------------------------------------- panel icon --

    function PanelIcon({ size, active }) {
      const s = size || 18
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
        },
        h('path', {
          d: 'M4 11.4 12 4.8l8 6.6',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M6.3 10.6V19a1 1 0 0 0 1 1h9.4a1 1 0 0 0 1-1v-8.4',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 12, cy: 14.8, r: 2.1, fill: 'currentColor' }),
      )
    }

    // ----------------------------------------------------------- controls --

    function BoolControl({ device, prop, stateText, busy, onSet }) {
      const boolState = stateText == null ? null : stateText.toLowerCase() === 'true'
      return [
        h('button', {
          key: 'switch',
          className: 'dsh-mijia-switch',
          role: 'switch',
          'aria-checked': boolState === true,
          disabled: busy,
          title: tr('on') + ' / ' + tr('off'),
          onClick: () => onSet(device, prop, boolState === true ? 'False' : 'True'),
        }),
        h('span', { key: 'v', className: 'dsh-mijia-value' }, boolState == null ? '—' : boolState ? tr('on') : tr('off')),
      ]
    }

    function EnumControl({ device, prop, stateText, busy, onSet }) {
      return (prop['value-list'] || []).map((option, index) =>
        h(
          'button',
          {
            key: 'opt' + index,
            className: 'dsh-mijia-chip' + (stateText != null && stateText === String(option.value) ? ' on' : ''),
            disabled: busy,
            title: String(option.value),
            onClick: () => onSet(device, prop, String(option.value)),
          },
          option.description != null ? option.description : String(option.value),
        ),
      )
    }

    function RangeControl({ device, prop, stateText, busy, draft, onDraft, onSet }) {
      const range = Array.isArray(prop.range) && prop.range.length >= 2 ? prop.range : null
      if (!range) return null
      const numericState = stateText != null && isFinite(Number(stateText)) ? Number(stateText) : null
      const shown = draft != null && draft !== '' ? Number(draft) : numericState != null ? numericState : range[0]
      const step = prop.range.length > 2 && prop.range[2] ? prop.range[2] : prop.type === 'float' ? 0.1 : 1
      return [
        h('input', {
          key: 'slider',
          className: 'dsh-mijia-slider',
          type: 'range',
          min: range[0],
          max: range[1],
          step,
          value: isFinite(shown) ? shown : range[0],
          disabled: busy,
          onChange: (event) => onDraft(stateKey(device.did, prop.name), event.target.value),
        }),
        h('span', {
          key: 'v',
          className: 'dsh-mijia-value',
        }, draft != null && draft !== '' ? String(draft) : stateText != null ? String(stateText) : '—'),
        h(
          'button',
          {
            key: 'set',
            className: 'dsh-mijia-chip',
            disabled: busy || draft == null || draft === '',
            onClick: () => onSet(device, prop, draft),
          },
          tr('applyValue'),
        ),
      ]
    }

    function TextControl({ device, prop, busy, draft, onDraft, onSet }) {
      return [
        h('input', {
          key: 'input',
          className: 'dsh-mijia-input',
          type: 'text',
          value: draft != null ? draft : '',
          disabled: busy,
          onChange: (event) => onDraft(stateKey(device.did, prop.name), event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && draft != null && draft !== '') onSet(device, prop, draft)
          },
        }),
        h(
          'button',
          {
            key: 'set',
            className: 'dsh-mijia-chip',
            disabled: busy || draft == null || draft === '',
            onClick: () => onSet(device, prop, draft),
          },
          tr('applyValue'),
        ),
      ]
    }

    function PropRow({ device, prop, state, busy, draft, onDraft, onSet }) {
      const key = stateKey(device.did, prop.name)
      const writable = String(prop.rw || '').indexOf('w') >= 0
      const stateText = state === undefined || state === '' ? null : String(state)

      let displayValue = stateText
      if (displayValue !== null && Array.isArray(prop['value-list'])) {
        const hit = prop['value-list'].find((option) => String(option.value) === displayValue)
        if (hit && hit.description != null) displayValue = `${hit.description} (${displayValue})`
      }

      let controls
      if (!writable) {
        controls = [h('span', { key: 'ro', className: 'dsh-mijia-readonly' }, displayValue == null ? '—' : displayValue)]
      } else if (prop.type === 'bool') {
        controls = h(BoolControl, { device, prop, stateText, busy, onSet })
      } else if (Array.isArray(prop['value-list']) && prop['value-list'].length) {
        controls = h(EnumControl, { device, prop, stateText, busy, onSet })
      } else if (prop.type === 'uint' || prop.type === 'int' || prop.type === 'float') {
        controls = h(RangeControl, { device, prop, stateText, busy, draft, onDraft, onSet }) || [
          h('span', { key: 'none', className: 'dsh-mijia-readonly' }, '—'),
        ]
      } else {
        controls = h(TextControl, { device, prop, busy, draft, onDraft, onSet })
      }

      return h(
        'div',
        { className: 'dsh-mijia-propRow' },
        h('div', { className: 'dsh-mijia-propLabel', title: prop.name + ' · ' + prop.type + ' · ' + prop.rw }, prop.description || prop.name),
        h('div', { className: 'dsh-mijia-propControls' }, controls),
      )
    }

    // -------------------------------------------------------- device card --

    function DeviceCard({ device, open, spec, states, stateLoaded, busyKey, drafts, onToggle, onRefreshState, onHide, onSet, onDraft, onAction }) {
      const properties = (spec && spec.properties) || []
      const actions = (spec && spec.actions) || []
      const writable = properties.filter((p) => String(p.rw || '').indexOf('w') >= 0)
      const readonly = properties.filter((p) => String(p.rw || '').indexOf('w') < 0)

      const row = (prop) =>
        h(PropRow, {
          key: prop.name,
          device,
          prop,
          state: states[stateKey(device.did, prop.name)],
          busy: busyKey === stateKey(device.did, prop.name),
          draft: drafts[stateKey(device.did, prop.name)],
          onDraft,
          onSet,
        })

      if (!open) {
        return h(
          'div',
          { className: 'dsh-mijia-card' },
          h(
            'button',
            {
              className: 'dsh-mijia-tile',
              onClick: () => onToggle(device),
              'aria-expanded': false,
            },
            h('span', { className: 'dsh-mijia-glyph' }, h(DeviceGlyph, { device, size: 24 })),
            h(
              'span',
              { className: 'dsh-mijia-tileText' },
              h(
                'span',
                { className: 'dsh-mijia-deviceName', title: device.alias ? device.name : undefined },
                device.alias || device.name,
              ),
              h('span', { className: 'dsh-mijia-deviceModel' }, device.model || ''),
            ),
            h('span', { className: 'dsh-mijia-dot' + (device.online ? ' on' : ''), 'aria-hidden': true }),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsh-mijia-card wide' },
        h(
          'div',
          { className: 'dsh-mijia-deviceHead' },
          h(
            'button',
            {
              className: 'dsh-mijia-deviceHeadBtn',
              onClick: () => onToggle(device),
              'aria-expanded': true,
            },
            h('span', { className: 'dsh-mijia-glyph' }, h(DeviceGlyph, { device, size: 22 })),
            h(
              'span',
              { className: 'dsh-mijia-deviceName', title: device.alias ? device.name : undefined },
              device.alias || device.name,
            ),
            h('span', { className: 'dsh-mijia-deviceModel' }, device.model || ''),
            h('span', { className: 'dsh-mijia-chevron', 'aria-hidden': true }, '▾'),
          ),
          h('button', {
            className: 'dsh-mijia-miniBtn',
            title: tr('refreshState'),
            'aria-label': tr('refreshState'),
            disabled: busyKey === 'state|' + device.did,
            onClick: () => onRefreshState(device),
          }, '⟳'),
          h('button', {
            className: 'dsh-mijia-miniBtn',
            title: tr('hideDevice'),
            'aria-label': tr('hideDevice'),
            onClick: () => onHide(device),
          }, '✕'),
        ),
        h(
          'div',
          { className: 'dsh-mijia-deviceBody' },
          !spec && !stateLoaded && h('div', { className: 'dsh-mijia-loading' }, '…'),
          spec && properties.length === 0 && h('div', { className: 'dsh-mijia-loading' }, tr('noProps')),
          writable.length > 0 && h('div', { className: 'dsh-mijia-groupTitle' }, tr('groupControl')),
          writable.map(row),
          readonly.length > 0 && h('div', { className: 'dsh-mijia-groupTitle' }, tr('groupState')),
          readonly.map(row),
          actions.length > 0 && h('div', { className: 'dsh-mijia-groupTitle' }, tr('actionsTitle')),
          actions.map((act) =>
            h(
              'button',
              {
                key: act.name,
                className: 'dsh-mijia-chip',
                disabled: busyKey === 'action|' + act.name,
                onClick: () => onAction(device, act.name),
              },
              act.description || act.name,
            ),
          ),
        ),
      )
    }

    // --------------------------------------------------------------- panel --

    // Expand/collapse survives panel switches and DSH restarts (localStorage).
    const OPEN_KEY = 'dsh-mijia-sidebar.open'
    const loadOpenKey = () => {
      try {
        return window.localStorage.getItem(OPEN_KEY) || null
      } catch (e) {
        return null
      }
    }
    const saveOpenKey = (key) => {
      try {
        if (key) window.localStorage.setItem(OPEN_KEY, key)
        else window.localStorage.removeItem(OPEN_KEY)
      } catch (e) {
        // private mode: expansion just won't persist
      }
    }

    function MijiaPanel({ call }) {
      const [snap, setSnap] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)
      const [openKey, setOpenKeyState] = useState(loadOpenKey)
      const [specs, setSpecs] = useState({})
      const [states, setStates] = useState({})
      const [stateLoaded, setStateLoaded] = useState({})
      const [drafts, setDrafts] = useState({})
      const [busyKey, setBusyKey] = useState('')

      // Latest values for effects that must not re-run on every state update.
      const specsRef = useRef(specs)
      specsRef.current = specs
      const stateLoadedRef = useRef(stateLoaded)
      stateLoadedRef.current = stateLoaded

      const setOpenKey = useCallback((key) => {
        setOpenKeyState(key)
        saveOpenKey(key)
      }, [])

      // First paint uses the last known device list (memory or disk cache on
      // the host), then a second call swaps in a fresh one. Only a cold start
      // with no cache at all waits for python (~1s).
      const refresh = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const first = await call('snapshot')
          setSnap(first)
          if (first && first.stale) {
            call('snapshot', { refresh: true })
              .then((fresh) => setSnap(fresh))
              .catch((e) => setError(toFailure(e)))
          }
        } catch (e) {
          setError(toFailure(e))
        } finally {
          setLoading(false)
        }
      }, [call])
      useEffect(() => {
        refresh()
      }, [refresh])

      const mergeStates = useCallback((did, values) => {
        setStates((current) => {
          const next = { ...current }
          for (const [name, value] of Object.entries(values || {})) {
            next[stateKey(did, name)] = value == null ? '—' : String(value)
          }
          return next
        })
      }, [])

      // The host answers from its cache when it has one and marks the value
      // `stale`: controls render immediately and the fresh reading lands a
      // moment later. Only a device never seen before waits for python.
      // `force` skips the cache entirely — for the ⟳ button and for the
      // post-set reconcile, which must never judge a write by a cached read.
      const fetchState = useCallback(
        async (device, options) => {
          const payload = { did: device.did, spec_type: device.spec_type }
          if (options && options.force) payload.refresh = true
          const result = await call('state', payload)
          mergeStates(device.did, result.states)
          setStateLoaded((current) => ({ ...current, [device.did]: true }))
          if (result.stale) {
            call('state', { ...payload, refresh: true })
              .then((fresh) => mergeStates(device.did, fresh.states))
              .catch(() => {})
          }
        },
        [call, mergeStates],
      )

      const onDraft = useCallback((key, value) => {
        setDrafts((current) => ({ ...current, [key]: value }))
      }, [])

      // One flight per device: the restore effect re-runs on re-renders, so
      // in-flight and failed markers keep it from double-fetching or retrying
      // a broken device without the user asking.
      const loadingRef = useRef({})
      const failedRef = useRef({})

      const loadDevice = useCallback(
        async (device) => {
          if (loadingRef.current[device.did]) return
          loadingRef.current[device.did] = true
          setError(null)
          const specType = device.spec_type
          try {
            // Spec and state are two independent python runs (~1s each), so
            // they go out together: expanding a device costs one round trip.
            const needSpec = specType && !specsRef.current[specType]
            const needState = !stateLoadedRef.current[device.did]
            if (needState) setBusyKey('state|' + device.did)
            const [spec, stateResult] = await Promise.all([
              needSpec
                ? call('props', { spec_type: specType })
                : Promise.resolve(null),
              needState ? fetchState(device) : Promise.resolve(null),
            ])
            if (spec) setSpecs((current) => ({ ...current, [specType]: spec }))
            void stateResult
            failedRef.current[device.did] = false
          } catch (e) {
            failedRef.current[device.did] = true
            setError(toFailure(e))
          } finally {
            setBusyKey('')
            loadingRef.current[device.did] = false
          }
        },
        [call, fetchState],
      )

      const onToggle = useCallback(
        (device) => {
          const opening = openKey !== device.did
          setOpenKey(opening ? device.did : null)
          if (opening) {
            failedRef.current[device.did] = false
            loadDevice(device)
          }
        },
        [openKey, setOpenKey, loadDevice],
      )

      // A restored expansion (from localStorage) loads its data too.
      const snapDevices = (snap && snap.devices) || []
      useEffect(() => {
        if (!openKey) return
        const device = snapDevices.find((d) => String(d.did) === String(openKey))
        if (!device) return
        if (stateLoadedRef.current[device.did] || loadingRef.current[device.did] || failedRef.current[device.did]) return
        loadDevice(device)
      }, [openKey, snapDevices, loadDevice])

      const onRefreshState = useCallback(
        async (device) => {
          setBusyKey('state|' + device.did)
          setError(null)
          try {
            await fetchState(device, { force: true })
          } catch (e) {
            setError(toFailure(e))
          } finally {
            setBusyKey('')
          }
        },
        [fetchState],
      )

      // A cloud read right after a set often returns the stale value, so the
      // requested value is applied optimistically and reconciled afterwards.
      const pendingSetRef = useRef('')

      const reconcileState = useCallback(
        async (device, prop, expected) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 3000 : 2500))
            try {
              const result = await call('state', {
                did: device.did,
                spec_type: device.spec_type,
                refresh: true,
              })
              mergeStates(device.did, result.states)
              const got = result.states && result.states[prop.name]
              if (got === undefined || String(got).toLowerCase() === String(expected).toLowerCase()) {
                return
              }
            } catch (e) {
              return
            }
          }
        },
        [call, mergeStates],
      )

      const onSet = useCallback(
        async (device, prop, value) => {
          const key = stateKey(device.did, prop.name)
          const dedupKey = `${key}|${String(value)}`
          if (pendingSetRef.current === dedupKey) return
          pendingSetRef.current = dedupKey
          setBusyKey(key)
          setError(null)
          try {
            await call('set', { did: device.did, prop_name: prop.name, value: String(value) })
            setStates((current) => ({ ...current, [key]: String(value) }))
            setDrafts((current) => ({ ...current, [key]: '' }))
            reconcileState(device, prop, String(value))
          } catch (e) {
            setError(toFailure(e))
          } finally {
            pendingSetRef.current = ''
            setBusyKey('')
          }
        },
        [call, reconcileState],
      )

      const onAction = useCallback(
        async (device, actionName) => {
          setBusyKey('action|' + actionName)
          setError(null)
          try {
            await call('action', { did: device.did, action_name: actionName })
          } catch (e) {
            setError(toFailure(e))
          } finally {
            setBusyKey('')
          }
        },
        [call],
      )

      const onScene = useCallback(
        async (scene) => {
          setBusyKey('scene|' + scene)
          setError(null)
          try {
            await call('run_scene', { scene })
          } catch (e) {
            setError(toFailure(e))
          } finally {
            setBusyKey('')
          }
        },
        [call],
      )

      const setHiddenDids = useCallback(
        async (dids) => {
          setError(null)
          try {
            const res = await call('setHidden', { dids })
            setSnap((current) => (current ? { ...current, hiddenDids: res.hiddenDids } : current))
            setOpenKey((key) => (dids.includes(String(key)) ? null : key))
          } catch (e) {
            setError(toFailure(e))
          }
        },
        [call],
      )

      const onHide = useCallback(
        (device) => {
          const current = ((snap && snap.hiddenDids) || []).map(String)
          if (current.includes(String(device.did))) return
          setHiddenDids([...current, String(device.did)])
        },
        [snap, setHiddenDids],
      )

      const onRestore = useCallback(
        (device) => {
          const current = ((snap && snap.hiddenDids) || []).map(String)
          setHiddenDids(current.filter((did) => did !== String(device.did)))
        },
        [snap, setHiddenDids],
      )

      const devices = (snap && snap.devices) || []
      const scenes = (snap && snap.scenes) || []
      const hiddenIdSet = new Set(((snap && snap.hiddenDids) || []).map(String))
      const visibleDevices = devices.filter((device) => !hiddenIdSet.has(String(device.did)))
      const hiddenDevices = devices.filter((device) => hiddenIdSet.has(String(device.did)))

      return h(
        'div',
        { className: 'dsh-mijia-root' },
        h(
          'div',
          { className: 'dsh-mijia-toolbar' },
          h('div', { className: 'dsh-mijia-title' }, tr('panelName')),
          snap &&
            h(
              'div',
              { className: 'dsh-mijia-meta' },
              `${tr('updated')} ${String(snap.ts).replace('T', ' ').slice(0, 19)}`,
            ),
          h(
            'button',
            { className: 'dsh-mijia-btn', onClick: refresh, disabled: loading },
            loading ? tr('refreshing') : tr('refresh'),
          ),
        ),
        error && h(ErrorGuide, { error, onRetry: refresh, busy: loading }),
        !snap && !error && h('div', { className: 'dsh-mijia-loading' }, loading ? tr('refreshing') : '…'),
        scenes.length > 0 &&
          h(
            'div',
            null,
            h('div', { className: 'dsh-mijia-sectionTitle' }, tr('scenesTitle')),
            h(
              'div',
              { className: 'dsh-mijia-scenes' },
              scenes.map((scene) =>
                h(
                  'button',
                  {
                    key: scene.id || scene.name,
                    className: 'dsh-mijia-chip',
                    disabled: busyKey === 'scene|' + (scene.id || scene.name),
                    onClick: () => onScene(scene.id || scene.name),
                  },
                  scene.name,
                ),
              ),
            ),
          ),
        h('div', { className: 'dsh-mijia-sectionTitle' }, tr('devicesTitle')),
        visibleDevices.length === 0 && snap && h('div', { className: 'dsh-mijia-loading' }, tr('noDevices')),
        h(
          'div',
          { className: 'dsh-mijia-grid' },
          visibleDevices.map((device) =>
            h(DeviceCard, {
              key: device.did,
              device,
              open: openKey === device.did,
              spec: device.spec_type ? specs[device.spec_type] : EMPTY_SPEC,
              states,
              stateLoaded: stateLoaded[device.did] === true,
              busyKey,
              drafts,
              onToggle,
              onRefreshState,
              onHide,
              onSet,
              onDraft,
              onAction,
            }),
          ),
        ),
        hiddenDevices.length > 0 &&
          h(
            'div',
            null,
            h('div', { className: 'dsh-mijia-sectionTitle' }, `${tr('hiddenTitle')} (${hiddenDevices.length})`),
            h(
              'div',
              { className: 'dsh-mijia-scenes' },
              hiddenDevices.map((device) =>
                h(
                  'button',
                  {
                    key: device.did,
                    className: 'dsh-mijia-chip',
                    title: tr('hiddenTitle'),
                    onClick: () => onRestore(device),
                  },
                  '↩ ' + device.name,
                ),
              ),
            ),
          ),
      )
    }

    // ------------------------------------------------------------- wiring --

    const inject = ['connection', 'slots']

    function apply(ctx) {
      ctx.effect(() => {
        const element = document.createElement('style')
        element.setAttribute('data-plugin', 'dsh-mijia-sidebar')
        element.textContent = CSS
        document.head.appendChild(element)
        return () => element.remove()
      }, 'mijia-sidebar: styles')

      const connection = ctx.get('connection')
      // rpc.call resolves to the server's result envelope: {ok:true, value} or
      // {ok:false, error{code,message,details}} — it does not throw on ok:false.
      // The code has to be carried across by hand, or the panel cannot tell a
      // missing interpreter from a device that refused a command.
      const call = async (action, payload) => {
        let res
        try {
          res = await connection.rpc.call('/mijia', action, payload || {})
        } catch (e) {
          throw toFailure(e)
        }
        if (!res || typeof res !== 'object' || res.ok !== true) {
          throw toFailure(res && res.error, 'mijia RPC 调用失败')
        }
        if (res.value === undefined && res.data !== undefined) {
          throw toFailure(null, '宿主半区仍是旧版本：请重启 DSH 后再试')
        }
        return res.value
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'mijia-control',
            order: 40,
            label: () => tr('panelName'),
          },
          PanelIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'mijia-control',
            inject: () => ({ call }),
          },
          MijiaPanel,
        ),
      )
    }

    return { apply, inject }
  },
})
