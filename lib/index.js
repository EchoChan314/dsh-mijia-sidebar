// dsh-mijia-sidebar — host half.
//
// One RPC channel (/mijia) serves the sidebar panel. Each action shells out
// to `python -m mijiaAPI` — the same CLI, and the same stored credentials
// (~/.config/mijia-api/auth.json), that the mijia MCP server uses — so the
// panel controls devices without any model round-trip.
//
// Actions:
//   snapshot   devices + manual scenes + hiddenDids (cached briefly)
//   props      one device's spec (zh descriptions), by spec_type
//   state      ALL readable properties of one device in one cloud call
//   get        read one property
//   set        write one property (the CLI coerces the string value)
//   action     run one device action
//   run_scene  run one manual scene by id or name
//   setHidden  persist the hidden-device list ($DSH_HOME/mijia-sidebar.config.json)
//
// The CLI prints human-readable text for listing/get; spec and batched state
// go through lib/state.py so the browser only sees plain data. Property and
// enum descriptions are translated to Chinese by the helper's curated map
// (mijiaAPI and miot-spec both serve English only).

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { classifyError, parseGetValue, parseScenes, pythonCandidates } from './parse.js'

export const name = 'dsh-mijia-sidebar'
// The RPC channel mounts through the host webServer, so this fiber must
// inject webServer as well (same wiring as dsh-balance-monitor).
export const inject = ['connection', 'webServer']

// mijiaAPI lives in whichever Python the user has: there is no portable
// absolute path, so the interpreter is probed at call time (see
// pythonCandidates) and the winner is cached for the rest of the process.
// MIJIA_PYTHON still wins when the user sets it.
let cachedPython = null
const STATE_SCRIPT = fileURLToPath(new URL('./state.py', import.meta.url))
const TIMEOUT_MS = 30_000
const LIST_CACHE_MS = 5_000
const SPEC_CACHE_MS = 300_000

const CONFIG_FILE = 'mijia-sidebar.config.json'
const LOG_FILE = 'mijia-sidebar.log'
// One rotated generation: the live log stays under this, the backup under
// twice it — enough history for debugging without an unbounded file.
const LOG_MAX_BYTES = 1024 * 1024

function configPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), CONFIG_FILE)
}

async function readConfig() {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8'))
    return {
      hiddenDids: Array.isArray(raw && raw.hiddenDids) ? raw.hiddenDids.map(String) : [],
      aliases: raw && raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {},
    }
  } catch {
    return { hiddenDids: [], aliases: {} }
  }
}

/** Every mutating call lands here, one line each — evidence for repeated commands. */
async function appendLog(line) {
  const path = join(process.env.DSH_HOME || join(homedir(), '.dsh'), LOG_FILE)
  try {
    // Rotate before appending, so one write can only overshoot by a single line.
    const info = await stat(path)
    if (info.size >= LOG_MAX_BYTES) await rename(path, path + '.1')
  } catch {
    // stat: nothing to rotate yet. rename: the backup is locked or gone —
    // appending anyway beats losing the line, and logging must never break control.
  }
  try {
    await appendFile(path, line + '\n', 'utf8')
  } catch {
    // logging must never break control
  }
}

/** Envelope-shaped failure; the register handler reads code and details off it. */
function failure(code, message, details) {
  return Object.assign(new Error(message), { code, details: details || {} })
}

/** state.py's credential default, mirrored so a failure can still name the file. */
function authFilePath() {
  return join(homedir(), '.config', 'mijia-api', 'auth.json')
}

/**
 * Spawn one candidate. Not being able to start it is not a command failure:
 * the chain has to walk on, so every start problem is reported as one
 * `startFailed` error. ENOENT (`error` event) is the ordinary "not installed"
 * case; Windows also throws synchronously with EPERM for a command it cannot
 * resolve, which never emits an event at all.
 */
