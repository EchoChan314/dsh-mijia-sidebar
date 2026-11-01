// Pure-function tests for lib/parse.js.
//
// Everything here is I/O free: the interpreter chain, the failure taxonomy and
// the CLI text parsers are plain input → output, so these assertions describe
// the contract the host half (lib/index.js) relies on.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyError, parseGetValue, parseScenes, pythonCandidates } from '../lib/parse.js'

const namesOf = (input) => pythonCandidates(input).map((candidate) => candidate.name)

test('pythonCandidates: posix chain is python3 then python', () => {
  assert.deepEqual(namesOf({ env: {}, platform: 'linux' }), ['python3', 'python'])
  // macOS has no `py` launcher either — every non-win32 platform behaves the same.
  assert.deepEqual(namesOf({ env: {}, platform: 'darwin' }), ['python3', 'python'])
})

test('pythonCandidates: win32 appends the launcher pinned to -3', () => {
  const candidates = pythonCandidates({ env: {}, platform: 'win32' })
  assert.deepEqual(candidates.map((candidate) => candidate.name), ['python3', 'python', 'py -3'])
  const launcher = candidates[2]
  assert.equal(launcher.command, 'py')
  assert.deepEqual(launcher.args, ['-3'])
})

test('pythonCandidates: every entry is {name, command, args}', () => {
  for (const candidate of pythonCandidates({ env: {}, platform: 'win32' })) {
    assert.equal(typeof candidate.name, 'string')
    assert.ok(candidate.name.length > 0)
    assert.equal(typeof candidate.command, 'string')
    assert.ok(candidate.command.length > 0)
    assert.ok(Array.isArray(candidate.args))
  }
})

test('pythonCandidates: MIJIA_PYTHON wins but does not replace the chain', () => {
  const override = '/opt/python3.12/bin/python3'
  assert.deepEqual(namesOf({ env: { MIJIA_PYTHON: override }, platform: 'linux' }), [
    override,
    'python3',
    'python',
  ])
  assert.deepEqual(namesOf({ env: { MIJIA_PYTHON: override }, platform: 'win32' }), [
    override,
    'python3',
    'python',
    'py -3',
  ])
})

test('pythonCandidates: blank MIJIA_PYTHON is ignored', () => {
  assert.deepEqual(namesOf({ env: { MIJIA_PYTHON: '' }, platform: 'linux' }), ['python3', 'python'])
  assert.deepEqual(namesOf({ env: { MIJIA_PYTHON: '   ' }, platform: 'linux' }), ['python3', 'python'])
})

test('pythonCandidates: an override equal to a fallback is not tried twice', () => {
  assert.deepEqual(namesOf({ env: { MIJIA_PYTHON: 'python3' }, platform: 'linux' }), ['python3', 'python'])
  assert.deepEqual(namesOf({ env: { MIJIA_PYTHON: 'python' }, platform: 'linux' }), ['python', 'python3'])
})

test('pythonCandidates: defaults read the live env and platform', () => {
  const saved = process.env.MIJIA_PYTHON
  delete process.env.MIJIA_PYTHON
  try {
    const candidates = pythonCandidates()
    assert.ok(candidates.length >= 2)
    assert.equal(candidates[0].command, 'python3')
  } finally {
    if (saved !== undefined) process.env.MIJIA_PYTHON = saved
  }
})

test('classifyError: the helper’s single JSON stderr line wins', () => {
  const text = [
    'Traceback (most recent call last):',
    '  File "/x/lib/state.py", line 1, in <module>',
    '{"code": "auth-expired", "message": "米家登录已过期", "auth_path": "/home/u/.config/mijia-api/auth.json"}',
  ].join('\n')
  const result = classifyError(text)
  assert.equal(result.code, 'mijia/auth-expired')
  assert.equal(result.message, '米家登录已过期')
  assert.equal(result.details.auth_path, '/home/u/.config/mijia-api/auth.json')
})

test('classifyError: codes are always prefixed with mijia/', () => {
  assert.equal(classifyError('{"code":"dependency-missing"}').code, 'mijia/dependency-missing')
  assert.equal(classifyError('{"code":"auth-missing"}').code, 'mijia/auth-missing')
  assert.equal(classifyError('{"code":"mijia/auth-expired"}').code, 'mijia/auth-expired')
  assert.equal(classifyError('{"code":"who-knows"}').code, 'mijia/error')
})

