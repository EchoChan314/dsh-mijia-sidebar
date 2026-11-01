// Wire-contract tests for the host half.
//
// The handler's return value IS the RPC result envelope:
//   { ok: true, value } | { ok: false, error: { code, message, details } }
// A fake ctx captures the registered handler, so every assertion below is about
// what the browser would see. No plugin host, no cloud, no credentials: the
// interpreter is pinned to a path that cannot exist, so nothing can ever run
// `python -m mijiaAPI` against a real account.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHANNEL = '/mijia'
// Not a real interpreter on any platform — the first candidate always fails.
const MISSING_PYTHON = '/nonexistent/mijia-python'

// Set before lib/index.js is loaded: the interpreter chain is built per call,
// but a module-level read would also see these.
process.env.MIJIA_PYTHON = MISSING_PYTHON

// The config file and the rotating log live under $DSH_HOME; never touch ~/.dsh.
const scratch = await mkdtemp(join(tmpdir(), 'mijia-wire-'))
process.env.DSH_HOME = join(scratch, 'home')
await mkdir(process.env.DSH_HOME, { recursive: true })

const { apply } = await import('../lib/index.js')

const CONFIG_FILE = join(process.env.DSH_HOME, 'mijia-sidebar.config.json')

function loadHandler() {
  let handler = null
  const ctx = {
    connection: {
      register(owner, channel, registered) {
        assert.equal(channel, CHANNEL, 'the panel talks to /mijia')
        assert.equal(typeof registered, 'function')
        handler = registered
      },
    },
    webServer: {},
  }
  apply(ctx)
  assert.equal(typeof handler, 'function', 'apply(ctx) must register an RPC handler')
  return handler
}

const handler = loadHandler()
const rpc = (action, payload) => handler(action, payload || {}, undefined)

/** A plain object with a string code — the only failure shape the browser parses. */
function assertFailureEnvelope(result, label) {
  assert.equal(result.ok, false, `${label}: ok must be false`)
  assert.equal(typeof result.error, 'object', `${label}: error must be an object`)
  assert.ok(result.error, `${label}: error must not be null`)
  assert.equal(typeof result.error.code, 'string', `${label}: error.code must be a string`)
  assert.ok(result.error.code.length > 0, `${label}: error.code must not be empty`)
  assert.equal(typeof result.error.message, 'string', `${label}: error.message must be a string`)
  assert.ok(result.error.message.length > 0, `${label}: error.message must not be empty`)
  assert.equal(
    Object.prototype.toString.call(result.error.details),
    '[object Object]',
    `${label}: error.details must be a plain object`,
  )
  assert.ok(!('value' in result), `${label}: a failure must not carry a value`)
}

after(async () => {
  // The host half appends its log without awaiting (logging must never block a
  // command), so that write can still be in flight here: removing the tree then
  // fails with ENOTEMPTY. Retry briefly instead of racing it.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(scratch, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 20 || (error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY')) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})

test('envelope: success is {ok:true, value} and nothing else', async () => {
  const result = await rpc('setHidden', { dids: ['111'] })
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'value'])
  assert.deepEqual(result.value.hiddenDids, ['111'])
})

