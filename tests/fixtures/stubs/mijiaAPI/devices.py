"""Stub `mijiaAPI.devices` — the helper imports get_device_info/DevProp from here."""

from mijiaAPI import _Unused

mijiaDevice = _Unused


class DevProp:
    """Mirrors the real wrapper: the helper only reads `rw` and `method`."""

    def __init__(self, prop_dict):
        self.name = prop_dict["name"]
        self.desc = prop_dict.get("description")
        self.type = prop_dict.get("type", "bool")
        self.rw = prop_dict.get("rw", "r")
        self.range = prop_dict.get("range")
        self.value_list = prop_dict.get("value-list")
        self.method = prop_dict["method"]


def get_device_info(spec_type, cache_path=None):
    raise AssertionError("tests must not fetch a device spec from the cloud")
