"""Offline unit tests for the python helper (lib/state.py).

The helper imports two third-party packages (requests, mijiaAPI), neither of
which is installed on a bare interpreter or on CI. Both are stubbed in
sys.modules *before* the helper is loaded, so these tests need nothing but the
standard library and never touch the network or a real account.

Run from the repository root:
    python -m unittest discover -s tests -p "*_test.py"
or from inside tests/:
    python -m unittest state_test
"""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import uuid
from unittest import mock

TESTS_DIR = pathlib.Path(__file__).resolve().parent
LIB_DIR = TESTS_DIR.parent / "lib"
STATE_PY = LIB_DIR / "state.py"
STUB_MODULES = TESTS_DIR / "fixtures" / "stubs"


class _Unused:
    """Stands in for clients that would need a real account to exist."""

    def __init__(self, *args, **kwargs):
        raise AssertionError("tests must not build a live mijiaAPI client")


def _module(name, **attributes):
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


def _install_stubs():
    """Fake the two third-party imports the helper does at module scope."""
    requests = _module("requests", RequestException=type("RequestException", (Exception,), {}))

    def refuse(*args, **kwargs):
        raise requests.RequestException("network access is disabled in tests")

    requests.get = refuse
    sys.modules["requests"] = requests

    devices = _module("mijiaAPI.devices", mijiaDevice=_Unused)
    devices.get_device_info = refuse
    apis = _module("mijiaAPI.apis", mijiaAPI=_Unused, mijiaDevice=_Unused)
    package = _module(
        "mijiaAPI",
        mijiaAPI=_Unused,
        mijiaDevice=_Unused,
        _Unused=_Unused,
        devices=devices,
        apis=apis,
    )
    package.__path__ = []  # mark it as a package so submodule imports resolve
    sys.modules["mijiaAPI"] = package
    sys.modules["mijiaAPI.devices"] = devices
    sys.modules["mijiaAPI.apis"] = apis