test('envelope: an unknown action fails with a code instead of throwing', async () => {
  const result = await rpc('no-such-action', {})
  assertFailureEnvelope(result, 'unknown action')
  assert.match(result.error.code, /^mijia\//)
  assert.match(result.error.message, /unknown action/)
})

test('envelope: missing required input is rejected before any interpreter runs', async () => {
  // These paths must not spawn: they are validated first, which is what keeps
  // this file offline even on a machine with a working python + credentials.
  const cases = [
    ['props', {}, /spec_type/],
    ['state', {}, /did/],
    ['get', {}, /prop_name/],
    ['set', {}, /prop_name/],
    ['action', {}, /action_name/],
    ['run_scene', {}, /scene/],
  ]
  for (const [action, payload, hint] of cases) {
    const result = await rpc(action, payload)
    assertFailureEnvelope(result, action)
    assert.match(result.error.code, /^mijia\//)
    assert.match(result.error.message, hint, `${action}: the message must say what is missing`)
  }
})

test('setHidden: hiddenDids are persisted without disturbing other config', async () => {
  await writeFile(
    CONFIG_FILE,
    JSON.stringify({ hiddenDids: ['old'], aliases: { 'dmaker.fan.p5': '客厅风扇' } }, null, 2) + '\n',
    'utf8',
  )

  const result = await rpc('setHidden', { dids: ['123', 456] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.hiddenDids, ['123', '456'], 'dids are normalised to strings')

  const written = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
  assert.deepEqual(written.hiddenDids, ['123', '456'])
  assert.deepEqual(written.aliases, { 'dmaker.fan.p5': '客厅风扇' }, 'aliases must survive the write')
})

test('setHidden: an emptied list round-trips and a non-array degrades to []', async () => {
  assert.deepEqual((await rpc('setHidden', { dids: ['1', '2'] })).value.hiddenDids, ['1', '2'])
  assert.deepEqual((await rpc('setHidden', { dids: [] })).value.hiddenDids, [])
  assert.deepEqual(JSON.parse(await readFile(CONFIG_FILE, 'utf8')).hiddenDids, [])

  const degraded = await rpc('setHidden', { dids: 'not-an-array' })
  assert.equal(degraded.ok, true)
  assert.deepEqual(degraded.value.hiddenDids, [])
})

/**
 * Run with an environment in which no interpreter can be started:
 *   - PATH points at an empty directory, so python3/python are unresolvable;
 *   - the platform is faked as linux, because Windows resolves `py` outside
 *     PATH (the system directory) and could otherwise start a real python.
 * Both are restored afterwards, even when the assertion throws.
 */
async function withNoInterpreter(run) {
  const emptyPath = await mkdtemp(join(tmpdir(), 'mijia-empty-path-'))
  const saved = {
    PATH: process.env.PATH,
    MIJIA_PYTHON: process.env.MIJIA_PYTHON,
    DSH_HOME: process.env.DSH_HOME,
  }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    process.env.PATH = emptyPath
    process.env.MIJIA_PYTHON = MISSING_PYTHON
    process.env.DSH_HOME = join(scratch, 'home-no-python')
    await mkdir(process.env.DSH_HOME, { recursive: true })
    Object.defineProperty(process, 'platform', { value: 'linux' })
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', platform)
    process.env.PATH = saved.PATH
    process.env.MIJIA_PYTHON = saved.MIJIA_PYTHON
    process.env.DSH_HOME = saved.DSH_HOME
    await rm(emptyPath, { recursive: true, force: true })
  }
}

/** False when the environment refuses pipe-backed child processes (see below). */
function canSpawnWithPipes() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    } catch (error) {
      resolve(!(error && error.code === 'EPERM'))
      return
    }
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.on('error', (error) => finish(!(error && error.code === 'EPERM')))
    child.on('close', () => finish(true))
  })
}

const pipesBlocked = !(await canSpawnWithPipes())

test('no interpreter: snapshot fails through the envelope, never with a raw crash', async () => {
  const result = await withNoInterpreter(() => rpc('snapshot', {}))
  assertFailureEnvelope(result, 'snapshot')
  assert.ok(!result.error.message.includes('Traceback'), 'a traceback is not a user message')
})

test(
  'no interpreter: the failure is mijia/python-missing with details.tried',
  {
    skip: pipesBlocked
      ? 'this sandbox refuses pipe-backed child processes (spawn EPERM), so no candidate can reach ENOENT — CI runs this assertion for real'
      : false,
  },
  async () => {
    const result = await withNoInterpreter(() => rpc('snapshot', {}))
    assertFailureEnvelope(result, 'snapshot')
    assert.equal(result.error.code, 'mijia/python-missing')
    assert.ok(Array.isArray(result.error.details.tried), 'details.tried must be an array')
    assert.ok(result.error.details.tried.length > 0, 'details.tried must not be empty')
    assert.ok(
      result.error.details.tried.includes(MISSING_PYTHON),
      'details.tried must name the MIJIA_PYTHON override that was tried',
    )
    assert.ok(result.error.details.tried.includes('python3'), 'the posix chain must be walked as well')
  },
)