function runCandidate(candidate, args, signal) {
  if (signal && signal.aborted) return Promise.reject(failure('mijia/error', 'cancelled'))
  const startFailed = (error) =>
    Object.assign(new Error(`failed to start ${candidate.name}: ${error.message}`), {
      startFailed: true,
    })
  let child
  try {
    child = spawn(candidate.command, [...candidate.args, ...args], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    })
  } catch (error) {
    return Promise.reject(startFailed(error))
  }
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, Object.assign(new Error('timeout'), { timedOut: true }))
    }, TIMEOUT_MS)
    const onAbort = () => {
      child.kill()
      finish(reject, failure('mijia/error', 'cancelled'))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(reject, startFailed(error)))
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (code === 0) return finish(resolve, { stdout, stderr })
      // The interpreter exists but the CLI failed — classify it, and report
      // the raw tail only through details.detail, never as the user message.
      finish(
        reject,
        Object.assign(new Error('mijiaAPI failed'), {
          exited: true,
          text: stderr || stdout,
        }),
      )
    })
  })
}

/** Probe the candidate chain until one interpreter starts; cache the winner. */
async function spawnPython(args, signal) {
  const tried = []
  let cause = ''
  // A cached winner goes first; if it has since vanished, the full chain runs
  // again so an uninstalled interpreter does not brick the panel.
  const chain = cachedPython
    ? [cachedPython, ...pythonCandidates({ env: process.env, platform: process.platform })]
    : pythonCandidates({ env: process.env, platform: process.platform })
  for (const candidate of chain) {
    if (tried.includes(candidate.name)) continue
    tried.push(candidate.name)
    try {
      const result = await runCandidate(candidate, args, signal)
      cachedPython = candidate
      return result
    } catch (error) {
      if (error && error.startFailed) {
        if (cachedPython === candidate) cachedPython = null
        // Keep the reason for anything that is not the ordinary "not
        // installed" case, so the report can name EPERM/EACCES too.
        if (!/ENOENT/i.test(error.message)) cause = error.message
        continue
      }
      if (error && error.timedOut) {
        cachedPython = candidate
        throw failure(
          'mijia/timeout',
          `米家云端 ${TIMEOUT_MS / 1000} 秒未返回，请检查网络后重试`,
          { tried },
        )
      }
      if (error && error.exited) {
        cachedPython = candidate
        const classified = classifyError(error.text, { tried, authPath: authFilePath() })
        throw failure(classified.code, classified.message, classified.details)
      }
      throw error
    }
  }
  // Every candidate failed to start — that is exactly an exhausted chain.
  const classified = classifyError('spawn ENOENT: no such file or directory', { tried })
  if (cause) classified.details.cause = cause
  throw failure(classified.code, classified.message, classified.details)
}

const runCli = (args, signal) => spawnPython(['-m', 'mijiaAPI', ...args], signal)

function targetArgs(input) {
  return input.did !== undefined && input.did !== ''
    ? ['--did', String(input.did)]
    : ['--dev_name', String(input.dev_name || '')]
}