test('classifyError: free text falls back to keywords', () => {
  assert.equal(
    classifyError("ModuleNotFoundError: No module named 'mijiaAPI'").code,
    'mijia/dependency-missing',
  )
  assert.equal(classifyError('HTTP 401 Unauthorized').code, 'mijia/auth-expired')
  assert.equal(classifyError('unauthorized: access token rejected').code, 'mijia/auth-expired')
  assert.equal(
    classifyError('failed to start mijiaAPI (python3): spawn python3 ENOENT').code,
    'mijia/python-missing',
  )
  assert.equal(classifyError('bash: py: 不是内部或外部命令').code, 'mijia/python-missing')
  assert.equal(classifyError('mijiaAPI timed out after 30000ms').code, 'mijia/timeout')
  assert.equal(classifyError('something odd happened').code, 'mijia/error')
})

test('classifyError: an unparsable brace line does not shadow the keywords', () => {
  assert.equal(classifyError('{oops} no such file or directory').code, 'mijia/python-missing')
})

test('classifyError: details carry the tried candidates and the auth path', () => {
  const missing = classifyError('spawn python3 ENOENT', { tried: ['python3', 'python'] })
  assert.equal(missing.code, 'mijia/python-missing')
  assert.deepEqual(missing.details.tried, ['python3', 'python'])
  // The user-facing message must say what to do, and name what was tried.
  assert.match(missing.message, /Python/)
  assert.match(missing.message, /python3/)

  const snake = classifyError('401', { auth_path: '/home/u/auth.json' })
  assert.equal(snake.code, 'mijia/auth-expired')
  assert.equal(snake.details.auth_path, '/home/u/auth.json')
  const camel = classifyError('401', { authPath: '/home/u/auth.json' })
  assert.equal(camel.details.auth_path, '/home/u/auth.json')
})

test('classifyError: dependency-missing tells the user how to install', () => {
  const result = classifyError("No module named 'mijiaAPI'")
  assert.equal(result.code, 'mijia/dependency-missing')
  assert.match(result.message, /mijiaAPI/)
})

test('classifyError: unknown failures keep one bounded raw line in details', () => {
  const result = classifyError('line one\nline two\n' + 'x'.repeat(400))
  assert.equal(result.code, 'mijia/error')
  assert.equal(typeof result.details.detail, 'string')
  assert.ok(result.details.detail.length <= 160, 'details.detail must stay bounded')
  assert.ok(!result.details.detail.includes('\n'), 'details.detail is collapsed to one line')
})

test('classifyError: stdout is searched when stderr is empty', () => {
  assert.equal(classifyError('', { stdout: '{"code":"auth-missing"}' }).code, 'mijia/auth-missing')
})

test('parseScenes: bullets with id fields become scene objects', () => {
  const text = ['- 看电影', '  id: 1001', '- 回家', '  id: 1002', ''].join('\n')
  assert.deepEqual(parseScenes(text), [
    { name: '看电影', id: '1001' },
    { name: '回家', id: '1002' },
  ])
})

test('parseScenes: indentation is tolerated and ids fall back to the name', () => {
  const text = ['  - 早安模式', '', '  - 晚安模式', '  id: 2002'].join('\n')
  assert.deepEqual(parseScenes(text), [
    { name: '早安模式', id: '早安模式' },
    { name: '晚安模式', id: '2002' },
  ])
})

test('parseScenes: empty output and stray fields produce nothing', () => {
  assert.deepEqual(parseScenes(''), [])
  assert.deepEqual(parseScenes('id: 42\nno bullets here'), [])
})

test('parseGetValue: the Chinese CLI sentence is unwrapped', () => {
  assert.equal(parseGetValue('客厅风扇 (123456) 的 on-2 值为 true'), 'true')
  assert.equal(parseGetValue('客厅风扇 (123456) 的 brightness 值为 60\n'), '60')
})

test('parseGetValue: the English sentence is a fallback', () => {
  assert.equal(parseGetValue('Living room fan (123456) value is 42'), '42')
})

test('parseGetValue: unrecognised output keeps its last non-empty line', () => {
  assert.equal(parseGetValue('noise\nthe answer\n\n'), 'the answer')
  assert.equal(parseGetValue(''), '')
})