test('cached snapshot: paints from the disk cache without waiting for python', async () => {
  // The panel is opened far more often than the device list changes, so a
  // cached answer must come back immediately and be marked `stale`, letting the
  // browser refresh afterwards instead of staring at an empty panel.
  const home = join(scratch, 'home-cached')
  await mkdir(home, { recursive: true })
  await writeFile(
    join(home, 'mijia-sidebar.snapshot.json'),
    JSON.stringify({
      devices: [{ did: '42', name: '客厅风扇', model: 'dmaker.fan.p5', spec_type: 'urn:test', online: true }],
      hiddenDids: [],
      scenes: [],
      ts: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  )

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const started = Date.now()
    const result = await rpc('snapshot', {})
    const elapsed = Date.now() - started

    assert.equal(result.ok, true, 'a cached snapshot must not fail even with no interpreter')
    assert.equal(result.value.stale, true, 'the cached answer must be marked stale')
    assert.equal(result.value.devices.length, 1)
    assert.equal(result.value.devices[0].name, '客厅风扇')
    assert.ok(elapsed < 500, `the cached answer must not wait for python (took ${elapsed}ms)`)

    // {refresh: true} is the deliberate slow path: it must really run python.
    const refreshed = await withNoInterpreter(() => {
      process.env.DSH_HOME = home
      return rpc('snapshot', { refresh: true })
    })
    assertFailureEnvelope(refreshed, 'refresh')
  } finally {
    process.env.DSH_HOME = savedHome
  }
})

test('cached spec and state: the controls paint without python', async () => {
  // Expanding a device is the slowest interaction in the panel, so both halves
  // of it are cached on disk. This runs with no interpreter reachable at all:
  // anything that still answers came from the cache.
  const specType = 'urn:test:fan'
  const result = await withNoInterpreter(async () => {
    await writeFile(
      join(process.env.DSH_HOME, 'mijia-sidebar.cache.json'),
      JSON.stringify({
        specs: {
          [specType]: {
            ts: Date.now(),
            value: { properties: [{ name: 'on', method: { siid: 2, piid: 1 } }], actions: [] },
          },
        },
        states: { 42: { ts: Date.now(), states: { on: true, mode: 1 } } },
      }),
      'utf8',
    )

    const specStarted = Date.now()
    const spec = await rpc('props', { spec_type: specType })
    const specMs = Date.now() - specStarted

    const stateStarted = Date.now()
    const states = await rpc('state', { did: '42', spec_type: specType })
    const stateMs = Date.now() - stateStarted

    // A device never seen before must still go to python — and fail loudly
    // here, because this environment has no interpreter.
    const uncached = await rpc('state', { did: 'never-seen', spec_type: specType })

    // An explicit refresh is the deliberate slow path.
    const refreshed = await rpc('state', { did: '42', refresh: true })

    return { spec, specMs, states, stateMs, uncached, refreshed }
  })

  assert.equal(result.spec.ok, true, 'a cached spec must not need python')
  assert.equal(result.spec.value.properties.length, 1)
  assert.ok(result.specMs < 500, `cached spec must be instant (took ${result.specMs}ms)`)

  assert.equal(result.states.ok, true, 'a cached state must not need python')
  assert.equal(result.states.value.stale, true, 'a cached state must be marked stale')
  assert.deepEqual(result.states.value.states, { on: true, mode: 1 })
  assert.ok(result.stateMs < 500, `cached state must be instant (took ${result.stateMs}ms)`)

  assertFailureEnvelope(result.uncached, 'uncached state')
  assertFailureEnvelope(result.refreshed, 'state refresh')
})