export function apply(ctx) {
  let listCache = null
  const specCache = new Map()

  async function snapshot(signal) {
    const now = Date.now()
    if (listCache && now - listCache.ts < LIST_CACHE_MS) return listCache.value
    const [listResult, scenesResult] = await Promise.allSettled([
      spawnPython([STATE_SCRIPT, '--mode', 'list'], signal),
      runCli(['--list_scenes'], signal),
    ])
    if (listResult.status === 'rejected') throw listResult.reason
    const config = await readConfig()
    const value = {
      devices: JSON.parse(listResult.value.stdout).devices.map((device) => ({
        ...device,
        alias: config.aliases[device.model] || null,
      })),
      hiddenDids: config.hiddenDids,
      scenes: scenesResult.status === 'fulfilled' ? parseScenes(scenesResult.value.stdout) : [],
      ts: new Date().toISOString(),
    }
    listCache = { ts: now, value }
    return value
  }

  async function props(input, signal) {
    const specType = String(input.spec_type || '')
    if (!specType) throw new Error('props 需要 spec_type（先 snapshot 获取）')
    const hit = specCache.get(specType)
    if (hit && Date.now() - hit.ts < SPEC_CACHE_MS) return hit.value
    const { stdout } = await spawnPython(
      [STATE_SCRIPT, '--mode', 'spec', '--spec_type', specType],
      signal,
    )
    const value = JSON.parse(stdout)
    specCache.set(specType, { ts: Date.now(), value })
    return value
  }

  /** One spawn, one cloud call: every readable property of the device. */
  async function state(input, signal) {
    if (!input.did) throw new Error('state 需要 did')
    const { stdout } = await spawnPython([STATE_SCRIPT, '--did', String(input.did)], signal)
    return JSON.parse(stdout)
  }

  async function get(input, signal) {
    if (!input.prop_name) throw new Error('get 需要 prop_name')
    const { stdout } = await runCli(
      ['get', ...targetArgs(input), '--prop_name', String(input.prop_name)],
      signal,
    )
    return { value: parseGetValue(stdout) }
  }

  async function set(input, signal) {
    if (!input.prop_name) throw new Error('set 需要 prop_name')
    const { stdout } = await runCli(
      ['set', ...targetArgs(input), '--prop_name', String(input.prop_name), '--value', String(input.value)],
      signal,
    )
    appendLog(
      `${new Date().toISOString()} set did=${input.did} prop=${input.prop_name} value=${input.value}`,
    )
    return { output: stdout.trim() }
  }

  async function action(input, signal) {
    if (!input.action_name) throw new Error('action 需要 action_name')
    const args = ['action', ...targetArgs(input), '--action_name', String(input.action_name)]
    if (input.params !== undefined && input.params !== null) {
      args.push('--params', JSON.stringify(input.params))
    }
    const { stdout } = await runCli(args, signal)
    appendLog(`${new Date().toISOString()} action did=${input.did} action=${input.action_name}`)
    return { output: stdout.trim() }
  }

  async function runScene(input, signal) {
    const scene = String(input.scene || '')
    if (!scene) throw new Error('run_scene 需要 scene（id 或名称）')
    const { stdout } = await runCli(['--run_scene', scene], signal)
    return { output: stdout.trim() }
  }

  async function setHidden(input) {
    const dids = Array.isArray(input.dids) ? input.dids.map(String) : []
    const config = await readConfig()
    await writeFile(
      configPath(),
      JSON.stringify({ ...config, hiddenDids: dids }, null, 2) + '\n',
      'utf8',
    )
    return { hiddenDids: dids }
  }

  // The parameter must not be named `action`: that would shadow the device
  // action handler below, and every 'action' request would throw.
  async function handle(actionName, payload, signal) {
    const input = payload || {}
    switch (String(actionName || input.action || 'snapshot')) {
      case 'snapshot':
        return snapshot(signal)
      case 'props':
        return props(input, signal)
      case 'state':
        return state(input, signal)
      case 'get':
        return get(input, signal)
      case 'set':
        listCache = null
        return set(input, signal)
      case 'action':
        listCache = null
        return action(input, signal)
      case 'run_scene':
        listCache = null
        return runScene(input, signal)
      case 'setHidden':
        return setHidden(input)
      default:
        throw new Error(`unknown action: ${actionName}`)
    }
  }

  // The handler's return value IS the RPC result envelope: the connection
  // layer sends it verbatim and the browser reads result.value, so success
  // must be { ok: true, value } and failure { ok: false, error{code,message,details} }.
  ctx.connection.register(ctx, '/mijia', async (action, payload, signal) => {
    try {
      return { ok: true, value: await handle(action, payload, signal) }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: (error && error.code) || 'mijia/error',
          message: (error && error.message) || String(error),
          details: (error && error.details) || {},
        },
      }
    }
  })
}