def _load_state_module():
    _install_stubs()
    spec = importlib.util.spec_from_file_location("mijia_state_under_test", STATE_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STATE = _load_state_module()


class ZhDescriptionTests(unittest.TestCase):
    def test_curated_property_descriptions_are_translated(self):
        self.assertEqual(STATE.zh_desc("Switch"), "开关")
        self.assertEqual(STATE.zh_desc("Brightness"), "亮度")
        self.assertEqual(STATE.zh_desc("Color Temperature"), "色温")

    def test_unlisted_property_descriptions_pass_through(self):
        self.assertEqual(STATE.zh_desc("Some Vendor Field"), "Some Vendor Field")
        self.assertIsNone(STATE.zh_desc(None))

    def test_level_values_become_gear_counts(self):
        self.assertEqual(STATE.zh_value_desc("Level 3"), "3 档")
        self.assertEqual(STATE.zh_value_desc("Level 12"), "12 档")
        self.assertEqual(STATE.zh_value_desc("Level 0"), "0 档")

    def test_curated_enum_values_are_translated(self):
        self.assertEqual(STATE.zh_value_desc("On"), "开")
        self.assertEqual(STATE.zh_value_desc("Off"), "关")
        self.assertEqual(STATE.zh_value_desc("Auto"), "自动")

    def test_unlisted_enum_values_pass_through(self):
        self.assertEqual(STATE.zh_value_desc("Vendor State"), "Vendor State")
        self.assertEqual(STATE.zh_value_desc("Level"), "Level")  # no number, no rewrite
        self.assertIsNone(STATE.zh_value_desc(None))


class SpecLangKeyTests(unittest.TestCase):
    """Keys must match miot-spec's multiLanguage layout exactly."""

    def test_service_only(self):
        self.assertEqual(STATE.spec_lang_key(2), "service:002")

    def test_property(self):
        self.assertEqual(STATE.spec_lang_key(2, piid=1), "service:002:property:001")

    def test_property_value(self):
        self.assertEqual(
            STATE.spec_lang_key(2, piid=1, viid=0),
            "service:002:property:001:valuelist:000",
        )

    def test_action(self):
        self.assertEqual(STATE.spec_lang_key(2, aiid=5), "service:002:action:005")


class ApplyTranslationsTests(unittest.TestCase):
    def _info(self):
        return {
            "properties": [
                {
                    "method": {"siid": 2, "piid": 1},
                    "description": "Switch",
                    "value-list": [{"description": "On"}, {"description": "Level 3"}],
                },
                {
                    "method": {"siid": 2, "piid": 2},
                    "description": "Vendor Field",
                    "value-list": [],
                },
            ],
            "actions": [{"method": {"siid": 2, "aiid": 1}, "description": "Alarm"}],
        }

    def test_official_translations_win_and_the_curated_map_fills_the_rest(self):
        langs = {
            "zh_cn": {
                "service:002:property:001": "电源开关",
                "service:002:property:001:valuelist:000": "通电",
            }
        }
        info = STATE.apply_translations(self._info(), langs)

        first, second = info["properties"]
        self.assertEqual(first["description"], "电源开关")
        self.assertEqual([item["description"] for item in first["value-list"]], ["通电", "3 档"])
        # No official entry and no curated entry: the vendor text stays as is.
        self.assertEqual(second["description"], "Vendor Field")
        # Actions fall back to the curated map.
        self.assertEqual(info["actions"][0]["description"], "提示音")

    def test_without_zh_cn_everything_falls_back_to_the_curated_map(self):
        info = STATE.apply_translations(self._info(), {})
        self.assertEqual(info["properties"][0]["description"], "开关")
        self.assertEqual(
            [item["description"] for item in info["properties"][0]["value-list"]],
            ["开", "3 档"],
        )

    def test_the_same_object_is_returned(self):
        info = self._info()
        self.assertIs(STATE.apply_translations(info, {}), info)


class CanonicalPropsTests(unittest.TestCase):
    def test_underscore_aliases_are_dropped_when_the_dash_name_exists(self):
        device = types.SimpleNamespace(
            prop_list={
                "on": "value",
                "on_1": "alias",
                "on-1": "canonical",
                "mode": "value",
            }
        )
        self.assertEqual(set(STATE.canonical_props(device)), {"on", "on-1", "mode"})


class FailContractTests(unittest.TestCase):
    """The host half branches on exit codes, not on tracebacks."""

    def test_exit_codes_are_distinct_per_code(self):
        self.assertEqual(STATE.EXIT_BY_CODE["auth-missing"], 3)
        self.assertEqual(STATE.EXIT_BY_CODE["auth-expired"], 4)
        self.assertEqual(STATE.EXIT_BY_CODE["dependency-missing"], 5)

    def test_fail_prints_one_json_line_on_stderr_and_exits(self):
        buffer = io.StringIO()
        with contextlib.redirect_stderr(buffer), self.assertRaises(SystemExit) as caught:
            STATE.fail("auth-missing", "没有凭证", auth_path="/tmp/auth.json")

        self.assertEqual(caught.exception.code, 3)
        lines = [line for line in buffer.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, "stderr must carry exactly one line")
        payload = json.loads(lines[0])
        self.assertEqual(payload["code"], "auth-missing")
        self.assertEqual(payload["message"], "没有凭证")
        self.assertEqual(payload["auth_path"], "/tmp/auth.json")


class HelperProcessTests(unittest.TestCase):
    """End-to-end: the helper as the host half spawns it."""

    def setUp(self):
        self.workdir = pathlib.Path(tempfile.gettempdir()) / ("mijia-state-" + uuid.uuid4().hex)
        os.makedirs(self.workdir)

    def tearDown(self):
        shutil.rmtree(self.workdir, ignore_errors=True)

    def run_helper(self, *args):
        """Run the helper with stub modules on PYTHONPATH, stdio into files.

        Files rather than pipes keep this runnable inside restrictive sandboxes.
        """
        stdout_path = self.workdir / "stdout.txt"
        stderr_path = self.workdir / "stderr.txt"
        env = dict(os.environ)
        env.update(
            PYTHONPATH=str(STUB_MODULES),
            PYTHONUTF8="1",
            PYTHONIOENCODING="utf-8",
            # Keep the stub package from leaving __pycache__ inside fixtures/.
            PYTHONDONTWRITEBYTECODE="1",
        )
        with stdout_path.open("w", encoding="utf-8") as out, stderr_path.open(
            "w", encoding="utf-8"
        ) as err:
            completed = subprocess.run(
                [sys.executable, str(STATE_PY), *args],
                stdout=out,
                stderr=err,
                env=env,
                timeout=120,
                check=False,
            )
        return (
            completed.returncode,
            stdout_path.read_text(encoding="utf-8"),
            stderr_path.read_text(encoding="utf-8"),
        )

    def test_missing_credentials_exit_3_with_one_json_line_on_stderr(self):
        auth_path = self.workdir / "auth.json"  # deliberately never created

        code, stdout, stderr = self.run_helper(
            "--auth_path", str(auth_path), "--mode", "list"
        )

        self.assertEqual(code, 3, f"stderr was: {stderr!r}")
        self.assertEqual(stdout.strip(), "", "stdout is reserved for the JSON document")
        lines = [line for line in stderr.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, f"expected one stderr line, got: {stderr!r}")
        payload = json.loads(lines[0])
        self.assertEqual(payload["code"], "auth-missing")
        self.assertEqual(payload["auth_path"], str(auth_path))
        self.assertIn("mijiaAPI login", payload["message"])

    def test_expired_credentials_exit_4(self):
        auth_path = self.workdir / "auth.json"
        auth_path.write_text("{}", encoding="utf-8")

        class Expired(Exception):
            status_code = 401

        buffer = io.StringIO()
        with mock.patch.object(STATE, "mijiaAPI", side_effect=Expired("401 Unauthorized")), mock.patch.object(
            sys, "argv", ["state.py", "--mode", "list", "--auth_path", str(auth_path)]
        ), contextlib.redirect_stderr(buffer), self.assertRaises(SystemExit) as caught:
            STATE.main()

        self.assertEqual(caught.exception.code, 4)
        payload = json.loads(buffer.getvalue().strip())
        self.assertEqual(payload["code"], "auth-expired")
        self.assertEqual(payload["auth_path"], str(auth_path))


class DeviceListPrivacyTests(unittest.TestCase):
    """The list mode must down-select: tokens and LAN addresses never reach the browser."""

    def test_list_mode_emits_exactly_the_six_documented_fields(self):
        class FakeApi:
            def get_devices_list(self):
                return [
                    {
                        "did": "123456",
                        "name": "客厅风扇",
                        "model": "dmaker.fan.p5",
                        "spec_type": "urn:miot-spec-v2:device:fan:0000A005:dmaker-p5:1",
                        "isOnline": True,
                        "icon": None,
                        "token": "SECRET-TOKEN",
                        "localip": "10.0.0.9",
                    }
                ]

        buffer = io.StringIO()
        with mock.patch.object(STATE, "mijiaAPI", lambda auth_path: FakeApi()), contextlib.redirect_stdout(
            buffer
        ):
            STATE.mode_list("/tmp/auth.json")

        raw = buffer.getvalue()
        self.assertNotIn("SECRET-TOKEN", raw)
        self.assertNotIn("10.0.0.9", raw)
        device = json.loads(raw)["devices"][0]
        self.assertEqual(
            set(device),
            {"did", "name", "model", "spec_type", "online", "icon"},
        )
        self.assertEqual(device["did"], "123456")
        self.assertTrue(device["online"])


if __name__ == "__main__":
    unittest.main()