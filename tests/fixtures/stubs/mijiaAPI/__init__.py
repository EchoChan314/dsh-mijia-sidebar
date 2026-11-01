"""Stub `mijiaAPI` package — enough surface for lib/state.py to import.

Creating a client would need a real account, so the class refuses to be built:
any test that reaches the cloud is a test bug, not a test failure.
"""


class _Unused:
    def __init__(self, *args, **kwargs):
        raise AssertionError("tests must not build a live mijiaAPI client")


mijiaAPI = _Unused
mijiaDevice = _Unused