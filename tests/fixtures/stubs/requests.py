"""Stub for `requests` — the helper only needs the exception type and `.get`.

Placed on PYTHONPATH by tests/state_test.py so lib/state.py can be imported and
run as a subprocess without the real package (CI has neither requests nor
mijiaAPI installed).
"""


class RequestException(Exception):
    """Same name lib/state.py catches; never raised towards the cloud."""


def get(*args, **kwargs):
    raise RequestException("network access is disabled in tests")