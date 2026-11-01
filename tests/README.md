# Tests

Offline, credential-free tests for both halves of the plugin. Nothing here
needs `mijiaAPI`, `requests`, a Mijia account or a network connection.

| File | What it covers | Runner |
| --- | --- | --- |
| `parse.test.js` | `lib/parse.js` as pure functions: interpreter chain order, the error taxonomy, `--list_scenes` / `get` text parsing | `node:test` |
| `wire.test.js` | The RPC envelope contract of `lib/index.js` through a fake plugin context, `setHidden` persistence, and the `mijia/python-missing` classification | `node:test` |
| `state_test.py` | `lib/state.py` pure helpers (zh descriptions, multiLanguage keys, translation merge), the `stderr` JSON + exit-code contract, and the six-field device-list privacy rule | `unittest` |
| `fixtures/stubs/` | Stand-ins for `requests` and `mijiaAPI`, put on `PYTHONPATH` when the helper is run as a subprocess | — |

```bash
node --test                        # no path argument: the runner finds **/*.test.js
python -m unittest discover -s tests -p "*_test.py"
```

`node --test` is deliberately called without a path: a bare directory argument
(`node --test tests/`) is not expanded by every supported Node version — Node 22
tries to load the directory as a module and fails with `Cannot find module
.../tests`.

Both commands are what `.github/workflows/ci.yml` runs on `ubuntu-latest`
(Node 22 + Python 3.11).

## Running locally on Windows inside a restricted sandbox

Some sandboxes (the DSH `workspace-write` one, for instance) deny *pipe-backed*
child processes: `spawn` fails with `EPERM` and `subprocess` with
`WinError 5` even for a known-good executable. Two consequences, neither of
which means the tests are broken:

1. `node --test` spawns one child per test file and cannot start; use the
   single-process form instead: `node --test --test-isolation=none`
2. The `no interpreter: the failure is mijia/python-missing` case is reported
   as **skipped**, with the reason printed on the skip line. It requires real
   `ENOENT` failures, which a pipe-denying sandbox turns into `EPERM`. CI runs
   it for real (empty `PATH`, no `py -3` candidate, spawn available).

Tests never reach the cloud even where spawning works: `wire.test.js` pins
`MIJIA_PYTHON` to a path that cannot exist and empties `PATH` before any action
that would run python, and `state_test.py` stubs the two third-party imports.
The snapshot *success* path (devices + scenes + `hiddenDids` assembled in one
value) is therefore not covered — it needs a working interpreter and a live
account, which is exactly what these tests refuse to require.