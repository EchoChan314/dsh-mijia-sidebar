// dsh-mijia-sidebar — pure helpers for the host half.
//
// Deliberately free of Node APIs (no spawn, no fs, no module state) so the
// interpreter chain, the failure taxonomy and the CLI text parsers can be
// unit-tested without booting the plugin host. index.js owns every side
// effect; this file only maps input to output.

/** The six codes the RPC envelope is allowed to carry. */
const CODES = {
  'python-missing': 'mijia/python-missing',
  'dependency-missing': 'mijia/dependency-missing',
  'auth-missing': 'mijia/auth-missing',
  'auth-expired': 'mijia/auth-expired',
  timeout: 'mijia/timeout',
  error: 'mijia/error',
}

/** Accepts a bare name ('auth-missing') or an already-prefixed code. */
const codeOf = (name) => CODES[String(name || '').replace(/^mijia\//, '')] || CODES.error

// Lines that carry no information on their own: a traceback's frame markers.
const NOISE = /^(traceback\b|during handling of the above|the above exception|file "|\^+$)/

/** Collapse a multi-line dump to one bounded line — raw stderr is never a message. */
function shortLine(text, limit) {
  const max = limit || 160
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  // A traceback's frames are noise; the last meaningful line is the real error.
  const meaningful = rows.filter((row) => !NOISE.test(row.toLowerCase()))
  const picked = meaningful.length ? meaningful[meaningful.length - 1] : rows[rows.length - 1] || ''
  const line = picked.replace(/\s+/g, ' ')
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/**
 * Build the ordered interpreter chain. A candidate carries its own argv
 * prefix because the Windows launcher needs `-3`, and because the name is
 * what a failure reports in details.tried.
 *
 * @param {{env?: Record<string, string|undefined>, platform?: string}} [input]
 * @returns {Array<{name: string, command: string, args: string[]}>}
 */
export function pythonCandidates(input) {
  const options = input || {}
  const env = options.env || {}
  const platform = options.platform || process.platform
  const override = String(env.MIJIA_PYTHON || '').trim()
  const candidates = []
  // An explicit override still falls through: a moved interpreter should not
  // brick the panel when a working one is one candidate away.
  if (override) candidates.push({ name: override, command: override, args: [] })
  candidates.push({ name: 'python3', command: 'python3', args: [] })
  candidates.push({ name: 'python', command: 'python', args: [] })
  // `py` exists on Windows even when the interpreter itself is not on PATH;
  // -3 pins the Python 3 series so `py` never picks up a Python 2 install.
  if (platform === 'win32') candidates.push({ name: 'py -3', command: 'py', args: ['-3'] })
  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = candidate.command + '\u0000' + candidate.args.join('\u0000')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** state.py prints exactly one JSON line on stderr when it fails itself. */
function structuredFailure(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string' && parsed.code) {
      return parsed
    }
  }
  return null
}

/** Actionable text per code — a user must be able to copy the next command out of it. */
function messageFor(code, details) {
  const tried = Array.isArray(details.tried) && details.tried.length ? details.tried.join('、') : '无'
  switch (code) {
    case CODES['python-missing']:
      return (
        `没有找到可用的 Python 解释器（已尝试：${tried}）。请安装 Python 3.10 或更新版本，` +
        '确认 python3/python 在 PATH 中；或用环境变量 MIJIA_PYTHON 指向解释器的完整路径。'
      )
    case CODES['dependency-missing']:
      return '当前 Python 缺少 mijiaAPI 依赖，请运行：python -m pip install mijiaAPI'
    case CODES['auth-missing']:
      return '还没有米家登录凭证，请运行：python -m mijiaAPI login，再用米家 APP 扫码'
    case CODES['auth-expired']:
      return '米家登录已过期，请重新运行：python -m mijiaAPI login 扫码登录'
    case CODES.timeout:
      return '调用米家云 30 秒未返回，请检查网络后重试'
    default:
      return details.detail ? `米家调用失败：${details.detail}` : '米家调用失败，请查看 ~/.dsh/mijia-sidebar.log'
  }
}

/**
 * Turn a failed run into the envelope's error body.
 *
 * state.py's single JSON stderr line wins; free text is only a fallback for
 * paths that never reached the helper (interpreter missing, network failure).
 *
 * @param {string} text stderr of the failed run (or stdout when stderr is empty)
 * @param {{tried?: string[], authPath?: string, auth_path?: string, stdout?: string}} [extra]
 * @returns {{code: string, message: string, details: Record<string, unknown>}}
 */
export function classifyError(text, extra) {
  const options = extra || {}
  const raw = [text === undefined || text === null ? '' : String(text), String(options.stdout || '')]
    .filter(Boolean)
    .join('\n')
  const lower = raw.toLowerCase()
  const tried = Array.isArray(options.tried) ? options.tried.map(String) : []
  const authPath = String(options.authPath || options.auth_path || '')
  const structured = structuredFailure(raw)
  const details = {}

  let code
  if (structured) {
    code = codeOf(structured.code)
    for (const key of ['auth_path', 'authPath', 'module', 'detail']) {
      if (structured[key] !== undefined && structured[key] !== null) details[key] = structured[key]
    }
    if (Array.isArray(structured.tried)) details.tried = structured.tried.map(String)
  } else if (lower.includes('no module named')) {
    code = CODES['dependency-missing']
  } else if (/401|unauthorized|access[ _-]?token|登录|not logged in|invalid token/.test(lower)) {
    code = CODES['auth-expired']
  } else if (/no such file or directory|enoent|not found|不是内部或外部命令/.test(lower)) {
    code = CODES['python-missing']
  } else if (/timed out|timeout/.test(lower)) {
    code = CODES.timeout
  } else {
    code = CODES.error
  }

  if (tried.length && !Array.isArray(details.tried)) details.tried = tried
  if (authPath && !details.auth_path) details.auth_path = authPath
  // Keep one bounded line for debugging when nothing structured arrived.
  if (code === CODES.error) details.detail = shortLine(raw)

  const own = structured && typeof structured.message === 'string' ? structured.message.trim() : ''
  return { code, message: own || messageFor(code, details), details }
}

/** Parse `--list_scenes` output; format is loose, so keep it forgiving. */
export function parseScenes(text) {
  const scenes = []
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue
    const bullet = raw.match(/^\s*-\s+(.+?)\s*$/)
    if (bullet && raw.trimStart().startsWith('-')) {
      current = { name: bullet[1], id: bullet[1] }
      scenes.push(current)
      continue
    }
    const field = raw.match(/^\s*([A-Za-z_]+):\s*(.+?)\s*$/)
    if (field && current) current[field[1]] = field[2]
  }
  return scenes
}

/** Parse a `get` answer: "<name> (<did>) 的 <prop> 值为 <value>". */
export function parseGetValue(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const joined = lines.join('\n')
  const match = joined.match(/值为\s*(.+?)\s*$/) || joined.match(/value is\s*(.+?)\s*$/i)
  if (match) return match[1]
  return lines.length ? lines[lines.length - 1] : ''
}
